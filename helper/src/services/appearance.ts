// The appearance service (docs/features/APPEARANCE.md): light or dark, one
// setting for the whole desktop. The helper keeps the user's choice and
// hands it to everything that draws:
//
// - the web: Ash's dark mode, so prefers-color-scheme in shells and tabs
//   (the daemon, through the Plutonium DevTools domain);
// - apps through the settings portal: org.freedesktop.appearance
//   color-scheme, which libadwaita, GTK 4, Qt 6 (the threads' xdgdesktopportal
//   platform theme), Firefox, Chromium and Electron apps and Flatpaks follow,
//   live (portal.ts serves what portalSettings() gives);
// - GTK's own settings, when Plutonium is the desktop (`system`): GNOME's
//   dconf keys (color-scheme, and gtk-theme and icon-theme switched to their
//   light or dark variant when one is installed), which GTK 3 follows live,
//   and gtk-application-prefer-dark-theme in GTK's settings.ini, which apps
//   read when they start.
//
// Without a choice, a session that isn't the desktop (in a window on GNOME
// or KDE) follows that desktop's scheme (HostAppearance); the desktop
// session starts from GNOME's dconf key, else dark. With `system`, a change
// of the dconf key by something else (gsettings, another settings app) is
// taken as the user's choice.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import {
  type ColorScheme,
  DCONF_INTERFACE,
  dataDirs,
  dconfColorScheme,
  dconfQuote,
  dconfString,
  HostAppearance,
  iniValue,
  isDarkDconf,
  portalColorScheme,
  setIniValue,
  themeInstalled,
  themeVariant,
} from "../appearance.ts";
import { type Variant } from "../dbus.ts";
import { type DesktopService, ServiceError } from "../services.ts";

const run = promisify(execFile);

export interface AppearanceState {
  readonly available: true;
  readonly colorScheme: ColorScheme;
  /** The user chose it; else it is the host desktop's, or the default. */
  readonly chosen: boolean;
  /** Plutonium is the desktop: GTK's settings (dconf, settings.ini) follow too. */
  readonly system: boolean;
  /** GTK's theme and icon theme for the scheme, when known. */
  readonly gtkTheme: string | null;
  readonly iconTheme: string | null;
}

/** The part of HostAppearance the service uses (a fake in tests). */
export interface HostScheme {
  start(): Promise<void>;
  stop(): void;
  readonly current: boolean | null;
  onChange(listener: (dark: boolean) => void): void;
}

export interface AppearanceOptions {
  /** Where the choice is kept (JSON). */
  readonly file: string;
  /** Whether this session is the desktop: GTK's dconf keys and settings.ini follow. */
  readonly system: boolean;
  /** dconf (default $PLUTONIUM_DCONF, else dconf on PATH). */
  readonly dconf?: string;
  /** GTK's settings.ini folders (default ~/.config/gtk-3.0 and gtk-4.0). */
  readonly gtkConfigDirs?: readonly string[];
  /** Where themes are looked for (default the XDG data dirs). */
  readonly dataDirs?: readonly string[];
  /** The host desktop's scheme, for a session that isn't the desktop (default HostAppearance). */
  readonly host?: HostScheme | null;
  /** How long after a write of ours dconf's echo of it is ignored (default 2 s). */
  readonly ownWriteMs?: number;
}

/** dconf echoes our own writes; changes this soon after one are taken as ours. */
const OWN_WRITE_MS = 2000;

export class AppearanceService implements DesktopService {
  readonly name = "appearance";
  private readonly options: AppearanceOptions;
  private readonly dconf: string;
  private chosen: ColorScheme | null = null;
  /** Where the scheme comes from without a choice: the host's, or the desktop's dconf key. */
  private fallback: ColorScheme | null = null;
  private gtkTheme: string | null = null;
  private iconTheme: string | null = null;
  private host: HostScheme | null = null;
  private watcher: ChildProcess | null = null;
  private lastWrite = 0;
  private changed: ((state: unknown) => void) | null = null;
  private started: Promise<void> | null = null;
  private readonly listeners = new Set<(scheme: ColorScheme) => void>();
  /** Applying the scheme to GTK's settings, one at a time. */
  private applying: Promise<void> = Promise.resolve();

  constructor(options: AppearanceOptions) {
    this.options = options;
    this.dconf = options.dconf ?? process.env.PLUTONIUM_DCONF ?? "dconf";
    this.chosen = this.load();
  }

  /** The scheme now. */
  get colorScheme(): ColorScheme {
    return this.chosen ?? this.fallback ?? "dark";
  }

  /** Calls `listener` with each new scheme (not the first). */
  onChange(listener: (scheme: ColorScheme) => void): void {
    this.listeners.add(listener);
  }

  start(changed: (state: unknown) => void): Promise<void> {
    this.changed = changed;
    this.started ??= this.begin();
    return this.started;
  }

  private async begin(): Promise<void> {
    if (this.options.system) {
      const value = await this.dconfRead("color-scheme");
      if (value !== undefined) this.fallback = isDarkDconf(value) ? "dark" : "light";
      this.watchDconf();
    } else {
      const host = this.options.host === undefined ? new HostAppearance() : this.options.host;
      this.host = host;
      if (host) {
        host.onChange((dark) => {
          const before = this.colorScheme;
          this.fallback = dark ? "dark" : "light";
          if (this.colorScheme !== before) this.publish();
        });
        await host.start().catch(() => {});
        if (host.current !== null) this.fallback = host.current ? "dark" : "light";
      }
    }
    await this.apply();
  }

  stop(): void {
    this.host?.stop();
    this.watcher?.kill();
    this.watcher = null;
  }

  async state(): Promise<AppearanceState> {
    await this.started;
    return this.snapshot();
  }

  private snapshot(): AppearanceState {
    return {
      available: true,
      colorScheme: this.colorScheme,
      chosen: this.chosen !== null,
      system: this.options.system,
      gtkTheme: this.gtkTheme,
      iconTheme: this.iconTheme,
    };
  }

  async call(action: string, args: Record<string, unknown>): Promise<unknown> {
    switch (action) {
      case "set": {
        const scheme = args.colorScheme;
        if (scheme !== "light" && scheme !== "dark" && scheme !== null) {
          throw new ServiceError(400, 'colorScheme is "light", "dark", or null (no choice: the default)');
        }
        await this.choose(scheme);
        return this.state();
      }
      case "toggle":
        await this.choose(this.colorScheme === "dark" ? "light" : "dark");
        return this.state();
    }
    throw new ServiceError(404, `The appearance service has no action "${action}".`);
  }

  /** The settings portal's values (portal.ts): org.freedesktop.appearance. */
  portalSettings(): Map<string, Map<string, Variant>> {
    return new Map([
      [
        "org.freedesktop.appearance",
        new Map<string, Variant>([
          ["color-scheme", ["u", portalColorScheme(this.colorScheme)]],
          ["contrast", ["u", 0]],
        ]),
      ],
    ]);
  }

  private async choose(scheme: ColorScheme | null): Promise<void> {
    await this.start(this.changed ?? (() => {}));
    this.chosen = scheme;
    this.save();
    await this.publish();
  }

  /** Tells everyone, then brings GTK's settings along. */
  private async publish(): Promise<void> {
    const scheme = this.colorScheme;
    for (const listener of this.listeners) listener(scheme);
    await this.apply();
  }

  /** GTK's settings for the scheme (dconf and settings.ini only with `system`), then the new state. */
  private apply(): Promise<void> {
    this.applying = this.applying.then(async () => {
      const scheme = this.colorScheme;
      try {
        await this.applyGtk(scheme);
      } catch (error) {
        console.warn(`plutoniumd: appearance: GTK's settings: ${(error as Error).message}`);
      }
      this.changed?.(this.snapshot());
    });
    return this.applying;
  }

  private async applyGtk(scheme: ColorScheme): Promise<void> {
    const dirs = this.options.dataDirs ?? dataDirs();
    const inis = (this.options.gtkConfigDirs ?? defaultGtkConfigDirs()).map((dir) => join(dir, "settings.ini"));
    const ini = inis.map((path) => ({ path, text: readText(path) }));
    // The themes now: dconf's, else GTK 3's settings.ini.
    const gtkNow = dconfString((await this.dconfRead("gtk-theme")) ?? "") ?? iniValue(ini[0]?.text ?? "", "gtk-theme-name");
    const iconsNow = dconfString((await this.dconfRead("icon-theme")) ?? "") ?? iniValue(ini[0]?.text ?? "", "gtk-icon-theme-name");
    this.gtkTheme = gtkNow ? themeVariant(gtkNow, scheme, (name) => themeInstalled("gtk", name, dirs)) ?? gtkNow : null;
    this.iconTheme = iconsNow ? themeVariant(iconsNow, scheme, (name) => themeInstalled("icons", name, dirs)) ?? iconsNow : null;
    if (!this.options.system) return;
    await this.dconfWrite("color-scheme", `'${dconfColorScheme(scheme)}'`);
    if (this.gtkTheme && this.gtkTheme !== gtkNow) await this.dconfWrite("gtk-theme", dconfQuote(this.gtkTheme));
    if (this.iconTheme && this.iconTheme !== iconsNow) await this.dconfWrite("icon-theme", dconfQuote(this.iconTheme));
    // settings.ini: only the files there are, and not one another tool links in
    // (home-manager's, from the Nix store).
    for (const { path, text } of ini) {
      if (text === undefined || isLink(path)) continue;
      let next = setIniValue(text, "gtk-application-prefer-dark-theme", scheme === "dark" ? "true" : "false");
      if (this.gtkTheme && iniValue(next, "gtk-theme-name") !== undefined) next = setIniValue(next, "gtk-theme-name", this.gtkTheme);
      if (this.iconTheme && iniValue(next, "gtk-icon-theme-name") !== undefined) next = setIniValue(next, "gtk-icon-theme-name", this.iconTheme);
      if (next !== text) writeAtomically(path, next);
    }
  }

  private async dconfRead(key: string): Promise<string | undefined> {
    try {
      const value = (await run(this.dconf, ["read", `${DCONF_INTERFACE}${key}`])).stdout.trim();
      return value || undefined;
    } catch {
      return undefined;
    }
  }

  private async dconfWrite(key: string, value: string): Promise<void> {
    if ((await this.dconfRead(key)) === value) return;
    this.lastWrite = Date.now();
    try {
      await run(this.dconf, ["write", `${DCONF_INTERFACE}${key}`, value]);
    } catch (error) {
      console.warn(`plutoniumd: appearance: dconf write ${key}: ${(error as Error).message}`);
    }
  }

  /** The dconf key changed by something else (gsettings, a settings app): the user's choice. */
  private watchDconf(): void {
    const watcher = spawn(this.dconf, ["watch", DCONF_INTERFACE], { stdio: ["ignore", "pipe", "ignore"] });
    watcher.on("error", () => {});
    let key = "";
    // `dconf watch` prints the key, then its new value, indented.
    createInterface({ input: watcher.stdout! }).on("line", (line) => {
      if (line.startsWith("/")) {
        key = line.trim();
        return;
      }
      if (!line.trim() || key !== `${DCONF_INTERFACE}color-scheme`) return;
      key = "";
      if (Date.now() - this.lastWrite < (this.options.ownWriteMs ?? OWN_WRITE_MS)) return;
      const scheme: ColorScheme = isDarkDconf(line) ? "dark" : "light";
      if (scheme !== this.colorScheme) void this.choose(scheme);
    });
    this.watcher = watcher;
  }

  private load(): ColorScheme | null {
    try {
      const { colorScheme } = JSON.parse(readFileSync(this.options.file, "utf8")) as { colorScheme?: unknown };
      return colorScheme === "light" || colorScheme === "dark" ? colorScheme : null;
    } catch {
      return null;
    }
  }

  private save(): void {
    try {
      writeAtomically(this.options.file, `${JSON.stringify({ colorScheme: this.chosen }, null, 2)}\n`);
    } catch (error) {
      console.warn(`plutoniumd: appearance: couldn't keep the choice: ${(error as Error).message}`);
    }
  }
}

function defaultGtkConfigDirs(): string[] {
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return [join(config, "gtk-3.0"), join(config, "gtk-4.0")];
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function writeAtomically(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  let mode = 0o644;
  try {
    mode = lstatSync(path).mode & 0o777;
  } catch {}
  writeFileSync(temporary, text, { mode });
  renameSync(temporary, path);
}
