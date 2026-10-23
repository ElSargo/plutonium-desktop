// Desktop apps: the freedesktop.org desktop entries (*.desktop) a launcher
// offers, their icons, and the command line that starts one.
//
// Entries come from $XDG_DATA_HOME and $XDG_DATA_DIRS (earlier directories
// win for the same desktop file id). Hidden, NoDisplay and desktop-specific
// (OnlyShowIn) entries, and ones whose TryExec isn't installed, are left out.
// Icons are looked up by name in the icon themes under the same directories
// (PLUTONIUM_ICON_THEME first, then breeze, hicolor and Adwaita), or taken
// as an absolute path.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, extname, isAbsolute, join, relative } from "node:path";

import { findExecutable } from "./threads.ts";

export interface DesktopApp {
  /** Desktop file id, e.g. "org.kde.dolphin.desktop". */
  readonly id: string;
  readonly name: string;
  readonly genericName: string;
  readonly comment: string;
  readonly keywords: readonly string[];
  readonly categories: readonly string[];
  /** Whether the helper has an icon for it (GET /v1/apps/<id>/icon). */
  readonly hasIcon: boolean;
  /** Runs in a terminal. */
  readonly terminal: boolean;
}

interface Entry extends DesktopApp {
  readonly exec: string;
  readonly icon: string;
  readonly path: string;
  readonly workingDirectory: string;
  /** The data directory it's in ($XDG_DATA_HOME or one of $XDG_DATA_DIRS). */
  readonly dataDir: string;
}

/** Where an installed app comes from. */
export type AppSource = "flatpak" | "nix profile" | "system" | "user";

/** An app that matched find_apps' filter, and how launch_app starts it. */
export interface FoundApp {
  readonly name: string;
  readonly genericName?: string;
  /** Desktop file id. */
  readonly id: string;
  /** For launch_app (argv[0] is looked up on PATH). */
  readonly argv: readonly string[];
  /** The working directory the app asks for, if any. */
  readonly cwd?: string;
  readonly source: AppSource;
  /** Its desktop file, which tells two installs of one app apart. */
  readonly desktopFile: string;
}

export interface FoundApps {
  readonly apps: readonly FoundApp[];
  /** Programs on PATH whose names match (only with a filter); mostly command-line ones. */
  readonly onPath?: readonly string[];
  /** How many more programs on PATH matched than are listed. */
  readonly moreOnPath?: number;
}

// At most this many programs on PATH are listed.
const MAX_PATH_PROGRAMS = 20;

// The list is re-read at most this often.
const MAX_AGE_MS = 30_000;
const ICON_EXTENSIONS = [".svg", ".png"];
const ICON_CONTENT_TYPES: Record<string, string> = { ".svg": "image/svg+xml", ".png": "image/png" };

function dataDirs(): string[] {
  const home = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const dirs = (process.env.XDG_DATA_DIRS || "")
    .split(":")
    .filter(Boolean);
  if (dirs.length === 0) {
    const user = process.env.USER ?? "";
    dirs.push(
      join(homedir(), ".nix-profile", "share"),
      `/etc/profiles/per-user/${user}/share`,
      "/run/current-system/sw/share",
      "/var/lib/flatpak/exports/share",
      "/usr/local/share",
      "/usr/share",
    );
  }
  return [...new Set([home, ...dirs])];
}

// Desktop entry values: \s \n \t \r \\ escapes.
function unescapeValue(value: string): string {
  return value.replace(/\\([sntr\\;])/g, (_, c: string) =>
    c === "s" ? " " : c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c,
  );
}

function localeKeys(key: string): string[] {
  const lang = (process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "").split(".")[0] ?? "";
  const [language] = lang.split("_");
  const keys = [];
  if (lang && lang !== "C" && lang !== "POSIX") keys.push(`${key}[${lang}]`);
  if (language && language !== lang) keys.push(`${key}[${language}]`);
  keys.push(key);
  return keys;
}

/** The [Desktop Entry] group's keys. */
function parseDesktopEntry(text: string): Map<string, string> {
  const values = new Map<string, string>();
  let inMain = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      inMain = line === "[Desktop Entry]";
      continue;
    }
    if (!inMain) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!values.has(key)) values.set(key, line.slice(eq + 1).trim());
  }
  return values;
}

function localized(values: Map<string, string>, key: string): string {
  for (const candidate of localeKeys(key)) {
    const value = values.get(candidate);
    if (value !== undefined) return unescapeValue(value);
  }
  return "";
}

const list = (value: string | undefined) =>
  (value ?? "")
    .split(";")
    .map((item) => unescapeValue(item).trim())
    .filter(Boolean);

function isExecutable(program: string): boolean {
  if (isAbsolute(program)) {
    try {
      return statSync(program).isFile();
    } catch {
      return false;
    }
  }
  return findExecutable(program) !== undefined;
}

/**
 * Splits an Exec value into arguments: double-quoted arguments may contain
 * spaces and the escapes \" \` \$ \\ (after the value's own escapes).
 */
export function splitExec(exec: string): string[] {
  const args: string[] = [];
  let current = "";
  let started = false;
  let quoted = false;
  for (let i = 0; i < exec.length; i++) {
    const c = exec[i]!;
    if (quoted) {
      if (c === "\\" && i + 1 < exec.length && '"`$\\'.includes(exec[i + 1]!)) {
        current += exec[++i];
      } else if (c === '"') {
        quoted = false;
      } else {
        current += c;
      }
    } else if (c === '"') {
      quoted = true;
      started = true;
    } else if (c === " " || c === "\t") {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += c;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

/** The command line for `entry`, with no files or URLs to open. */
export function expandExec(entry: {
  readonly exec: string;
  readonly name: string;
  readonly icon: string;
  readonly path: string;
}): string[] {
  const argv: string[] = [];
  for (const arg of splitExec(entry.exec)) {
    // Field codes that stand alone expand to nothing (%f %u …), or to
    // several arguments (%i).
    if (/^%[fFuUdDnNvm]$/.test(arg)) continue;
    if (arg === "%i") {
      if (entry.icon) argv.push("--icon", entry.icon);
      continue;
    }
    argv.push(
      arg.replace(/%(.)/g, (_, code: string) =>
        code === "%" ? "%" : code === "c" ? entry.name : code === "k" ? entry.path : "",
      ),
    );
  }
  // Flatpak's file-forwarding markers (@@u … @@) with nothing between them.
  for (let i = 0; i + 1 < argv.length; i++) {
    if ((argv[i] === "@@u" || argv[i] === "@@") && argv[i + 1] === "@@") argv.splice(i--, 2);
  }
  return argv;
}

// Terminals to run Terminal=true apps in, with how each takes a command.
const TERMINALS: ReadonlyArray<[string, readonly string[]]> = [
  ["foot", []],
  ["kitty", []],
  ["alacritty", ["-e"]],
  ["wezterm", ["start", "--"]],
  ["konsole", ["-e"]],
  ["gnome-terminal", ["--"]],
  ["xterm", ["-e"]],
];

function terminalCommand(argv: string[]): string[] {
  const preferred = process.env.TERMINAL;
  if (preferred && isExecutable(preferred)) {
    const known = TERMINALS.find(([name]) => name === basename(preferred));
    return [preferred, ...(known ? known[1] : ["-e"]), ...argv];
  }
  for (const [name, prefix] of TERMINALS) {
    if (findExecutable(name)) return [name, ...prefix, ...argv];
  }
  throw new Error("No terminal found to run it in (install foot, or set TERMINAL).");
}

class IconIndex {
  // name → [path, score]; higher scores are better.
  private readonly icons = new Map<string, [string, number]>();

  constructor(dirs: readonly string[]) {
    const preferred = process.env.PLUTONIUM_ICON_THEME;
    const themes = [...new Set([preferred, "breeze", "hicolor", "Adwaita"].filter(Boolean) as string[])];
    // Earlier themes and directories win; within one, the best size.
    const rank = (theme: string) => {
      const i = themes.indexOf(theme);
      return i < 0 ? themes.length : i;
    };
    for (const dir of dirs) {
      const root = join(dir, "icons");
      let names: string[];
      try {
        names = readdirSync(root);
      } catch {
        continue;
      }
      for (const theme of names) {
        this.addTheme(join(root, theme), (themes.length + 1 - rank(theme)) * 100_000);
      }
    }
    for (const dir of dirs) this.addDir(join(dir, "pixmaps"), 1);
  }

  private addTheme(themeDir: string, base: number): void {
    // hicolor style: <size>/apps/<name>; breeze style: apps/<size>/<name>.
    let sizes: string[];
    try {
      sizes = readdirSync(themeDir);
    } catch {
      return;
    }
    for (const size of sizes) {
      if (size === "apps") {
        let inner: string[] = [];
        try {
          inner = readdirSync(join(themeDir, "apps"));
        } catch {
          continue;
        }
        for (const s of inner) this.addDir(join(themeDir, "apps", s), base + sizeScore(s));
      } else {
        this.addDir(join(themeDir, size, "apps"), base + sizeScore(size));
      }
    }
  }

  private addDir(dir: string, score: number): void {
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      return;
    }
    for (const file of files) {
      const extension = extname(file);
      if (!ICON_EXTENSIONS.includes(extension)) continue;
      const name = file.slice(0, -extension.length);
      const current = this.icons.get(name);
      const fileScore = score + (extension === ".svg" ? 1 : 0);
      if (!current || current[1] < fileScore) this.icons.set(name, [join(dir, file), fileScore]);
    }
  }

  find(icon: string): string | undefined {
    if (!icon) return undefined;
    if (isAbsolute(icon)) {
      return ICON_EXTENSIONS.includes(extname(icon)) && existsSync(icon) ? icon : undefined;
    }
    return this.icons.get(icon)?.[0];
  }
}

// Scalable first, then sizes nearest 128 (big enough for HiDPI lists).
function sizeScore(size: string): number {
  if (size.startsWith("scalable") || size === "symbolic") return size === "symbolic" ? 10 : 1000;
  const pixels = Number.parseInt(size, 10);
  if (!Number.isFinite(pixels)) return 0;
  return 900 - Math.min(800, Math.abs(128 - pixels) * 2);
}

export class DesktopApps {
  private entries = new Map<string, Entry>();
  private icons: IconIndex | null = null;
  private loadedAt = 0;

  private load(): void {
    if (Date.now() - this.loadedAt < MAX_AGE_MS) return;
    const dirs = dataDirs();
    const entries = new Map<string, Entry>();
    const seen = new Set<string>();
    for (const dir of dirs) {
      const root = join(dir, "applications");
      for (const path of walk(root)) {
        const id = relative(root, path).split("/").join("-");
        if (seen.has(id)) continue;
        seen.add(id);
        let values: Map<string, string>;
        try {
          values = parseDesktopEntry(readFileSync(path, "utf8"));
        } catch {
          continue;
        }
        if (values.get("Type") !== "Application") continue;
        if (values.get("NoDisplay") === "true" || values.get("Hidden") === "true") continue;
        if (values.has("OnlyShowIn")) continue;
        const exec = values.get("Exec");
        if (!exec) continue;
        const tryExec = values.get("TryExec");
        if (tryExec && !isExecutable(unescapeValue(tryExec))) continue;
        const name = localized(values, "Name");
        if (!name) continue;
        entries.set(id, {
          id,
          name,
          genericName: localized(values, "GenericName"),
          comment: localized(values, "Comment"),
          keywords: list(localized(values, "Keywords")),
          categories: list(values.get("Categories")),
          hasIcon: false,
          terminal: values.get("Terminal") === "true",
          exec: unescapeValue(exec),
          icon: unescapeValue(values.get("Icon") ?? ""),
          path,
          workingDirectory: unescapeValue(values.get("Path") ?? ""),
          dataDir: dir,
        });
      }
    }
    this.icons = new IconIndex(dirs);
    for (const [id, entry] of entries) {
      entries.set(id, { ...entry, hasIcon: this.icons.find(entry.icon) !== undefined });
    }
    this.entries = entries;
    this.loadedAt = Date.now();
  }

  /** Launchable apps, by name. */
  list(): DesktopApp[] {
    this.load();
    return [...this.entries.values()]
      .map(({ id, name, genericName, comment, keywords, categories, hasIcon, terminal }) => ({
        id,
        name,
        genericName,
        comment,
        keywords,
        categories,
        hasIcon,
        terminal,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The icon file for app `id`: its bytes and content type. */
  icon(id: string): { data: Buffer; contentType: string } | undefined {
    this.load();
    const entry = this.entries.get(id);
    const path = entry && this.icons?.find(entry.icon);
    if (!path) return undefined;
    return { data: readFileSync(path), contentType: ICON_CONTENT_TYPES[extname(path)] ?? "application/octet-stream" };
  }

  /**
   * The apps whose name, generic name, keywords, desktop id or Exec match
   * `filter` (a case-insensitive regular expression, else plain text), by
   * name, with how to start each; with a filter, also the matching programs
   * on PATH.
   */
  find(filter?: string): FoundApps {
    this.load();
    const pattern = filterPattern(filter);
    const apps: FoundApp[] = [];
    for (const entry of this.entries.values()) {
      if (pattern && !appMatches(entry, pattern)) continue;
      let command;
      try {
        command = this.command(entry.id);
      } catch {
        // No terminal to run it in: listed as it is.
        command = { argv: expandExec(entry), cwd: entry.workingDirectory || undefined };
      }
      if (!command || command.argv.length === 0) continue;
      apps.push({
        name: entry.name,
        ...(entry.genericName ? { genericName: entry.genericName } : {}),
        id: entry.id,
        argv: command.argv,
        ...(command.cwd ? { cwd: command.cwd } : {}),
        source: appSource(entry),
        desktopFile: entry.path,
      });
    }
    apps.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    if (!pattern) return { apps };
    const programs = pathPrograms(pattern);
    return {
      apps,
      onPath: programs.slice(0, MAX_PATH_PROGRAMS),
      ...(programs.length > MAX_PATH_PROGRAMS ? { moreOnPath: programs.length - MAX_PATH_PROGRAMS } : {}),
    };
  }

  /** How to start app `id`: argv and working directory. */
  command(id: string): { argv: string[]; cwd: string | undefined; name: string } | undefined {
    this.load();
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    const argv = expandExec(entry);
    if (argv.length === 0) return undefined;
    return {
      argv: entry.terminal ? terminalCommand(argv) : argv,
      cwd: entry.workingDirectory || undefined,
      name: entry.name,
    };
  }
}

/** `filter` as a case-insensitive pattern: a regular expression, else the text itself. */
export function filterPattern(filter: string | undefined): RegExp | undefined {
  if (!filter) return undefined;
  try {
    return new RegExp(filter, "i");
  } catch {
    return new RegExp(filter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
}

/** Whether `pattern` matches the app's name, generic name, keywords, desktop id or Exec. */
export function appMatches(
  app: {
    readonly name: string;
    readonly genericName: string;
    readonly keywords: readonly string[];
    readonly id: string;
    readonly exec: string;
  },
  pattern: RegExp,
): boolean {
  return [app.name, app.genericName, ...app.keywords, app.id, app.exec].some((value) => pattern.test(value));
}

function appSource(entry: Entry): AppSource {
  const home = homedir();
  const dir = entry.dataDir;
  if (/(^|\/)flatpak\/exports\//.test(`${dir}/`) || /^flatpak\s+run\s/.test(entry.exec)) return "flatpak";
  const nixProfiles = [
    join(home, ".nix-profile"),
    join(home, ".local", "state", "nix", "profile"),
    `/etc/profiles/per-user/`,
    "/nix/profile",
    "/nix/var/nix/profiles/",
  ];
  if (nixProfiles.some((profile) => dir.startsWith(profile))) return "nix profile";
  if (dir === (process.env.XDG_DATA_HOME || join(home, ".local", "share")) || dir.startsWith(`${home}/`)) return "user";
  return "system";
}

/** The executables on PATH whose names match `pattern`, by name (the first of each name). */
export function pathPrograms(pattern: RegExp): string[] {
  const found = new Set<string>();
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      if (found.has(name) || !pattern.test(name)) continue;
      try {
        const stat = statSync(join(directory, name));
        if (stat.isFile() && (stat.mode & 0o111) !== 0) found.add(name);
      } catch {
        // Dangling link.
      }
    }
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}

function* walk(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    if (name.endsWith(".desktop")) {
      yield path;
      continue;
    }
    try {
      if (statSync(path).isDirectory()) yield* walk(path);
    } catch {
      // Dangling link.
    }
  }
}
