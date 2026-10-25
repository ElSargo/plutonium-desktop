// Shells as installed packages (docs/features/SHELL_PACKAGES.md).
//
// Each shell is a folder in $PLUTO_HOME/shells/<name>/ (~/.pluto by default),
// a git repository whose first commit is the version Plutonium shipped, with
// a shell.json manifest. A static shell is served by the helper at
// http://<name>.localhost:<shells port>/, so each shell has its own origin
// (shell rights are per origin). A server shell names how to start its
// server ("run": "plutonium", supervised by the helper) or where the user
// runs it ("run": "external").
//
// $PLUTO_HOME/shells.json is the session's list: which shells run, in
// Super+Tab's order. The switcher's changes come back to it (Daemon).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { extname, join, normalize, sep } from "node:path";

export const MANIFEST = "shell.json";
/** The branch that holds the versions Plutonium shipped; the user's is main. */
export const SHIPPED_BRANCH = "shipped";

export interface ServerSpec {
  /** "plutonium": the helper starts and supervises it; "external": the user runs it. */
  readonly run: "plutonium" | "external";
  /** The page (external: required; plutonium: default http://127.0.0.1:{port}/). */
  readonly url?: string;
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Its port in slot 0; slot N adds 100 × N, as for every other port. */
  readonly port?: number;
  /** Polled until it answers (any HTTP status): default the url. */
  readonly health?: string;
  /** "on-failure" (default), "always" or "never". */
  readonly restart?: "always" | "on-failure" | "never";
  /** Restart it when its folder changes (an edit). */
  readonly restartOnEdit?: boolean;
  /** Prints the URL to open instead of the url (T3 Code: a one-time pairing token). */
  readonly entryCommand?: readonly string[];
}

export interface ShellManifest {
  readonly name: string;
  readonly title: string;
  readonly version: string;
  readonly description?: string;
  /** The page, relative to the folder: a static shell. */
  readonly static?: string;
  readonly server?: ServerSpec;
  /** The query parameter that names the helper (default "helper"). */
  readonly helperParam?: string;
}

export interface ShellListEntry {
  readonly name: string;
  readonly enabled: boolean;
}

/** What a shell's URLs depend on in a session. */
export interface ShellContext {
  readonly home: string;
  readonly slot: number;
  /** The helper's built-in server for static shells. */
  readonly shellsPort: number;
  /** The helper's URL, for ?helper=. */
  readonly helperUrl: string;
  readonly helperSocket?: string;
  readonly waylandDisplay?: string;
  /** The Plutonium checkout the helper runs from. */
  readonly plutonium: string;
}

export class ShellError extends Error {}

export function plutoHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.PLUTO_HOME || join(homedir(), ".pluto");
}

export const shellsDir = (home: string) => join(home, "shells");
export const shellDir = (home: string, name: string) => join(shellsDir(home), name);
export const logPath = (home: string, name: string) => join(home, "logs", `${name}.log`);

/** A name is also a host name label: <name>.localhost. */
export function isShellName(name: unknown): name is string {
  return typeof name === "string" && /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name);
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Reads and checks a manifest; `name` is the folder's name, which wins. */
export function parseManifest(text: string, name: string): ShellManifest {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ShellError(`${MANIFEST} isn't JSON: ${(error as Error).message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ShellError(`${MANIFEST} isn't an object`);
  if (!isShellName(name)) throw new ShellError(`"${name}" can't be a shell's name (a-z, 0-9 and -)`);
  const str = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : undefined);
  const manifest: ShellManifest = {
    name,
    title: str("title") || name,
    version: str("version") || "0",
    ...(str("description") ? { description: str("description") } : {}),
    ...(str("static") ? { static: str("static") } : {}),
    ...(str("helperParam") ? { helperParam: str("helperParam") } : {}),
    ...(value.server ? { server: parseServer(value.server) } : {}),
  };
  if (!manifest.static === !manifest.server) throw new ShellError(`${MANIFEST} needs either "static" or "server"`);
  if (manifest.static && (manifest.static.startsWith("/") || manifest.static.split("/").includes(".."))) {
    throw new ShellError(`"static" must be a path inside the shell's folder`);
  }
  return manifest;
}

function parseServer(value: unknown): ServerSpec {
  if (!value || typeof value !== "object") throw new ShellError(`"server" isn't an object`);
  const server = value as Record<string, unknown>;
  if (server.run !== "plutonium" && server.run !== "external") {
    throw new ShellError(`"server.run" is "plutonium" or "external"`);
  }
  if (server.url !== undefined && typeof server.url !== "string") throw new ShellError(`"server.url" isn't a string`);
  if (server.run === "external") {
    if (typeof server.url !== "string") throw new ShellError(`an external server needs "server.url"`);
    return { run: "external", url: server.url };
  }
  if (!isStringArray(server.argv) || server.argv.length === 0) throw new ShellError(`"server.argv" is a command`);
  if (server.port !== undefined && !(Number.isInteger(server.port) && (server.port as number) > 0)) {
    throw new ShellError(`"server.port" isn't a port`);
  }
  if (server.env !== undefined) {
    const env = server.env as Record<string, unknown>;
    if (!env || typeof env !== "object" || !Object.values(env).every((v) => typeof v === "string")) {
      throw new ShellError(`"server.env" maps names to strings`);
    }
  }
  if (server.restart !== undefined && !["always", "on-failure", "never"].includes(server.restart as string)) {
    throw new ShellError(`"server.restart" is "always", "on-failure" or "never"`);
  }
  if (server.entryCommand !== undefined && !isStringArray(server.entryCommand)) {
    throw new ShellError(`"server.entryCommand" is a command`);
  }
  if (server.url === undefined && server.port === undefined) throw new ShellError(`"server" needs a port or a url`);
  return server as unknown as ServerSpec;
}

export function readManifest(dir: string, name: string): ShellManifest {
  let text: string;
  try {
    text = readFileSync(join(dir, MANIFEST), "utf8");
  } catch {
    throw new ShellError(`no ${MANIFEST} in ${dir}`);
  }
  return parseManifest(text, name);
}

export interface InstalledShell {
  readonly name: string;
  readonly dir: string;
  readonly manifest?: ShellManifest;
  /** Why its manifest can't be used. */
  readonly error?: string;
}

export function installedShells(home: string): InstalledShell[] {
  let names: string[];
  try {
    names = readdirSync(shellsDir(home)).sort();
  } catch {
    return [];
  }
  const shells: InstalledShell[] = [];
  for (const name of names) {
    const dir = shellDir(home, name);
    if (name.startsWith(".") || !statSync(dir).isDirectory()) continue;
    try {
      shells.push({ name, dir, manifest: readManifest(dir, name) });
    } catch (error) {
      shells.push({ name, dir, error: (error as Error).message });
    }
  }
  return shells;
}

// --- The list (shells.json) --------------------------------------------------

const listPath = (home: string) => join(home, "shells.json");

export function readList(home: string): ShellListEntry[] | undefined {
  let value: { shells?: unknown };
  try {
    value = JSON.parse(readFileSync(listPath(home), "utf8"));
  } catch {
    return undefined;
  }
  if (!Array.isArray(value?.shells)) return undefined;
  return value.shells
    .filter((entry): entry is { name: string; enabled?: unknown } => isShellName(entry?.name))
    .map((entry) => ({ name: entry.name, enabled: entry.enabled !== false }));
}

export function writeList(home: string, shells: readonly ShellListEntry[]): void {
  mkdirSync(home, { recursive: true });
  const temporary = `${listPath(home)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ shells }, null, 2)}\n`);
  renameSync(temporary, listPath(home));
}

/**
 * The list to run: shells.json's, without shells that aren't installed (or
 * whose manifest is broken), then installed shells it doesn't name, off.
 */
export function effectiveList(home: string): ShellListEntry[] {
  const installed = new Map(installedShells(home).filter((shell) => shell.manifest).map((s) => [s.name, s]));
  const list = (readList(home) ?? []).filter((entry) => installed.has(entry.name));
  for (const name of installed.keys()) {
    if (!list.some((entry) => entry.name === name)) list.push({ name, enabled: false });
  }
  return list;
}

// --- URLs and origins --------------------------------------------------------

/** {port}, {plutonium}, {shell}, {home}, {helper}, {helperSocket}, {waylandDisplay}, {slot}. */
export function expand(text: string, manifest: ShellManifest, context: ShellContext): string {
  const values: Record<string, string> = {
    port: String(serverPort(manifest, context) ?? ""),
    plutonium: context.plutonium,
    shell: shellDir(context.home, manifest.name),
    home: homedir(),
    helper: context.helperUrl,
    helperSocket: context.helperSocket ?? "",
    waylandDisplay: context.waylandDisplay ?? "",
    slot: String(context.slot),
  };
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
}

export function serverPort(manifest: ShellManifest, context: ShellContext): number | undefined {
  const port = manifest.server?.run === "plutonium" ? manifest.server.port : undefined;
  return port === undefined ? undefined : port + 100 * context.slot;
}

/** The page without ?helper=: the static shell's, or the server's. */
export function baseUrl(manifest: ShellManifest, context: ShellContext): string {
  if (manifest.static) {
    const path = manifest.static.split("/").map(encodeURIComponent).join("/");
    return `http://${manifest.name}.localhost:${context.shellsPort}/${path === "index.html" ? "" : path}`;
  }
  const server = manifest.server!;
  return expand(server.url ?? "http://127.0.0.1:{port}/", manifest, context);
}

export function shellOrigin(manifest: ShellManifest, context: ShellContext): string {
  return new URL(baseUrl(manifest, context)).origin;
}

/** A page URL with the helper named in it, before any fragment. */
export function withHelper(url: string, manifest: ShellManifest, context: ShellContext): string {
  const hash = url.indexOf("#");
  const base = hash < 0 ? url : url.slice(0, hash);
  const fragment = hash < 0 ? "" : url.slice(hash);
  // Unescaped, as launchers always wrote it: pages read it with URLSearchParams.
  return `${base}${base.includes("?") ? "&" : "?"}${manifest.helperParam ?? "helper"}=${context.helperUrl}${fragment}`;
}

/** The URL a session opens (runs a server shell's entryCommand, if it has one). */
export function entryUrl(manifest: ShellManifest, context: ShellContext): string {
  let url = baseUrl(manifest, context);
  const command = manifest.server?.run === "plutonium" ? manifest.server.entryCommand : undefined;
  if (command) {
    const argv = command.map((arg) => expand(arg, manifest, context));
    const printed = execFileSync(argv[0]!, argv.slice(1), {
      cwd: shellDir(context.home, manifest.name),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 60_000,
    }).trim();
    if (!/^https?:\/\//.test(printed)) throw new ShellError(`${manifest.name}'s entryCommand printed no URL`);
    url = printed;
  }
  return withHelper(url, manifest, context);
}

// --- Git ---------------------------------------------------------------------

/** git in a shell's folder. Commits are Plutonium's when git has no identity. */
export function git(dir: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...identity(), ...options.env },
  });
}

let gitIdentity: Record<string, string> | undefined;
function identity(): Record<string, string> {
  if (gitIdentity) return gitIdentity;
  let configured = false;
  try {
    configured = execFileSync("git", ["config", "user.email"], { encoding: "utf8", stdio: "pipe" }).trim() !== "";
  } catch {
    // Not set.
  }
  gitIdentity = configured
    ? {}
    : {
        GIT_AUTHOR_NAME: "Plutonium",
        GIT_AUTHOR_EMAIL: "plutonium@localhost",
        GIT_COMMITTER_NAME: "Plutonium",
        GIT_COMMITTER_EMAIL: "plutonium@localhost",
      };
  return gitIdentity;
}

/** Commits whatever changed in the folder: "edit: <files>". Returns the commit, if one was made. */
export function commitEdits(dir: string, prefix = "edit"): string | undefined {
  git(dir, ["add", "-A"]);
  const files = git(dir, ["diff", "--cached", "--name-only"]).trim().split("\n").filter(Boolean);
  if (files.length === 0) return undefined;
  const list = files.length > 5 ? `${files.slice(0, 5).join(", ")} and ${files.length - 5} more` : files.join(", ");
  git(dir, ["commit", "-q", "--no-verify", "-m", `${prefix}: ${list}`]);
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

/** The shipped version of `name` in a checkout's shells/ folder. */
export function shippedManifest(shippedRoot: string, name: string): ShellManifest {
  return readManifest(join(shippedRoot, name), name);
}

export function shippedNames(shippedRoot: string): string[] {
  return readdirSync(shippedRoot)
    .filter((name) => isShellName(name) && existsSync(join(shippedRoot, name, MANIFEST)))
    .sort();
}

/**
 * Copies a shipped shell into the user's shells as a git repository: main and
 * shipped both start at the shipped version. Does nothing if it's there.
 */
export function installShell(home: string, shippedRoot: string, name: string): boolean {
  const manifest = shippedManifest(shippedRoot, name);
  const dir = shellDir(home, name);
  if (existsSync(dir)) return false;
  mkdirSync(shellsDir(home), { recursive: true });
  const temporary = join(shellsDir(home), `.${name}.installing`);
  cpSync(join(shippedRoot, name), temporary, { recursive: true });
  git(temporary, ["init", "-q", "-b", "main"]);
  git(temporary, ["add", "-A"]);
  git(temporary, ["commit", "-q", "--no-verify", "-m", `shipped: ${name} ${manifest.version}`]);
  git(temporary, ["branch", SHIPPED_BRANCH]);
  renameSync(temporary, dir);
  return true;
}

export type UpdateResult =
  | { readonly status: "up-to-date" }
  | { readonly status: "updated"; readonly version: string }
  | { readonly status: "conflict"; readonly version: string; readonly files: readonly string[] };

/**
 * Merges the shipped version into the user's copy. Their edits are commits
 * (anything uncommitted is committed first). The new version goes on the
 * shipped branch; a merge that conflicts is undone, and the files are
 * reported, so the copy stays as it was (`git merge shipped` to do it by hand).
 */
export function updateShell(home: string, shippedRoot: string, name: string): UpdateResult {
  const manifest = shippedManifest(shippedRoot, name);
  const dir = shellDir(home, name);
  if (!existsSync(join(dir, ".git"))) throw new ShellError(`${name} isn't installed`);
  commitEdits(dir);
  // The shipped files as a commit on top of the shipped branch, through a
  // scratch index, without touching the user's files.
  const index = join(dir, ".git", "plutonium-shipped-index");
  const env = { GIT_INDEX_FILE: index, GIT_WORK_TREE: join(shippedRoot, name) };
  git(dir, ["read-tree", "--empty"], { env });
  git(dir, ["--work-tree", join(shippedRoot, name), "add", "-A", "."], { env });
  const tree = git(dir, ["write-tree"], { env }).trim();
  const parent = git(dir, ["rev-parse", SHIPPED_BRANCH]).trim();
  if (git(dir, ["rev-parse", `${parent}^{tree}`]).trim() !== tree) {
    const commit = git(dir, ["commit-tree", tree, "-p", parent, "-m", `shipped: ${name} ${manifest.version}`]).trim();
    git(dir, ["update-ref", `refs/heads/${SHIPPED_BRANCH}`, commit, parent]);
  }
  if (isMerged(dir)) return { status: "up-to-date" };
  try {
    git(dir, ["merge", "-q", "--no-edit", "-m", `update: ${name} ${manifest.version}`, SHIPPED_BRANCH]);
    return { status: "updated", version: manifest.version };
  } catch {
    const files = git(dir, ["diff", "--name-only", "--diff-filter=U"]).trim().split("\n").filter(Boolean);
    git(dir, ["merge", "--abort"]);
    return { status: "conflict", version: manifest.version, files };
  }
}

function isMerged(dir: string): boolean {
  try {
    git(dir, ["merge-base", "--is-ancestor", SHIPPED_BRANCH, "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

// --- The built-in server -----------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

/** The static shell a request on the shells port is for: <name>.localhost:<port>. */
export function shellOfHost(host: string | undefined): string | undefined {
  const match = host?.toLowerCase().match(/^([a-z0-9-]+)\.localhost(:\d+)?$/);
  return match && isShellName(match[1]) ? match[1] : undefined;
}

/**
 * Serves a static shell's files, read on every request (an edit shows on the
 * next reload). Dot files and folders (.git) aren't served. `root` overrides
 * the folder (safe mode serves the shipped plain shell).
 */
export function serveStaticShell(
  home: string,
  request: IncomingMessage,
  response: ServerResponse,
  roots: Readonly<Record<string, string>> = {},
): void {
  const send = (status: number, text: string) => {
    response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }).end(text);
  };
  if (request.method !== "GET" && request.method !== "HEAD") return send(405, "Only GET.");
  const name = shellOfHost(request.headers.host);
  if (!name) return send(404, "No such shell: the address is http://<shell>.localhost:<port>/.");
  const dir = roots[name] ?? shellDir(home, name);
  let manifest: ShellManifest;
  try {
    manifest = readManifest(dir, name);
  } catch (error) {
    return send(404, `No shell ${name}: ${(error as Error).message}`);
  }
  if (!manifest.static) return send(404, `${name} isn't a static shell.`);
  let path: string;
  try {
    path = decodeURIComponent(new URL(request.url ?? "/", "http://shell").pathname);
  } catch {
    return send(400, "Bad path.");
  }
  if (path.split("/").some((part) => part.startsWith("."))) return send(404, "Not found.");
  let file = normalize(join(dir, path));
  if (file !== dir && !file.startsWith(dir + sep)) return send(404, "Not found.");
  if (path === "/") file = join(dir, manifest.static);
  try {
    if (statSync(file).isDirectory()) file = join(file, "index.html");
    const body = readFileSync(file);
    response.writeHead(200, {
      "Content-Type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    send(404, "Not found.");
  }
}

// --- In the helper -----------------------------------------------------------

export interface BrowserShell {
  readonly name: string;
  readonly url: string;
  readonly enabled: boolean;
}

/** A shell's state, for the switcher and GET /v1/shells. */
export interface ShellStatus {
  readonly name: string;
  readonly title?: string;
  readonly kind: "static" | "plutonium" | "external" | "broken";
  readonly dir: string;
  readonly origin?: string;
  readonly enabled: boolean;
  readonly error?: string;
}

/** A free folder name for a shell called `title`. */
export function newShellName(home: string, title: string): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "shell";
  let name = base;
  for (let n = 2; existsSync(shellDir(home, name)) || name === "safe"; n++) name = `${base}-${n}`;
  return name;
}

/** A shell folder (a git repository) for a page the user runs elsewhere. */
export function addExternalShell(home: string, title: string, url: string, context?: ShellContext): string {
  const name = newShellName(home, title);
  const dir = shellDir(home, name);
  mkdirSync(dir, { recursive: true });
  // Without the helper's parameter, which the session adds.
  const parsed = new URL(url);
  for (const param of ["helper", "plutoniumHelper"]) {
    if (context && parsed.searchParams.get(param) === context.helperUrl) parsed.searchParams.delete(param);
  }
  parsed.hash = "";
  const manifest = { title, version: "1", server: { run: "external", url: parsed.href } };
  writeFileSync(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  git(dir, ["init", "-q", "-b", "main"]);
  commitEdits(dir, "added");
  return name;
}

/**
 * The helper's side of the installed shells: serves the static ones, keeps
 * shells.json in step with the browser's list.
 */
export class ShellPackages {
  readonly context: ShellContext;
  /** Write the browser's list back to shells.json (a session started from it). */
  private readonly persist: boolean;

  constructor(context: ShellContext, options: { persist?: boolean } = {}) {
    this.context = context;
    this.persist = options.persist ?? false;
  }

  get home(): string {
    return this.context.home;
  }

  /** The built-in server's request handler. */
  serve(request: IncomingMessage, response: ServerResponse): void {
    serveStaticShell(this.home, request, response, { safe: join(this.context.plutonium, "shells", "plain") });
  }

  originOf(shell: InstalledShell): string | undefined {
    return shell.manifest ? shellOrigin(shell.manifest, this.context) : undefined;
  }

  /** The installed shell on `origin`. */
  byOrigin(origin: string): InstalledShell | undefined {
    return installedShells(this.home).find((shell) => this.originOf(shell) === origin);
  }

  status(): ShellStatus[] {
    const list = effectiveList(this.home);
    const order = (name: string) => {
      const index = list.findIndex((entry) => entry.name === name);
      return index < 0 ? list.length : index;
    };
    return installedShells(this.home)
      .sort((a, b) => order(a.name) - order(b.name))
      .map((shell) => ({
        name: shell.name,
        ...(shell.manifest ? { title: shell.manifest.title, origin: this.originOf(shell) } : {}),
        kind: !shell.manifest ? "broken" : shell.manifest.static ? "static" : shell.manifest.server!.run,
        dir: shell.dir,
        enabled: list.find((entry) => entry.name === shell.name)?.enabled ?? false,
        ...(shell.error ? { error: shell.error } : {}),
      }));
  }

  /**
   * The browser's shells, in order (a shell page reports them after every
   * change in the switcher): saved as shells.json. A page that is no
   * installed shell becomes an external one.
   */
  browserList(shells: readonly BrowserShell[]): void {
    if (!this.persist) return;
    const list: ShellListEntry[] = [];
    for (const shell of shells) {
      let origin: string;
      try {
        origin = new URL(shell.url).origin;
      } catch {
        continue;
      }
      if (shellOfHost(new URL(shell.url).host) === "safe") continue;
      const name = this.byOrigin(origin)?.name ?? addExternalShell(this.home, shell.name, shell.url, this.context);
      if (!list.some((entry) => entry.name === name)) list.push({ name, enabled: shell.enabled });
    }
    // Installed shells the browser doesn't have (removed in the switcher) stay installed, off.
    for (const entry of effectiveList(this.home)) {
      if (!list.some((other) => other.name === entry.name)) list.push({ name: entry.name, enabled: false });
    }
    if (JSON.stringify(list) !== JSON.stringify(readList(this.home))) writeList(this.home, list);
  }
}
