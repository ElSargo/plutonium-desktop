// plutoniumd: the frontend-neutral side of a Plutonium shell.
//
// - Threads: the environment for a thread's processes (Exo display, thread tag,
//   per-thread X display) and pid → thread resolution for windows.
// - Launching apps into a thread.
// - The agent bridge: a thread's agent lists, launches, focuses, snapshots and
//   closes its own windows, and opens, drives, snapshots and closes its own
//   browser tabs, relayed through the shell page.
// - Server-driven tabs: a frontend's server drives the tabs the shell shows for
//   it over the browser's DevTools protocol (serverTabs.ts).
//
// Two listeners:
// - A Unix socket (mode 0600, in $XDG_RUNTIME_DIR) for local processes: the
//   frontend's server, and agents through `plutonium mcp`.
// - 127.0.0.1:<port> for the shell page. Only requests from this user (checked
//   in /proc/net/tcp) whose Origin is the shell origin get past the library
//   download.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DesktopApps } from "./apps.ts";
import { BrowserCdp } from "./cdp.ts";
import { type GpuReport, probeGpu } from "./gpu.ts";
import {
  type BrowserTabEntry,
  type ItemGroup,
  RelayError,
  ShellRelay,
  type NativeWindowEntry,
} from "./relay.ts";
import { installOpeners, openerEnvironment } from "./opener.ts";
import { ServerTabs } from "./serverTabs.ts";
import { threadForPid, threadsForPids, Threads } from "./threads.ts";

export interface DaemonOptions {
  readonly waylandDisplay: string;
  /** The shells' origins (several in a session with more than one shell). */
  readonly shellOrigins: readonly string[];
  readonly port: number;
  readonly socketPath: string;
  /** The browser's --remote-debugging-port, for server-driven tabs (none: no such tabs). */
  readonly cdpPort?: number | undefined;
}

const HELPER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHELL_LIBRARY = join(HELPER_ROOT, "web", "plutonium-shell.js");
const CLI = join(HELPER_ROOT, "plutonium.ts");
const MAX_BODY = 1 << 26;
// How long a group list from the browser is used for routing.
const GROUPS_TTL_MS = 2_000;

const runtimeDir = () => process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`;

export function defaultSocketPath(waylandDisplay: string): string {
  return join(runtimeDir(), "plutonium", `${waylandDisplay}.sock`);
}

/** A window as agents see it. */
export interface ThreadWindow {
  readonly id: number;
  readonly title: string;
  readonly appId: string;
  readonly width: number;
  readonly height: number;
  /** Whether the shell shows it right now (e.g. in a tab). */
  readonly shown: boolean;
  readonly focused: boolean;
}

function threadWindow(entry: NativeWindowEntry): ThreadWindow {
  return {
    id: entry.id,
    title: entry.title,
    appId: entry.appId,
    width: entry.width,
    height: entry.height,
    shown: entry.embedded,
    focused: entry.focused,
  };
}

/** A browser tab as agents see it. */
export interface ThreadTab {
  readonly id: number;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  /** Whether the shell shows it right now. */
  readonly shown: boolean;
  readonly focused: boolean;
  /** The tab whose page opened it (0: the shell or an agent did). */
  readonly openerId: number;
  /** A dialog the page waits on (answer it with answer_dialog). */
  readonly dialog?: { readonly type: string; readonly message: string; readonly defaultPrompt?: string };
}

function threadTab(entry: BrowserTabEntry): ThreadTab {
  return {
    id: entry.id,
    url: entry.url,
    title: entry.title,
    loading: entry.loading,
    canGoBack: entry.canGoBack,
    canGoForward: entry.canGoForward,
    shown: entry.embedded,
    focused: entry.focused,
    openerId: entry.openerId,
    ...(entry.dialogType
      ? {
          dialog: {
            type: entry.dialogType,
            message: entry.dialogMessage,
            ...(entry.dialogType === "prompt" ? { defaultPrompt: entry.dialogDefaultPrompt } : {}),
          },
        }
      : {}),
  };
}

export const TAB_COMMANDS = ["back", "forward", "reload", "stop"] as const;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A request's waitMs: up to 60 s, default 0. */
function waitMsOf(value: unknown): number {
  return typeof value === "number" && value > 0 ? Math.min(value, 60_000) : 0;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The uid owning the local end of a loopback TCP connection, from the kernel's
// socket table (the peer is on this host: we only listen on 127.0.0.1).
function loopbackPeerUid(peerPort: number, ourPort: number): number | undefined {
  const hex = (port: number) => port.toString(16).toUpperCase().padStart(4, "0");
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let lines: string[];
    try {
      lines = readFileSync(table, "latin1").split("\n").slice(1);
    } catch {
      continue;
    }
    for (const line of lines) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 8) continue;
      if (fields[1]?.endsWith(`:${hex(peerPort)}`) && fields[2]?.endsWith(`:${hex(ourPort)}`)) {
        return Number(fields[7]);
      }
    }
  }
  return undefined;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "Too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => resolve(Buffer.concat(chunks)));
    request.once("error", reject);
  });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(request);
  try {
    const value = JSON.parse(body.toString("utf8") || "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
    // Below.
  }
  throw new HttpError(400, "Expected a JSON object.");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

/** An http(s) origin as browsers send it ("http://127.0.0.1:3774"). */
function isOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

function pidsParameter(url: URL): number[] {
  return (url.searchParams.get("pids") ?? "")
    .split(",")
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 1);
}

export class Daemon {
  readonly options: DaemonOptions;
  readonly threads: Threads;
  readonly relay = new ShellRelay();
  readonly apps = new DesktopApps();
  readonly serverTabs: ServerTabs | null;
  private readonly servers: Server[] = [];
  private groupsCache: { at: number; groups: Promise<ItemGroup[]> } | null = null;
  /** Shell origins a shell page reported (shells added in the browser at runtime). */
  private reportedOrigins = new Set<string>();
  /** gpu.ts's answer for the Exo instance behind the socket's inode. */
  private gpuProbe: { inode: number; report: Promise<GpuReport> } | null = null;

  constructor(options: DaemonOptions) {
    this.options = options;
    this.threads = new Threads(options.waylandDisplay, options.socketPath);
    this.serverTabs = options.cdpPort ? new ServerTabs(new BrowserCdp(options.cdpPort)) : null;
    if (this.serverTabs) {
      const serverTabs = this.serverTabs;
      this.relay.onDisconnect = (page) => serverTabs.detachPage(page);
      serverTabs.onPointer = (page, pointer) => this.relay.notify(page, "pointer", { ...pointer });
      serverTabs.onOrphaned = (key) => this.relay.notifyAll("server_tab_orphaned", { ...key });
    }
    // Links a thread's apps open become tabs in the thread (opener.ts).
    try {
      const openers = installOpeners(join(dirname(options.socketPath), "open"), process.execPath, CLI);
      this.threads.openerVariables = openerEnvironment(openers);
    } catch (error) {
      console.error(`plutoniumd: no link openers: ${(error as Error).message}`);
    }
  }

  /** Whether apps on Exo can find the GPU; null while Exo isn't up. */
  async gpu(): Promise<GpuReport | null> {
    const exoSocket = join(runtimeDir(), this.options.waylandDisplay);
    let inode: number;
    try {
      inode = statSync(exoSocket).ino;
    } catch {
      return null;
    }
    if (this.gpuProbe?.inode !== inode) {
      const report = probeGpu(exoSocket);
      this.gpuProbe = { inode, report };
      report.then(
        (gpu) => {
          if (gpu.accelerated) return;
          console.warn(
            `plutoniumd: WARNING: ${this.options.waylandDisplay} names no GPU to apps ` +
              `(zwp_linux_dmabuf_v1 ${gpu.dmabufVersion ? `v${gpu.dmabufVersion} without a GPU device` : "missing"}), ` +
              "so GL apps render in software (llvmpipe). Ash on X11 needs " +
              "--enable-native-gpu-memory-buffers --enable-features=Vulkan; Xvfb has no GPU at all.",
          );
        },
        () => {
          if (this.gpuProbe?.report === report) this.gpuProbe = null;
        },
      );
    }
    return this.gpuProbe.report.catch(() => null);
  }

  // Threads and windows.
  //
  // An item belongs to every thread whose tag it carries: the thread that
  // started it (its origin tag) and any a shell added it to. A thread's id is
  // its tag (t3:thread/<id>, plain:thread/<id>; see docs/SHELLS.md).

  /** The thread's windows, oldest first. */
  async threadWindows(threadId: string): Promise<NativeWindowEntry[]> {
    const windows = await this.relay.windows();
    return windows
      .filter((entry) => (entry.tags ? entry.tags.includes(threadId) : threadForPid(entry.pid) === threadId))
      .sort((a, b) => a.id - b.id);
  }

  private isShellOrigin(origin: string): boolean {
    return this.options.shellOrigins.includes(origin) || this.reportedOrigins.has(origin);
  }

  /** The shell that owns `threadId`'s group, if one says it does. */
  private async ownerOf(threadId: string): Promise<string | undefined> {
    if (!this.groupsCache || Date.now() - this.groupsCache.at > GROUPS_TTL_MS) {
      const groups = this.relay.groups().catch(() => []);
      this.groupsCache = { at: Date.now(), groups };
    }
    const groups = await this.groupsCache.groups;
    return groups.find((group) => group.tag === threadId)?.shellId || undefined;
  }

  /** Asks the shell that owns `threadId` (else the visible one). */
  private async ask<T>(threadId: string, op: string, args: Record<string, unknown>): Promise<T> {
    return this.relay.json<T>(op, args, await this.ownerOf(threadId));
  }

  private async askRaw(threadId: string, op: string, args: Record<string, unknown>, timeoutMs: number) {
    return this.relay.request(op, args, timeoutMs, await this.ownerOf(threadId));
  }

  /** `windowId` if it belongs to `threadId`; agents only reach their own windows. */
  private async ownedWindow(threadId: string, windowId: number): Promise<NativeWindowEntry> {
    const entry = (await this.threadWindows(threadId)).find((window) => window.id === windowId);
    if (!entry) throw new HttpError(404, `This thread has no window ${windowId}.`);
    return entry;
  }

  /**
   * Starts `argv` as one of the thread's processes. With `waitMs`, waits that
   * long for the thread's first new window(s).
   */
  async launch(
    threadId: string,
    argv: readonly string[],
    cwd: string | undefined,
    waitMs: number,
  ): Promise<{ pid: number; windows: ThreadWindow[] }> {
    const before = this.relay.connected
      ? new Set((await this.threadWindows(threadId)).map((entry) => entry.id))
      : undefined;
    void this.gpu();
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: cwd || process.env.HOME,
      env: { ...process.env, ...this.threads.environment(threadId) },
      detached: true,
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (error) => reject(new HttpError(400, `Could not start ${argv[0]}: ${error.message}`)));
    });
    child.unref();
    const pid = child.pid ?? 0;
    if (!before || waitMs <= 0) return { pid, windows: [] };
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await sleep(200);
      const fresh = (await this.threadWindows(threadId)).filter((entry) => !before.has(entry.id));
      if (fresh.length > 0) {
        // Apps often map a second window (a dialog, a splash) right after.
        await sleep(300);
        const settled = (await this.threadWindows(threadId)).filter((entry) => !before.has(entry.id));
        return { pid, windows: settled.map(threadWindow) };
      }
      if (child.exitCode !== null && child.exitCode !== 0) break;
    }
    return { pid, windows: [] };
  }

  /** Asks the frontend to show the window to the user (it pops it out if the frontend can't). */
  async focus(threadId: string, windowId: number): Promise<{ how: string }> {
    await this.ownedWindow(threadId, windowId);
    return this.ask<{ how: string }>(threadId, "focus", { windowId, threadId });
  }

  /** Asks the app to close the window; waits up to `waitMs` for it to go. */
  async close(threadId: string, windowId: number, waitMs = 3_000): Promise<{ closed: boolean }> {
    await this.ownedWindow(threadId, windowId);
    await this.ask(threadId, "close", { windowId });
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await sleep(150);
      if (!(await this.relay.windows()).some((entry) => entry.id === windowId)) return { closed: true };
    }
    return { closed: false };
  }

  async snapshot(threadId: string, windowId: number): Promise<Buffer> {
    await this.ownedWindow(threadId, windowId);
    const reply = await this.askRaw(threadId, "snapshot", { windowId }, 10_000);
    if (reply.kind !== "png") throw new HttpError(502, "The shell did not send an image.");
    return reply.data;
  }

  // Browser tabs, by tag as windows.

  /** The thread's tabs, oldest first. */
  async threadTabs(threadId: string): Promise<BrowserTabEntry[]> {
    return (await this.relay.tabs())
      .filter((tab) => (tab.tags ?? [tab.tag]).includes(threadId))
      .sort((a, b) => a.id - b.id);
  }

  private async ownedTab(threadId: string, tabId: number): Promise<BrowserTabEntry> {
    const tab = (await this.threadTabs(threadId)).find((entry) => entry.id === tabId);
    if (!tab) throw new HttpError(404, `This thread has no tab ${tabId}.`);
    return tab;
  }

  /** Opens a tab for the thread; with `waitMs`, waits that long for it to load. */
  async openTab(threadId: string, url: string, focus: boolean, waitMs: number): Promise<ThreadTab> {
    const tab = await this.ask<BrowserTabEntry>(threadId, "open_tab", { threadId, url });
    if (focus) await this.ask(threadId, "focus_tab", { tabId: tab.id }).catch(() => {});
    return threadTab(await this.waitForLoad(threadId, tab.id, waitMs));
  }

  async navigateTab(threadId: string, tabId: number, url: string, waitMs: number): Promise<ThreadTab> {
    await this.ownedTab(threadId, tabId);
    await this.ask(threadId, "navigate_tab", { tabId, url });
    return threadTab(await this.waitForLoad(threadId, tabId, waitMs));
  }

  async tabCommand(threadId: string, tabId: number, command: string, waitMs: number): Promise<ThreadTab> {
    await this.ownedTab(threadId, tabId);
    await this.ask(threadId, "tab_command", { tabId, command });
    return threadTab(await this.waitForLoad(threadId, tabId, waitMs));
  }

  async closeTab(threadId: string, tabId: number): Promise<{ closed: boolean }> {
    await this.ownedTab(threadId, tabId);
    await this.ask(threadId, "tab_command", { tabId, command: "close" });
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      if (!(await this.relay.tabs()).some((tab) => tab.id === tabId)) return { closed: true };
    }
    return { closed: false };
  }

  async answerDialog(threadId: string, tabId: number, accept: boolean, text: string): Promise<ThreadTab> {
    const tab = await this.ownedTab(threadId, tabId);
    if (!tab.dialogType) throw new HttpError(409, `Tab ${tabId} has no dialog open.`);
    await this.ask(threadId, "answer_dialog", { tabId, accept, text });
    await sleep(150);
    return threadTab(await this.ownedTab(threadId, tabId));
  }

  async focusTab(threadId: string, tabId: number): Promise<{ how: string }> {
    await this.ownedTab(threadId, tabId);
    return this.ask<{ how: string }>(threadId, "focus_tab", { tabId });
  }

  async snapshotTab(threadId: string, tabId: number): Promise<Buffer> {
    await this.ownedTab(threadId, tabId);
    const reply = await this.askRaw(threadId, "snapshot_tab", { tabId }, 10_000);
    if (reply.kind !== "png") throw new HttpError(502, "The shell did not send an image.");
    return reply.data;
  }

  // A navigation starts asynchronously: give it a moment to begin, then wait
  // for it to stop loading (or the time to run out).
  private async waitForLoad(threadId: string, tabId: number, waitMs: number): Promise<BrowserTabEntry> {
    const deadline = Date.now() + waitMs;
    let tab = await this.ownedTab(threadId, tabId);
    if (waitMs <= 0) return tab;
    await sleep(Math.min(300, waitMs));
    while (true) {
      tab = await this.ownedTab(threadId, tabId);
      if (!tab.loading || Date.now() >= deadline) return tab;
      await sleep(200);
    }
  }

  /** What a frontend's server adds to a thread's agents and terminals. */
  threadSetup(threadId: string) {
    return {
      env: this.threads.environment(threadId),
      // The agent bridge, for agents that take MCP servers.
      mcpServer: { command: process.execPath, args: [CLI, "mcp"] },
    };
  }

  // HTTP.

  private async handle(request: IncomingMessage, response: ServerResponse, local: boolean): Promise<void> {
    const url = new URL(request.url ?? "/", "http://plutonium");
    const method = request.method ?? "GET";
    const path = url.pathname;

    if (!local) {
      // The shell library is public: any page may load it, only the shell can use it.
      if (method === "GET" && path === "/v1/shell.js") {
        response.writeHead(200, {
          "Content-Type": "text/javascript",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache",
        });
        response.end(readFileSync(SHELL_LIBRARY));
        return;
      }
      const origin = request.headers.origin;
      const uid = loopbackPeerUid(request.socket.remotePort ?? 0, this.options.port);
      if (!origin || !this.isShellOrigin(origin) || uid !== process.getuid?.()) {
        throw new HttpError(403, "Only the Plutonium shell may use this.");
      }
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
      if (method === "OPTIONS") {
        response.writeHead(204, {
          "Access-Control-Allow-Methods": "GET, POST",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "600",
        });
        response.end();
        return;
      }
      if (method === "GET" && path === "/v1/shell/requests") {
        const key = url.searchParams.get("page") || `anonymous-${origin}`;
        this.relay.attach(
          response,
          key,
          origin,
          url.searchParams.get("shell") ?? "",
          url.searchParams.get("visible") !== "0",
        );
        return;
      }
      const visibility = path.match(/^\/v1\/shell\/pages\/([\w-]+)\/visibility$/);
      if (method === "POST" && visibility) {
        const { visible } = JSON.parse((await readBody(request)).toString("utf8") || "{}") as { visible?: boolean };
        const found = this.relay.setVisible(visibility[1]!, visible !== false);
        response.writeHead(found ? 204 : 404).end();
        return;
      }
      if (method === "POST" && path === "/v1/shell/origins") {
        // The browser's shells, from a page that is already a shell: what
        // the shells overlay added or removed.
        const { origins } = await readJson(request);
        if (!Array.isArray(origins)) throw new HttpError(400, "origins must be an array.");
        this.reportedOrigins = new Set(origins.filter(isOrigin));
        response.writeHead(204).end();
        return;
      }
      if (method === "POST" && (path === "/v1/shell/server-tabs" || path === "/v1/shell/server-tabs/detach")) {
        if (!this.serverTabs) throw new HttpError(409, "This helper has no DevTools port (--cdp-port).");
        const { page, threadId, tabId, targetId, browserTabId, url, title } = await readJson(request);
        if (typeof threadId !== "string" || !threadId || typeof tabId !== "string" || !tabId) {
          throw new HttpError(400, "threadId and tabId are required.");
        }
        if (typeof page !== "string" || !page) throw new HttpError(400, "page is required.");
        if (path.endsWith("/detach")) {
          this.serverTabs.detach({ threadId, tabId }, page);
          response.writeHead(204).end();
          return;
        }
        if (!this.relay.has(page)) throw new HttpError(400, "page must be connected.");
        if (typeof targetId !== "string" || !targetId) throw new HttpError(400, "targetId is required.");
        if (typeof browserTabId !== "number") throw new HttpError(400, "browserTabId is required.");
        const shown = { url: typeof url === "string" ? url : "", title: typeof title === "string" ? title : "" };
        const shownTabId = this.serverTabs.attach(
          { threadId, tabId },
          { targetId, browserTabId, page, url: () => shown.url, title: () => shown.title },
          (other) => this.relay.has(other),
        );
        return sendJson(response, 200, { browserTabId: shownTabId });
      }
      const reply = path.match(/^\/v1\/shell\/replies\/(\w+)$/);
      if (method === "POST" && reply) {
        const body = await readBody(request);
        const found = this.relay.reply(reply[1]!, request.headers["content-type"] ?? "", body);
        response.writeHead(found ? 204 : 404).end();
        return;
      }
    }

    // Shared by the shell and local processes.
    if (method === "GET" && path === "/v1/status") {
      return sendJson(response, 200, {
        waylandDisplay: this.options.waylandDisplay,
        shellOrigins: [...new Set([...this.options.shellOrigins, ...this.reportedOrigins])],
        shellConnected: this.relay.connected,
        shells: this.relay.shells(),
        serverTabs: this.serverTabs !== null,
        gpu: await this.gpu(),
      });
    }
    if (method === "GET" && path === "/v1/window-threads") {
      return sendJson(response, 200, threadsForPids(pidsParameter(url)));
    }
    if (method === "GET" && path === "/v1/thread-setup") {
      const thread = url.searchParams.get("thread");
      if (!thread) throw new HttpError(400, "thread is required.");
      return sendJson(response, 200, this.threadSetup(thread));
    }
    if (method === "GET" && path === "/v1/apps") {
      return sendJson(response, 200, this.apps.list());
    }
    const icon = path.match(/^\/v1\/apps\/([^/]+)\/icon$/);
    if (method === "GET" && icon) {
      const found = this.apps.icon(decodeURIComponent(icon[1]!));
      if (!found) throw new HttpError(404, "No icon.");
      response.writeHead(200, { "Content-Type": found.contentType, "Cache-Control": "max-age=3600" });
      response.end(found.data);
      return;
    }
    if (method === "POST" && path === "/v1/apps/launch") {
      const { thread, id, waitMs } = await readJson(request);
      if (typeof thread !== "string" || !thread) throw new HttpError(400, "thread is required.");
      if (typeof id !== "string" || !id) throw new HttpError(400, "id is required.");
      let command;
      try {
        command = this.apps.command(id);
      } catch (error) {
        throw new HttpError(400, (error as Error).message);
      }
      if (!command) throw new HttpError(404, `No app ${id}.`);
      console.log(`plutoniumd: launching ${command.name} (${command.argv.join(" ")}) in thread ${thread}`);
      return sendJson(
        response,
        200,
        await this.launch(thread, command.argv, command.cwd, waitMsOf(waitMs)),
      );
    }
    if (method === "POST" && path === "/v1/launch") {
      const body = await readJson(request);
      const { thread, argv, cwd, waitMs } = body;
      if (typeof thread !== "string" || !thread) throw new HttpError(400, "thread is required.");
      if (!Array.isArray(argv) || argv.length === 0 || !argv.every((arg) => typeof arg === "string")) {
        throw new HttpError(400, "argv must be a non-empty array of strings.");
      }
      return sendJson(
        response,
        200,
        await this.launch(
          thread,
          argv,
          typeof cwd === "string" ? cwd : undefined,
          typeof waitMs === "number" ? Math.min(waitMs, 60_000) : 0,
        ),
      );
    }

    if (local) {
      const tabs = path.match(/^\/v1\/threads\/([^/]+)\/tabs$/);
      if (tabs) {
        const threadId = decodeURIComponent(tabs[1]!);
        if (method === "GET") return sendJson(response, 200, (await this.threadTabs(threadId)).map(threadTab));
        if (method === "POST") {
          const { url, focus, waitMs } = await readJson(request);
          if (typeof url !== "string" || !url) throw new HttpError(400, "url is required.");
          return sendJson(
            response,
            200,
            await this.openTab(threadId, url, focus !== false, waitMsOf(waitMs)),
          );
        }
      }
      const tabAction = path.match(/^\/v1\/threads\/([^/]+)\/tabs\/(\d+)\/(\w+)$/);
      if (tabAction) {
        const threadId = decodeURIComponent(tabAction[1]!);
        const tabId = Number(tabAction[2]);
        const what = tabAction[3]!;
        if (method === "GET" && what === "snapshot") {
          const png = await this.snapshotTab(threadId, tabId);
          response.writeHead(200, { "Content-Type": "image/png" });
          response.end(png);
          return;
        }
        if (method === "POST") {
          const body = await readJson(request);
          if (what === "navigate") {
            if (typeof body.url !== "string" || !body.url) throw new HttpError(400, "url is required.");
            return sendJson(response, 200, await this.navigateTab(threadId, tabId, body.url, waitMsOf(body.waitMs)));
          }
          if ((TAB_COMMANDS as readonly string[]).includes(what)) {
            return sendJson(response, 200, await this.tabCommand(threadId, tabId, what, waitMsOf(body.waitMs)));
          }
          if (what === "focus") return sendJson(response, 200, await this.focusTab(threadId, tabId));
          if (what === "dialog") {
            return sendJson(
              response,
              200,
              await this.answerDialog(
                threadId,
                tabId,
                body.accept !== false,
                typeof body.text === "string" ? body.text : "",
              ),
            );
          }
          if (what === "close") return sendJson(response, 200, await this.closeTab(threadId, tabId));
        }
      }
      const windows = path.match(/^\/v1\/threads\/([^/]+)\/windows$/);
      if (method === "GET" && windows) {
        const threadId = decodeURIComponent(windows[1]!);
        return sendJson(response, 200, (await this.threadWindows(threadId)).map(threadWindow));
      }
      const action = path.match(/^\/v1\/threads\/([^/]+)\/windows\/(\d+)\/(focus|close|snapshot)$/);
      if (action) {
        const threadId = decodeURIComponent(action[1]!);
        const windowId = Number(action[2]);
        if (method === "GET" && action[3] === "snapshot") {
          const png = await this.snapshot(threadId, windowId);
          response.writeHead(200, { "Content-Type": "image/png" });
          response.end(png);
          return;
        }
        if (method === "POST" && action[3] === "focus") {
          return sendJson(response, 200, await this.focus(threadId, windowId));
        }
        if (method === "POST" && action[3] === "close") {
          return sendJson(response, 200, await this.close(threadId, windowId));
        }
      }
    }
    throw new HttpError(404, "Not found.");
  }

  private serve(local: boolean): Server {
    const server = createServer((request, response) => {
      this.handle(request, response, local).catch((error: unknown) => {
        const status = error instanceof HttpError || error instanceof RelayError ? error.status : 500;
        if (status === 500) console.error(error);
        if (!response.headersSent) sendJson(response, status, { error: (error as Error).message });
        else response.end();
      });
    });
    if (local) server.on("upgrade", (request, socket, head) => this.upgrade(request, socket as Socket, head));
    this.servers.push(server);
    return server;
  }

  // `GET /v1/desktop-browser` with `Upgrade: plutonium-desktop-browser`, on the
  // socket: the frontend server's connection for server-driven tabs.
  private upgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    const path = new URL(request.url ?? "/", "http://plutonium").pathname;
    if (path !== "/v1/desktop-browser" || !this.serverTabs) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: plutonium-desktop-browser\r\nConnection: Upgrade\r\n\r\n",
    );
    if (head.length > 0) socket.unshift(head);
    this.serverTabs.serve(socket);
  }

  async start(): Promise<void> {
    const { socketPath, port } = this.options;
    mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
    if (existsSync(socketPath)) {
      const live = await new Promise<boolean>((resolve) => {
        const probe = connect(socketPath, () => {
          probe.end();
          resolve(true);
        });
        probe.once("error", () => resolve(false));
      });
      if (live) throw new Error(`Another helper is already listening on ${socketPath}.`);
      unlinkSync(socketPath);
    }
    await new Promise<void>((resolve, reject) => {
      this.serve(true).once("error", reject).listen(socketPath, resolve);
    });
    chmodSync(socketPath, 0o600);
    await new Promise<void>((resolve, reject) => {
      this.serve(false).once("error", reject).listen(port, "127.0.0.1", resolve);
    });
    console.log(
      `plutoniumd: ${this.options.waylandDisplay}, shells ${this.options.shellOrigins.join(" ")}, ` +
        `socket ${socketPath}, shell API http://127.0.0.1:${port}` +
        (this.options.cdpPort ? `, server-driven tabs on DevTools ${this.options.cdpPort}` : ""),
    );
    // Ash usually starts after the helper: check the GPU once Exo is up.
    const check = setInterval(() => {
      void this.gpu().then((gpu) => gpu && clearInterval(check));
    }, 2000);
    setTimeout(() => clearInterval(check), 120_000).unref();
    check.unref();
  }

  stop(): void {
    for (const server of this.servers) server.close();
    this.threads.shutdown();
    try {
      unlinkSync(this.options.socketPath);
    } catch {
      // Gone.
    }
  }
}
