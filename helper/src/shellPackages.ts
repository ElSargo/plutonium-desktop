// The helper's side of the installed shells (shells.ts): it serves the
// static ones, runs the servers (shellServers.ts), keeps shells.json in step
// with the switcher, and looks after edits.
//
// Edits: the helper watches each shell's folder. A save is committed
// ("edit: <files>"), then the shell's pages reload (a server whose manifest
// says restartOnEdit restarts first). If no page of the shell connects to the
// helper within CONNECT_TIMEOUT_MS, or its server doesn't come up, the folder
// goes back to the last commit that came up (refs/plutonium/good) in a new
// commit, and the shell reloads; the failed commit is kept
// (refs/plutonium/failed) for Retry and Diff, and the switcher shows a notice.
import { randomUUID } from "node:crypto";
import { existsSync, type FSWatcher, readFileSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { ShellServer, type ServerStatus } from "./shellServers.ts";
import {
  addExternalShell,
  addShell,
  previewShell,
  type AddPreview,
  commitEdits,
  effectiveList,
  entryUrl,
  git,
  installedShells,
  logPath,
  readList,
  serveStaticShell,
  shellDir,
  ShellError,
  shellOfHost,
  shellOrigin,
  updateShell,
  writeList,
  type InstalledShell,
  type ShellContext,
  type ShellListEntry,
  type ShellManifest,
} from "./shells.ts";
import type { TerminalOptions } from "./terminal.ts";

// How long a shell has, after a change, to connect to the helper.
export const CONNECT_TIMEOUT_MS = 20_000;
// Saves that come together are one edit.
const EDIT_DEBOUNCE_MS = 700;
// A start with no shell connected after this long counts as failed; after two
// the launcher starts in safe mode.
const START_TIMEOUT_MS = 60_000;
const GOOD_REF = "refs/plutonium/good";
const FAILED_REF = "refs/plutonium/failed";

export interface BrowserShell {
  readonly name: string;
  readonly url: string;
  readonly enabled: boolean;
}

/** What the helper does for the installed shells (the daemon's parts). */
export interface ShellHooks {
  /** Reloads the browser's pages on an origin, bypassing the cache. */
  reloadPages?(origin: string): Promise<number>;
  /** Opens a backup terminal session; returns its id. */
  openTerminal?(options: TerminalOptions): string;
  /** A thread's environment for what the user types, and the agent bridge. */
  threadSetup?(thread: string): {
    terminalEnv: NodeJS.ProcessEnv;
    mcpServer: { command: string; args: string[] };
  };
}

/** A shell's state, for the switcher and GET /v1/shells. */
export interface ShellStatus {
  readonly name: string;
  readonly title?: string;
  readonly kind: "static" | "plutonium" | "external" | "broken";
  readonly dir: string;
  readonly origin?: string;
  /** The page a session opens for it (without a one-time token). */
  readonly url?: string;
  readonly version?: string;
  readonly commit?: string;
  readonly enabled: boolean;
  readonly server?: ServerStatus;
  readonly notice?: string;
  /** A change that didn't come up: Retry, Diff. */
  readonly failed?: { readonly commit: string; readonly subject: string };
  readonly checking?: boolean;
  readonly error?: string;
}

interface Check {
  readonly commit: string;
  readonly since: number;
  readonly timer: NodeJS.Timeout;
}

const short = (commit: string) => commit.slice(0, 8);

export class ShellPackages {
  readonly context: ShellContext;
  private readonly persist: boolean;
  /** The daemon fills these in. */
  hooks: ShellHooks;
  private readonly servers = new Map<string, ShellServer>();
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly editTimers = new Map<string, NodeJS.Timeout>();
  private readonly checks = new Map<string, Check>();
  private readonly notices = new Map<string, string>();
  /** When a page of each origin last connected. */
  private readonly connectedAt = new Map<string, number>();
  /** Servers the user stopped: the browser's list doesn't start them again. */
  private readonly userStopped = new Set<string>();
  private activeOrigins = new Set<string>();
  /** Shells added from the shells page that the browser doesn't list yet: the switcher adds them. */
  private readonly pendingAdd = new Set<string>();
  /** Previews waiting for the user's yes (a git clone is staged). */
  private readonly previews = new Map<string, AddPreview & { readonly staged?: string }>();
  private startTimer: NodeJS.Timeout | undefined;
  private readonly connectTimeoutMs: number;

  constructor(
    context: ShellContext,
    options: { persist?: boolean; hooks?: ShellHooks; connectTimeoutMs?: number } = {},
  ) {
    this.context = context;
    this.persist = options.persist ?? false;
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.hooks = options.hooks ?? {};
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

  private installed(name: string): InstalledShell {
    const shell = installedShells(this.home).find((candidate) => candidate.name === name);
    if (!shell) throw new ShellError(`No installed shell "${name}".`);
    return shell;
  }

  private manifestOf(name: string): ShellManifest {
    const shell = this.installed(name);
    if (!shell.manifest) throw new ShellError(`${name}'s shell.json: ${shell.error}`);
    return shell.manifest;
  }

  // --- The session ---------------------------------------------------------

  /** At the helper's start: the session's shells (their origins) run. */
  start(origins: readonly string[]): void {
    for (const shell of installedShells(this.home)) this.watchFolder(shell.name);
    this.sync(origins);
    if (this.persist) {
      // Counted as failed until a shell connects (the launcher reads it).
      this.startTimer = setTimeout(() => {
        const failed = this.failedStarts() + 1;
        writeFileSync(join(this.home, "failed-starts"), `${failed}\n`);
        console.warn(`plutoniumd: no shell connected in ${START_TIMEOUT_MS / 1000} s (failed starts: ${failed})`);
      }, START_TIMEOUT_MS);
      this.startTimer.unref();
    }
  }

  failedStarts(): number {
    try {
      return Number(readFileSync(join(this.home, "failed-starts"), "utf8")) || 0;
    } catch {
      return 0;
    }
  }

  /** The shells that are on (their origins): their servers run, the others' stop. */
  sync(origins: Iterable<string>): void {
    this.activeOrigins = new Set(origins);
    for (const shell of installedShells(this.home)) {
      if (shell.manifest?.server?.run !== "plutonium") continue;
      const on = this.activeOrigins.has(this.originOf(shell)!);
      const server = this.servers.get(shell.name);
      if (on && !this.userStopped.has(shell.name)) {
        if (!server || server.state === "stopped") void this.server(shell.manifest).start();
      } else if (!on && server && server.state !== "stopped" && server.state !== "failed") {
        void server.stop();
      }
    }
  }

  private server(manifest: ShellManifest): ShellServer {
    let server = this.servers.get(manifest.name);
    if (!server) {
      server = new ShellServer(manifest, this.context);
      this.servers.set(manifest.name, server);
    } else {
      server.setManifest(manifest);
    }
    return server;
  }

  /** Resolves when every server that's starting is up (or isn't going to be). */
  async whenServersUp(): Promise<void> {
    await Promise.all([...this.servers.values()].map((server) => server.whenHealthy()));
  }

  /** A shell page connected to the helper. */
  connected(origin: string): void {
    this.connectedAt.set(origin, Date.now());
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = undefined;
      if (this.failedStarts()) writeFileSync(join(this.home, "failed-starts"), "0\n");
    }
    const shell = this.byOrigin(origin);
    if (!shell) return;
    const check = this.checks.get(shell.name);
    if (check) {
      clearTimeout(check.timer);
      this.checks.delete(shell.name);
      this.markGood(shell.name, check.commit);
      console.log(`plutoniumd: shell ${shell.name}: ${short(check.commit)} came up`);
    } else if (this.isClean(shell.dir)) {
      this.markGood(shell.name, git(shell.dir, ["rev-parse", "HEAD"]).trim());
    }
  }

  stop(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    for (const timer of this.editTimers.values()) clearTimeout(timer);
    for (const check of this.checks.values()) clearTimeout(check.timer);
    clearTimeout(this.startTimer);
    for (const preview of this.previews.values()) if (preview.staged) rmSync(preview.staged, { recursive: true, force: true });
    // The servers keep running: the next helper adopts them.
  }

  // --- The list ------------------------------------------------------------

  status(): ShellStatus[] {
    const list = effectiveList(this.home);
    const order = (name: string) => {
      const index = list.findIndex((entry) => entry.name === name);
      return index < 0 ? list.length : index;
    };
    return installedShells(this.home)
      .sort((a, b) => order(a.name) - order(b.name))
      .map((shell) => {
        const manifest = shell.manifest;
        const failed = this.failedCommit(shell.dir);
        return {
          name: shell.name,
          kind: !manifest ? "broken" : manifest.static ? "static" : manifest.server!.run,
          dir: shell.dir,
          enabled: list.find((entry) => entry.name === shell.name)?.enabled ?? false,
          ...(manifest
            ? {
                title: manifest.title,
                version: manifest.version,
                origin: this.originOf(shell),
                url: this.pageUrl(manifest),
              }
            : {}),
          ...(this.commitOf(shell.dir) ? { commit: this.commitOf(shell.dir) } : {}),
          ...(this.servers.has(shell.name) || manifest?.server?.run === "plutonium"
            ? { server: this.servers.get(shell.name)?.status() ?? this.server(manifest!).status() }
            : {}),
          ...(this.notices.has(shell.name) ? { notice: this.notices.get(shell.name) } : {}),
          ...(failed ? { failed } : {}),
          ...(this.checks.has(shell.name) ? { checking: true } : {}),
          ...(this.pendingAdd.has(shell.name) ? { add: true } : {}),
          ...(shell.error ? { error: shell.error } : {}),
        };
      });
  }

  private pageUrl(manifest: ShellManifest): string | undefined {
    try {
      return entryUrl({ ...manifest, server: manifest.server && { ...manifest.server, entryCommand: undefined } }, this.context);
    } catch {
      return undefined;
    }
  }

  private commitOf(dir: string): string | undefined {
    try {
      return short(git(dir, ["rev-parse", "HEAD"]).trim());
    } catch {
      return undefined;
    }
  }

  /**
   * The browser's shells, in order (a shell page reports them after every
   * change in the switcher): saved as shells.json. A page that is no
   * installed shell becomes an external one.
   */
  browserList(shells: readonly BrowserShell[]): void {
    this.sync(
      shells.filter((shell) => shell.enabled).flatMap((shell) => {
        try {
          return [new URL(shell.url).origin];
        } catch {
          return [];
        }
      }),
    );
    if (!this.persist) return;
    const list: ShellListEntry[] = [];
    for (const shell of shells) {
      let url: URL;
      try {
        url = new URL(shell.url);
      } catch {
        continue;
      }
      if (shellOfHost(url.host) === "safe") continue;
      let name = this.byOrigin(url.origin)?.name;
      if (name) this.pendingAdd.delete(name);
      if (!name) {
        name = addExternalShell(this.home, shell.name, shell.url, this.context);
        this.watchFolder(name);
      }
      if (!list.some((entry) => entry.name === name)) list.push({ name, enabled: shell.enabled });
    }
    // Installed shells the browser doesn't have (removed in the switcher) stay installed, off.
    for (const entry of effectiveList(this.home)) {
      if (!list.some((other) => other.name === entry.name)) list.push({ name: entry.name, enabled: false });
    }
    if (JSON.stringify(list) !== JSON.stringify(readList(this.home))) writeList(this.home, list);
  }

  // --- Edits and safety ----------------------------------------------------

  private watchFolder(name: string): void {
    if (this.watchers.has(name)) return;
    const dir = shellDir(this.home, name);
    try {
      const watcher = watch(dir, { recursive: true }, (_event, file) => {
        if (!file || file === ".git" || file.startsWith(".git/")) return;
        clearTimeout(this.editTimers.get(name));
        this.editTimers.set(
          name,
          setTimeout(() => {
            this.editTimers.delete(name);
            this.edited(name);
          }, EDIT_DEBOUNCE_MS),
        );
      });
      watcher.on("error", () => this.watchers.delete(name));
      this.watchers.set(name, watcher);
    } catch (error) {
      console.warn(`plutoniumd: can't watch ${dir}: ${(error as Error).message}`);
    }
  }

  private isClean(dir: string): boolean {
    try {
      return git(dir, ["status", "--porcelain"]).trim() === "";
    } catch {
      return false;
    }
  }

  /** A save in a shell's folder: commit it, apply it, check it. */
  private edited(name: string): void {
    const dir = shellDir(this.home, name);
    if (!existsSync(join(dir, ".git"))) return;
    let commit: string | undefined;
    try {
      commit = commitEdits(dir);
    } catch (error) {
      console.warn(`plutoniumd: shell ${name}: couldn't commit an edit: ${(error as Error).message}`);
      return;
    }
    if (!commit) return;
    console.log(`plutoniumd: shell ${name}: ${git(dir, ["log", "-1", "--format=%h %s"]).trim()}`);
    void this.apply(name, commit);
  }

  /** Applies the folder's HEAD to the running shell and waits for it to come up. */
  private async apply(name: string, commit: string): Promise<void> {
    const previous = this.checks.get(name);
    if (previous) clearTimeout(previous.timer);
    this.checks.delete(name);
    let manifest: ShellManifest;
    try {
      manifest = this.manifestOf(name);
    } catch (error) {
      this.rollback(name, commit, (error as Error).message);
      return;
    }
    const origin = shellOrigin(manifest, this.context);
    // A shell that isn't on: nothing to check now.
    if (!this.activeOrigins.has(origin)) return;
    const since = Date.now();
    if (manifest.server?.run === "plutonium" && manifest.server.restartOnEdit) {
      const server = this.server(manifest);
      if (!(await server.restart())) {
        this.rollback(name, commit, `its server didn't come up (${server.status().detail})`);
        return;
      }
    }
    const timer = setTimeout(() => {
      if (this.checks.get(name)?.commit !== commit) return;
      this.checks.delete(name);
      if ((this.connectedAt.get(origin) ?? 0) >= since) return;
      this.rollback(name, commit, `no page connected to the helper within ${this.connectTimeoutMs / 1000} s`);
    }, this.connectTimeoutMs);
    timer.unref();
    this.checks.set(name, { commit, since, timer });
    await this.hooks.reloadPages?.(origin).catch(() => 0);
  }

  private markGood(name: string, commit: string): void {
    const dir = shellDir(this.home, name);
    try {
      git(dir, ["update-ref", GOOD_REF, commit]);
    } catch {
      return;
    }
    // The failed change came up after all (Retry): forget it.
    const failed = this.failedCommit(dir);
    if (!failed || git(dir, ["rev-parse", `${failed.commit}^{tree}`]) !== git(dir, ["rev-parse", `${commit}^{tree}`])) return;
    git(dir, ["update-ref", "-d", FAILED_REF]);
  }

  private goodCommit(dir: string): string {
    try {
      return git(dir, ["rev-parse", "-q", "--verify", GOOD_REF]).trim();
    } catch {
      // Never seen healthy: the first commit (what was shipped or added).
      return git(dir, ["rev-list", "--max-parents=0", "HEAD"]).trim().split("\n")[0]!;
    }
  }

  private failedCommit(dir: string): { commit: string; subject: string } | undefined {
    try {
      const [commit, ...subject] = git(dir, ["log", "-1", "--format=%h %s", FAILED_REF]).trim().split(" ");
      return commit ? { commit, subject: subject.join(" ") } : undefined;
    } catch {
      return undefined;
    }
  }

  /** Puts the folder back as it was at the last commit that came up, in a new commit. */
  private rollback(name: string, failed: string, reason: string): void {
    const dir = shellDir(this.home, name);
    const good = this.goodCommit(dir);
    const subject = git(dir, ["log", "-1", "--format=%s", failed]).trim();
    git(dir, ["update-ref", FAILED_REF, failed]);
    git(dir, ["read-tree", "-u", "--reset", good]);
    try {
      git(dir, ["commit", "-q", "--no-verify", "-m", `rollback: ${short(failed)} didn't come up (${reason}); back to ${short(good)}`]);
    } catch {
      // Nothing changed.
    }
    let title = name;
    try {
      title = this.manifestOf(name).title;
    } catch {
      // Its name.
    }
    const notice = `${title}: your change “${subject}” didn't come up (${reason}), so it was rolled back to ${short(good)}. Retry or see the diff on its page.`;
    this.notices.set(name, notice);
    console.warn(`plutoniumd: shell ${name}: ${notice}`);
    // The good version, applied again (a server restarts; pages reload).
    void (async () => {
      let manifest: ShellManifest;
      try {
        manifest = this.manifestOf(name);
      } catch {
        return;
      }
      const origin = shellOrigin(manifest, this.context);
      if (!this.activeOrigins.has(origin)) return;
      if (manifest.server?.run === "plutonium" && manifest.server.restartOnEdit) await this.server(manifest).restart();
      await this.hooks.reloadPages?.(origin).catch(() => 0);
    })();
  }

  // --- Actions (the switcher, the shells page) -----------------------------

  async action(name: string, action: string, body: Record<string, unknown> = {}): Promise<unknown> {
    const shell = this.installed(name);
    switch (action) {
      case "start":
      case "restart":
      case "stop": {
        const manifest = this.manifestOf(name);
        if (manifest.server?.run !== "plutonium") throw new ShellError(`${name} has no server Plutonium runs.`);
        const server = this.server(manifest);
        if (action === "stop") {
          this.userStopped.add(name);
          await server.stop();
          return server.status();
        }
        this.userStopped.delete(name);
        const healthy = action === "start" ? await server.start() : await server.restart();
        if (healthy) await this.hooks.reloadPages?.(shellOrigin(manifest, this.context)).catch(() => 0);
        return server.status();
      }
      case "agent":
      case "terminal": {
        if (!this.hooks.openTerminal || !this.hooks.threadSetup) throw new ShellError("No terminals here.");
        const setup = this.hooks.threadSetup(`plutonium:shell/${name}`);
        const title = shell.manifest?.title ?? name;
        if (action === "terminal") {
          return { terminal: this.hooks.openTerminal({ cwd: shell.dir, title: `${title}: folder`, env: setup.terminalEnv }) };
        }
        const mcp = JSON.stringify({ mcpServers: { plutonium: { type: "stdio", ...setup.mcpServer } } });
        const command = process.env.PLUTONIUM_SHELL_AGENT || "claude";
        return {
          terminal: this.hooks.openTerminal({
            cwd: shell.dir,
            title: `${title}: agent`,
            env: setup.terminalEnv,
            argv: [command, "--mcp-config", mcp, this.agentPrompt(shell)],
          }),
        };
      }
      case "retry": {
        const failed = this.failedCommit(shell.dir);
        if (!failed) throw new ShellError(`${name} has no failed change.`);
        git(shell.dir, ["read-tree", "-u", "--reset", failed.commit]);
        git(shell.dir, ["commit", "-q", "--no-verify", "--allow-empty", "-m", `retry: ${failed.subject}`]);
        this.notices.delete(name);
        const commit = git(shell.dir, ["rev-parse", "HEAD"]).trim();
        void this.apply(name, commit);
        return { commit: short(commit) };
      }
      case "dismiss":
        this.notices.delete(name);
        return {};
      case "update": {
        const result = updateShell(this.home, join(this.context.plutonium, "shells"), name);
        if (result.status === "updated") void this.apply(name, git(shell.dir, ["rev-parse", "HEAD"]).trim());
        return result;
      }
      case "reload": {
        const manifest = this.manifestOf(name);
        return { reloaded: (await this.hooks.reloadPages?.(shellOrigin(manifest, this.context))) ?? 0 };
      }
      default:
        void body;
        throw new ShellError(`Unknown action "${action}".`);
    }
  }

  /**
   * Adding a shell from the shells page: first a preview (what gets shell
   * rights, what its server runs), then, with the preview's token, the shell
   * goes in $PLUTO_HOME/shells, on, at the end of the list. The switcher
   * adds it to the browser's list the next time it's open.
   */
  add(body: Record<string, unknown>): unknown {
    if (typeof body.token === "string") {
      const preview = this.previews.get(body.token);
      if (!preview) throw new ShellError("That preview is gone: look again.");
      this.previews.delete(body.token);
      const name = addShell(this.home, preview);
      const list = effectiveList(this.home).filter((entry) => entry.name !== name);
      writeList(this.home, [...list, { name, enabled: true }]);
      this.pendingAdd.add(name);
      this.watchFolder(name);
      return this.status().find((shell) => shell.name === name);
    }
    if (typeof body.source !== "string" || !body.source.trim()) throw new ShellError("Nothing to add.");
    const preview = previewShell(this.home, body.source, this.context);
    const token = randomUUID();
    this.previews.set(token, preview);
    setTimeout(() => {
      if (this.previews.get(token) !== preview) return;
      this.previews.delete(token);
      if (preview.staged) rmSync(preview.staged, { recursive: true, force: true });
    }, 15 * 60_000).unref();
    const { staged: _staged, ...shown } = preview;
    return { ...shown, token };
  }

  /** Text: the log, the history, the failed change's diff. */
  text(name: string, what: string): string {
    const shell = this.installed(name);
    switch (what) {
      case "log": {
        const file = logPath(this.home, name);
        try {
          const size = statSync(file).size;
          const text = readFileSync(file, "utf8");
          return size > 64 * 1024 ? text.slice(-64 * 1024) : text;
        } catch {
          return "";
        }
      }
      case "history":
        return git(shell.dir, ["log", "-n", "50", "--format=%h  %ad  %s", "--date=format:%Y-%m-%d %H:%M"]);
      case "diff": {
        const failed = this.failedCommit(shell.dir);
        return failed
          ? git(shell.dir, ["diff", this.goodCommit(shell.dir), failed.commit])
          : git(shell.dir, ["diff", this.goodCommit(shell.dir), "HEAD"]);
      }
      default:
        throw new ShellError(`Unknown "${what}".`);
    }
  }

  private agentPrompt(shell: InstalledShell): string {
    const docs = join(this.context.plutonium, "docs", "features", "SHELL_PACKAGES.md");
    const library = join(this.context.plutonium, "helper", "README.md");
    return [
      `You're helping me customize my Plutonium shell "${shell.manifest?.title ?? shell.name}", in this folder (${shell.dir}).`,
      `It's a git repository; shell.json is its manifest (${docs}). The shell library and the helper's API are in ${library}.`,
      `Every save here is committed and reloads the shell. If the shell doesn't connect to the helper within ${CONNECT_TIMEOUT_MS / 1000} s, it's rolled back to the last version that worked, and I'm told.`,
      `Ask me what I'd like to change.`,
    ].join("\n");
  }
}
