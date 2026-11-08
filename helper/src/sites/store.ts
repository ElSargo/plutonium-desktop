// Site extensions (docs/features/SITE_EXTENSIONS.md): the folders in
// $PLUTO_HOME/sites, one per site, each a site.json and its parts (a part is
// <name>.css, <name>.js, or both). This module reads them, matches them to
// URLs, and keeps the folder a git repository with a commit per settled save.
// Applying them to tabs is injector.ts's; the tab's context is context.ts's.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";

export const SITE_MANIFEST = "site.json";
/** Folders in the sites directory that aren't sites. */
const NOT_SITES = new Set(["presets", "node_modules", "site.d.ts"]);
/** Saves within this long of each other are one edit (as for shells). */
const SETTLE_MS = 700;

export type RunAt = "start" | "ready" | "idle";
/** Where a site or part applies: everywhere, or one project's or thread's tabs. */
export type Scope = "global" | { readonly project: string } | { readonly thread: string };

export interface PartSpec {
  readonly title: string;
  readonly enabled: boolean;
  readonly runAt: RunAt;
  readonly allFrames: boolean;
  readonly preset: string | null;
  /** Narrows the site's scope (never widens it). */
  readonly scope: Scope | null;
}

export interface SiteManifest {
  readonly title: string;
  readonly matches: readonly string[];
  readonly excludes: readonly string[];
  readonly scope: Scope;
  readonly parts: Readonly<Record<string, PartSpec>>;
  readonly block: readonly string[];
  readonly hosts: readonly string[];
  readonly reload: boolean;
}

/** A part as the runtime gets it: its code, and a hash that changes with it. */
export interface Part {
  /** "<site>/<part>". */
  readonly id: string;
  readonly site: string;
  readonly name: string;
  readonly spec: PartSpec;
  readonly css: string | null;
  readonly js: string | null;
  readonly hash: string;
}

export interface Site {
  readonly name: string;
  readonly dir: string;
  readonly manifest: SiteManifest;
  readonly parts: readonly Part[];
  /** Why the folder couldn't be read (the site is then left out). */
  readonly error?: string;
}

export class SiteError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const SITE_NAME = /^[a-z0-9][a-z0-9.-]*$/;
const PART_NAME = /^[a-z0-9][a-z0-9_-]*$/;

export function isSiteName(name: string): boolean {
  return SITE_NAME.test(name) && name.length <= 253 && !NOT_SITES.has(name);
}

function strings(value: unknown, what: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new SiteError(`${what} must be a list of strings.`);
  }
  return value as string[];
}

function scopeOf(value: unknown, what: string): Scope | null {
  if (value === undefined || value === null) return null;
  if (value === "global") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const { project, thread } = value as { project?: unknown; thread?: unknown };
    if (typeof project === "string" && project && thread === undefined) return { project };
    if (typeof thread === "string" && thread && project === undefined) return { thread };
  }
  throw new SiteError(`${what} must be "global", { "project": "<id>" } or { "thread": "<id>" }.`);
}

/** The default matches of a site's folder: its host and the host's subdomains. */
export function defaultMatches(name: string): string[] {
  return [`*://${name}/*`, `*://*.${name}/*`];
}

export function parseSiteManifest(text: string, name: string): SiteManifest {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new SiteError(`${SITE_MANIFEST} isn't JSON: ${(error as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SiteError(`${SITE_MANIFEST} must be an object.`);
  const matches = raw.matches === undefined ? defaultMatches(name) : strings(raw.matches, "matches");
  for (const pattern of [...matches, ...strings(raw.excludes, "excludes")]) {
    if (!parseMatchPattern(pattern)) throw new SiteError(`Not a match pattern: ${pattern}`);
  }
  const parts: Record<string, PartSpec> = {};
  const rawParts = raw.parts ?? {};
  if (typeof rawParts !== "object" || Array.isArray(rawParts)) throw new SiteError("parts must be an object.");
  for (const [part, value] of Object.entries(rawParts as Record<string, unknown>)) {
    if (!PART_NAME.test(part)) throw new SiteError(`Not a part name: ${part} (lowercase letters, digits, - and _).`);
    const spec = (value ?? {}) as Record<string, unknown>;
    if (typeof spec !== "object" || Array.isArray(spec)) throw new SiteError(`parts.${part} must be an object.`);
    // A script runs when the document is parsed unless it asks for earlier; a
    // stylesheet always goes in at document start.
    const runAt = spec.runAt ?? "ready";
    if (runAt !== "start" && runAt !== "ready" && runAt !== "idle") {
      throw new SiteError(`parts.${part}.runAt must be "start", "ready" or "idle".`);
    }
    parts[part] = {
      title: typeof spec.title === "string" ? spec.title : part,
      enabled: spec.enabled !== false,
      runAt,
      allFrames: spec.allFrames === true,
      preset: typeof spec.preset === "string" ? spec.preset : null,
      scope: scopeOf(spec.scope, `parts.${part}.scope`),
    };
  }
  return {
    title: typeof raw.title === "string" ? raw.title : name,
    matches,
    excludes: strings(raw.excludes, "excludes"),
    scope: scopeOf(raw.scope, "scope") ?? "global",
    parts,
    block: strings(raw.block, "block"),
    hosts: strings(raw.hosts, "hosts"),
    reload: raw.reload === true,
  };
}

// ---- Chrome's match patterns -------------------------------------------------

interface MatchPattern {
  readonly schemes: readonly string[];
  /** null: any host. */
  readonly host: string | null;
  readonly subdomains: boolean;
  readonly path: RegExp;
}

const patternCache = new Map<string, MatchPattern | null>();

/** Parses a match pattern (`*://*.example.com/*`, `<all_urls>`), or null. */
export function parseMatchPattern(pattern: string): MatchPattern | null {
  if (patternCache.has(pattern)) return patternCache.get(pattern)!;
  let parsed: MatchPattern | null = null;
  if (pattern === "<all_urls>") {
    parsed = { schemes: ["http", "https", "file"], host: null, subdomains: false, path: /^/ };
  } else {
    const match = /^(\*|https?|file|wss?):\/\/([^/]*)(\/.*)$/.exec(pattern);
    if (match) {
      const [, scheme, host, path] = match as unknown as [string, string, string, string];
      const schemes = scheme === "*" ? ["http", "https"] : [scheme];
      let ok = true;
      let hostName: string | null = host;
      let subdomains = false;
      if (host === "*") hostName = null;
      else if (host.startsWith("*.")) {
        subdomains = true;
        hostName = host.slice(2);
      }
      if (hostName !== null && (hostName.includes("*") || (hostName === "" && scheme !== "file"))) ok = false;
      if (ok) {
        const regex = path
          .split("*")
          .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*");
        parsed = { schemes, host: hostName?.toLowerCase() ?? null, subdomains, path: new RegExp(`^${regex}$`) };
      }
    }
  }
  patternCache.set(pattern, parsed);
  return parsed;
}

export function matchesPattern(pattern: string, url: string): boolean {
  const parsed = parseMatchPattern(pattern);
  if (!parsed) return false;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  const scheme = target.protocol.slice(0, -1);
  if (!parsed.schemes.includes(scheme)) return false;
  if (parsed.host !== null) {
    const host = target.hostname.toLowerCase();
    if (host !== parsed.host && !(parsed.subdomains && host.endsWith(`.${parsed.host}`))) return false;
  }
  return parsed.path.test(target.pathname + target.search);
}

export function siteMatches(manifest: SiteManifest, url: string): boolean {
  return (
    manifest.matches.some((pattern) => matchesPattern(pattern, url)) &&
    !manifest.excludes.some((pattern) => matchesPattern(pattern, url))
  );
}

// ---- Reading a site -----------------------------------------------------------

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Reads the site in `dir`. Every <name>.css and <name>.js is a part, listed in
 * site.json or not (one that isn't gets the defaults), so an agent's new file
 * applies without a manifest edit.
 */
export function readSite(dir: string, name: string): Site {
  const manifestText = readOptional(join(dir, SITE_MANIFEST));
  const empty: SiteManifest = parseSiteManifest("{}", name);
  try {
    const manifest = manifestText === null ? empty : parseSiteManifest(manifestText, name);
    const names = new Set(Object.keys(manifest.parts));
    for (const file of readdirSync(dir)) {
      const match = /^([a-z0-9][a-z0-9_-]*)\.(css|js)$/.exec(file);
      if (match) names.add(match[1]!);
    }
    const parts: Part[] = [];
    for (const part of [...names].sort()) {
      const css = readOptional(join(dir, `${part}.css`));
      const js = readOptional(join(dir, `${part}.js`));
      if (css === null && js === null) continue;
      const spec = manifest.parts[part] ?? parseSiteManifest(JSON.stringify({ parts: { [part]: {} } }), name).parts[part]!;
      const hash = createHash("sha256").update(JSON.stringify([spec, css, js])).digest("hex").slice(0, 16);
      parts.push({ id: `${name}/${part}`, site: name, name: part, spec, css, js, hash });
    }
    return { name, dir, manifest, parts };
  } catch (error) {
    return { name, dir, manifest: empty, parts: [], error: (error as Error).message };
  }
}

// ---- The folder -----------------------------------------------------------------

function git(dir: string, args: readonly string[]): string {
  return execFileSync("git", ["-c", "user.name=Plutonium", "-c", "user.email=plutonium@localhost", ...args], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const GITIGNORE = "# Written by the helper.\n/.data/\n/SKILL.md\n/site.d.ts\n";

export interface SiteStoreOptions {
  /** $PLUTO_HOME/sites. */
  readonly dir: string;
  /** Called after a settled change, with the sites whose files changed (all of them on a reload). */
  readonly onChange?: (changed: ReadonlySet<string>) => void;
  /** Commit settled saves (default true; tests turn it off). */
  readonly commit?: boolean;
}

export class SiteStore {
  readonly dir: string;
  private readonly options: SiteStoreOptions;
  private siteMap = new Map<string, Site>();
  private watcher: FSWatcher | null = null;
  private settle: NodeJS.Timeout | null = null;
  private readonly pendingSites = new Set<string>();

  constructor(options: SiteStoreOptions) {
    this.options = options;
    this.dir = options.dir;
  }

  /** Makes the folder (a git repository) if it isn't there, reads every site, and watches for saves. */
  start(): void {
    mkdirSync(this.dir, { recursive: true });
    if (this.options.commit !== false && !existsSync(join(this.dir, ".git"))) {
      try {
        writeFileSync(join(this.dir, ".gitignore"), GITIGNORE, { flag: "wx" });
      } catch {}
      try {
        git(this.dir, ["init", "-q"]);
        git(this.dir, ["add", "-A"]);
        git(this.dir, ["commit", "-q", "--no-verify", "--allow-empty", "-m", "sites: start"]);
      } catch (error) {
        console.warn(`plutoniumd: sites: no git repository in ${this.dir}: ${(error as Error).message}`);
      }
    }
    this.reload();
    this.watch();
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.settle) clearTimeout(this.settle);
  }

  private watch(): void {
    this.watcher?.close();
    try {
      this.watcher = watch(this.dir, { recursive: true }, (_event, file) => {
        if (!file) return;
        const top = String(file).split("/")[0]!;
        if (top.startsWith(".") || !isSiteName(top)) return;
        this.pendingSites.add(top);
        if (this.settle) clearTimeout(this.settle);
        this.settle = setTimeout(() => this.settled(), SETTLE_MS);
      });
    } catch (error) {
      console.warn(`plutoniumd: sites: can't watch ${this.dir}: ${(error as Error).message}`);
    }
  }

  private settled(): void {
    this.settle = null;
    const changed = new Set(this.pendingSites);
    this.pendingSites.clear();
    for (const name of changed) this.readOne(name);
    if (this.options.commit !== false) this.commit(`edit: ${[...changed].sort().join(", ")}`);
    this.options.onChange?.(changed);
  }

  private readOne(name: string): void {
    const dir = join(this.dir, name);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {}
    if (!isDir) {
      this.siteMap.delete(name);
      return;
    }
    const site = readSite(dir, name);
    if (site.error) console.warn(`plutoniumd: sites: ${name}: ${site.error}`);
    this.siteMap.set(name, site);
  }

  /** Reads every site again. */
  reload(): void {
    this.siteMap = new Map();
    let entries: string[] = [];
    try {
      entries = readdirSync(this.dir);
    } catch {}
    for (const name of entries) if (isSiteName(name)) this.readOne(name);
  }

  /** Commits whatever changed, as one commit; returns its hash, or null when nothing did. */
  commit(message: string): string | null {
    try {
      git(this.dir, ["add", "-A"]);
      if (git(this.dir, ["status", "--porcelain"]).trim() === "") return null;
      git(this.dir, ["commit", "-q", "--no-verify", "-m", message]);
      return git(this.dir, ["rev-parse", "--short", "HEAD"]).trim();
    } catch (error) {
      console.warn(`plutoniumd: sites: commit failed: ${(error as Error).message}`);
      return null;
    }
  }

  sites(): Site[] {
    return [...this.siteMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  site(name: string): Site | undefined {
    return this.siteMap.get(name);
  }

  /** The sites whose patterns match `url`. */
  sitesFor(url: string): Site[] {
    return this.sites().filter((site) => !site.error && siteMatches(site.manifest, url));
  }

  /** Turns a part on or off (in site.json, which the watcher then commits and applies). */
  setPartEnabled(siteName: string, part: string, enabled: boolean): void {
    const site = this.siteMap.get(siteName);
    if (!site) throw new SiteError(`No site ${siteName}.`);
    if (!site.parts.some((candidate) => candidate.name === part)) throw new SiteError(`${siteName} has no part ${part}.`);
    const file = join(site.dir, SITE_MANIFEST);
    const raw = (readOptional(file) ? JSON.parse(readOptional(file)!) : {}) as Record<string, unknown>;
    const parts = (raw.parts ?? {}) as Record<string, Record<string, unknown>>;
    parts[part] = { ...(parts[part] ?? {}), enabled };
    raw.parts = parts;
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
  }

  /** The site's storage (site.storage), kept outside git. */
  storagePath(siteName: string): string {
    return join(this.dir, ".data", `${siteName}.json`);
  }

  readStorage(siteName: string): Record<string, unknown> {
    try {
      return JSON.parse(readFileSync(this.storagePath(siteName), "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  writeStorage(siteName: string, values: Record<string, unknown>): void {
    mkdirSync(join(this.dir, ".data"), { recursive: true });
    writeFileSync(this.storagePath(siteName), JSON.stringify(values));
  }

  /** The folder's history, for the API. */
  log(limit = 30): string {
    try {
      return git(this.dir, ["log", "-n", String(limit), "--format=%h  %ad  %s", "--date=format:%Y-%m-%d %H:%M"]);
    } catch {
      return "";
    }
  }
}
