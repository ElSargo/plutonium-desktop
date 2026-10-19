// plutoniumd: the frontend-neutral side of a Plutonium shell.
//
// - Threads: the environment for a thread's processes (Exo display, thread tag,
//   per-thread X display) and pid → thread resolution for windows.
// - Launching apps into a thread.
// - The agent bridge: a thread's agent lists, launches, focuses, snapshots,
//   types and clicks into, and closes its own windows, and opens, drives
//   (Playwright, pages.ts), snapshots and closes its own browser tabs. With the
//   browser's DevTools port (--cdp-port), straight from the browser
//   (desktop.ts); without, or with a browser from before its Plutonium domain,
//   relayed through the shell page. Showing things to the user is always the
//   shell's.
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
import { Desktop, type DesktopTab, type DesktopWindow } from "./desktop.ts";
import { type GpuReport, probeGpu } from "./gpu.ts";
import {
  type BrowserTabEntry,
  type ItemGroup,
  RelayError,
  ShellRelay,
  type NativeWindowEntry,
} from "./relay.ts";
import { comboKeys, textKeys } from "./keys.ts";
import { installOpeners, openerEnvironment } from "./opener.ts";
import { ThreadPages } from "./pages.ts";
import { callTool, mcpTools } from "./mcp.ts";
import { HELPER_PAGE, ServerTabs } from "./serverTabs.ts";
import { TERMINAL_THREAD, Terminals } from "./terminal.ts";
import { showsForPids, threadForPid, threadsForPids, Threads } from "./threads.ts";

export interface DaemonOptions {
  readonly waylandDisplay: string;
  /** The shells' origins (several in a session with more than one shell). */
  readonly shellOrigins: readonly string[];
  readonly port: number;
  readonly socketPath: string;
  /**
   * The browser's --remote-debugging-port: windows and tabs straight from the
   * browser, agents' page automation, and server-driven tabs (none: the shell
   * relays what it can, and there are no such tabs).
   */
  readonly cdpPort?: number | undefined;
}

const HELPER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// A session serves the live one (`plutonium live`), read on every request.
const SHELL_LIBRARY =
  process.env.PLUTONIUM_SHELL_LIBRARY || join(HELPER_ROOT, "web", "plutonium-shell.js");
const CLI = join(HELPER_ROOT, "plutonium.ts");
// The backup terminal's page (terminal.ts), public like the shell library.
const TERMINAL_FILES: Record<string, readonly [string, string]> = {
  "/v1/terminal/": [join(HELPER_ROOT, "web", "terminal", "index.html"), "text/html; charset=utf-8"],
  "/v1/terminal/terminal.js": [join(HELPER_ROOT, "web", "terminal", "terminal.js"), "text/javascript"],
  "/v1/terminal/terminal.css": [join(HELPER_ROOT, "web", "terminal", "terminal.css"), "text/css"],
  "/v1/terminal/xterm.js": [join(HELPER_ROOT, "web", "vendor", "xterm", "xterm.js"), "text/javascript"],
  "/v1/terminal/xterm.css": [join(HELPER_ROOT, "web", "vendor", "xterm", "xterm.css"), "text/css"],
  "/v1/terminal/addon-fit.js": [join(HELPER_ROOT, "web", "vendor", "xterm", "addon-fit.js"), "text/javascript"],
};
const MAX_BODY = 1 << 26;
// How long a group list from the browser is used for routing.
const GROUPS_TTL_MS = 2_000;
// How long a window snapshot waits after input, for the app to draw.
const INPUT_SETTLE_MS = 200;
// How long a window an agent drove stays at full frame rate (setWindowAwake).
const AWAKE_MS = 60_000;

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

/** A window from the browser, as the shell relay reports one. */
function windowEntry(window: DesktopWindow): NativeWindowEntry {
  return { ...window, tag: window.tags[0] ?? "" };
}

/** A tab from the browser, as the shell relay reports one. */
function tabEntry(tab: DesktopTab): BrowserTabEntry {
  return {
    ...tab,
    contentId: "",
    tag: tab.tags[0] ?? "",
    dialogType: tab.dialogType ?? "",
    dialogMessage: tab.dialogMessage ?? "",
    dialogDefaultPrompt: tab.dialogDefaultPrompt ?? "",
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

// type_window: key events per batch, and the pause between batches.
const TYPE_BATCH = 64;
const TYPE_BATCH_GAP_MS = 25;

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

/** An http(s) origin as browsers send it ("http://127.0.0.1:3773"). */
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
  readonly terminals: Terminals;
  readonly serverTabs: ServerTabs | null;
  /** The browser's windows and tabs, if it has the Plutonium DevTools domain. */
  readonly desktop: Desktop | null;
  readonly pages: ThreadPages | null;
  /** When each window last got input (windowInput). */
  private readonly lastInput = new Map<number, number>();
  /** Windows kept awake after input, with the timer that lets them sleep. */
  private readonly awakeWindows = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly servers: Server[] = [];
  private groupsCache: { at: number; groups: Promise<ItemGroup[]> } | null = null;
  /** Shell origins a shell page reported (shells added in the browser at runtime). */
  private reportedOrigins = new Set<string>();
  /** gpu.ts's answer for the Exo instance behind the socket's inode. */
  private gpuProbe: { inode: number; report: Promise<GpuReport> } | null = null;

  constructor(options: DaemonOptions) {
    this.options = options;
    this.threads = new Threads(options.waylandDisplay, options.socketPath);
    this.terminals = new Terminals(() => ({
      ...process.env,
      // Typed in by the user: what it starts is shown.
      ...this.threads.environment(TERMINAL_THREAD, { show: true }),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    }));
    const cdp = options.cdpPort ? new BrowserCdp(options.cdpPort) : null;
    this.serverTabs = cdp ? new ServerTabs(cdp) : null;
    this.desktop = cdp ? new Desktop(cdp) : null;
    this.pages = cdp && this.desktop ? new ThreadPages(cdp, this.desktop) : null;
    if (this.serverTabs) {
      const serverTabs = this.serverTabs;
      this.relay.onDisconnect = (page) => serverTabs.detachPage(page);
      serverTabs.onPointer = (page, pointer) =>
        // A tab the helper opened: whichever page shows it draws the cursor.
        page === HELPER_PAGE
          ? this.relay.notifyAll("pointer", { ...pointer })
          : this.relay.notify(page, "pointer", { ...pointer });
      serverTabs.onOrphaned = (key) => this.relay.notifyAll("server_tab_orphaned", { ...key });
      if (this.desktop) this.openServerTabs(serverTabs, this.desktop);
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

  /** The browser's Plutonium domain, if it has one (else ask the shell). */
  private async direct(): Promise<Desktop | null> {
    return this.desktop && (await this.desktop.available()) ? this.desktop : null;
  }

  /** The direct way, or an error naming what's missing. */
  private async requireDirect(what: string): Promise<Desktop> {
    const desktop = await this.direct();
    if (!desktop) {
      throw new HttpError(
        501,
        `${what} needs the browser's Plutonium DevTools domain (a newer Plutonium Chromium, ` +
          "and a helper started with --cdp-port).",
      );
    }
    return desktop;
  }

  private async allWindows(): Promise<NativeWindowEntry[]> {
    const desktop = await this.direct();
    return desktop ? desktop.windows().map(windowEntry) : this.relay.windows();
  }

  private async allTabs(): Promise<BrowserTabEntry[]> {
    const desktop = await this.direct();
    return desktop ? desktop.tabs().map(tabEntry) : this.relay.tabs();
  }

  /** The thread's windows, oldest first. */
  async threadWindows(threadId: string): Promise<NativeWindowEntry[]> {
    const windows = await this.allWindows();
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
   * long for the thread's first new window(s). With `show`, the shell brings
   * its windows to the front (PLUTONIUM_SHOW).
   */
  async launch(
    threadId: string,
    argv: readonly string[],
    cwd: string | undefined,
    waitMs: number,
    show = false,
  ): Promise<{ pid: number; windows: ThreadWindow[] }> {
    const before =
      this.relay.connected || (await this.direct())
      ? new Set((await this.threadWindows(threadId)).map((entry) => entry.id))
      : undefined;
    void this.gpu();
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: cwd || process.env.HOME,
      env: { ...process.env, ...this.threads.environment(threadId, { show }) },
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
    const desktop = await this.direct();
    if (desktop) await desktop.closeWindow(windowId);
    else await this.ask(threadId, "close", { windowId });
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await sleep(150);
      if (!(await this.allWindows()).some((entry) => entry.id === windowId)) return { closed: true };
    }
    return { closed: false };
  }

  async snapshot(threadId: string, windowId: number): Promise<Buffer> {
    await this.ownedWindow(threadId, windowId);
    const desktop = await this.direct();
    if (desktop) {
      // Right after input the app may not have drawn its answer yet.
      const settle = (this.lastInput.get(windowId) ?? 0) + INPUT_SETTLE_MS - Date.now();
      if (settle > 0) await new Promise((resolve) => setTimeout(resolve, settle));
      return (await desktop.captureWindow(windowId)).data;
    }
    const reply = await this.askRaw(threadId, "snapshot", { windowId }, 10_000);
    if (reply.kind !== "png") throw new HttpError(502, "The shell did not send an image.");
    return reply.data;
  }

  // Browser tabs, by tag as windows.

  /** The thread's tabs, oldest first. */
  async threadTabs(threadId: string): Promise<BrowserTabEntry[]> {
    return (await this.allTabs())
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
    const desktop = await this.direct();
    const tab = desktop
      ? tabEntry(await desktop.createTab(url, [threadId]).catch((error: Error) => {
          throw new HttpError(400, error.message);
        }))
      : await this.ask<BrowserTabEntry>(threadId, "open_tab", { threadId, url });
    if (focus) await this.ask(threadId, "focus_tab", { tabId: tab.id }).catch(() => {});
    return threadTab(await this.waitForLoad(threadId, tab.id, waitMs));
  }

  async navigateTab(threadId: string, tabId: number, url: string, waitMs: number): Promise<ThreadTab> {
    await this.ownedTab(threadId, tabId);
    const desktop = await this.direct();
    if (desktop) {
      await desktop.navigateTab(tabId, url).catch((error: Error) => {
        throw new HttpError(400, error.message);
      });
    } else await this.ask(threadId, "navigate_tab", { tabId, url });
    return threadTab(await this.waitForLoad(threadId, tabId, waitMs));
  }

  async tabCommand(threadId: string, tabId: number, command: string, waitMs: number): Promise<ThreadTab> {
    await this.ownedTab(threadId, tabId);
    const desktop = await this.direct();
    if (desktop) await desktop.tabCommand(tabId, command as (typeof TAB_COMMANDS)[number]);
    else await this.ask(threadId, "tab_command", { tabId, command });
    return threadTab(await this.waitForLoad(threadId, tabId, waitMs));
  }

  async closeTab(threadId: string, tabId: number): Promise<{ closed: boolean }> {
    await this.ownedTab(threadId, tabId);
    const desktop = await this.direct();
    if (desktop) await desktop.tabCommand(tabId, "close");
    else await this.ask(threadId, "tab_command", { tabId, command: "close" });
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      if (!(await this.allTabs()).some((tab) => tab.id === tabId)) return { closed: true };
    }
    return { closed: false };
  }

  async answerDialog(threadId: string, tabId: number, accept: boolean, text: string): Promise<ThreadTab> {
    const tab = await this.ownedTab(threadId, tabId);
    if (!tab.dialogType) throw new HttpError(409, `Tab ${tabId} has no dialog open.`);
    const desktop = await this.direct();
    if (desktop) await desktop.answerTabDialog(tabId, accept, text);
    else await this.ask(threadId, "answer_dialog", { tabId, accept, text });
    await sleep(150);
    return threadTab(await this.ownedTab(threadId, tabId));
  }

  async focusTab(threadId: string, tabId: number): Promise<{ how: string }> {
    await this.ownedTab(threadId, tabId);
    return this.ask<{ how: string }>(threadId, "focus_tab", { tabId });
  }

  async snapshotTab(threadId: string, tabId: number): Promise<Buffer> {
    await this.ownedTab(threadId, tabId);
    const desktop = await this.direct();
    if (desktop) return (await desktop.captureTab(tabId)).data;
    const reply = await this.askRaw(threadId, "snapshot_tab", { tabId }, 10_000);
    if (reply.kind !== "png") throw new HttpError(502, "The shell did not send an image.");
    return reply.data;
  }

  // Driving windows: mouse and keys from agents, straight into the app. Points
  // are in snapshot_window's pixels (the window's DIPs times its scale).

  /**
   * The server's tabs no shell page shows: the helper opens them itself
   * (serverTabs.ts, "open"), straight from the browser, so the server needn't
   * wait for a page. Without the Plutonium domain the server waits as before.
   */
  private openServerTabs(serverTabs: ServerTabs, desktop: Desktop): void {
    const opening = new Set<string>();
    serverTabs.onOpen = (key, tag) => {
      const id = `${key.threadId}\u0000${key.tabId}`;
      if (opening.has(id)) return;
      opening.add(id);
      void (async () => {
        if (!(await desktop.available())) return;
        const tab = await desktop.createTab("about:blank", [tag]);
        const shownTabId = serverTabs.attach(
          key,
          {
            targetId: tab.targetId,
            browserTabId: tab.id,
            page: HELPER_PAGE,
            url: () => desktop.tab(tab.id)?.url ?? "",
            title: () => desktop.tab(tab.id)?.title ?? "",
          },
          (other) => other === HELPER_PAGE || this.relay.has(other),
        );
        // A shell page showed it meanwhile: that page's tab is the one.
        if (shownTabId !== tab.id) await desktop.tabCommand(tab.id, "close");
      })()
        .catch((error: Error) => console.warn(`plutoniumd: can't open the server's tab: ${error.message}`))
        .finally(() => opening.delete(id));
    };
    serverTabs.onClose = (_key, browserTabId) => {
      void desktop.tabCommand(browserTabId, "close").catch(() => {});
    };
    // The user closed one: the server's tab is gone.
    desktop.changeListeners.add(() => {
      for (const { key, browserTabId } of serverTabs.pageTabs(HELPER_PAGE)) {
        if (!desktop.tab(browserTabId)) serverTabs.detach(key, HELPER_PAGE);
      }
    });
  }

  /**
   * A window no page shows draws a frame a second: while an agent drives it,
   * keep it drawing at full rate, until it's left alone for AWAKE_MS.
   */
  private keepAwake(desktop: Desktop, windowId: number): void {
    const timer = this.awakeWindows.get(windowId);
    if (timer) clearTimeout(timer);
    else void desktop.setWindowAwake(windowId, true).catch(() => {});
    const expiry = setTimeout(() => {
      this.awakeWindows.delete(windowId);
      this.lastInput.delete(windowId);
      void desktop.setWindowAwake(windowId, false).catch(() => {});
    }, AWAKE_MS);
    expiry.unref();
    this.awakeWindows.set(windowId, expiry);
  }

  async windowInput(threadId: string, windowId: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const desktop = await this.requireDirect("Driving windows");
    await this.ownedWindow(threadId, windowId);
    this.keepAwake(desktop, windowId);
    const window = desktop.window(windowId);
    const scale = window?.deviceScaleFactor || 1;
    const point = (value: unknown, name: string): [number, number] => {
      if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => typeof n === "number" && Number.isFinite(n))) {
        throw new HttpError(400, `${name} must be [x, y].`);
      }
      return [value[0] / scale, value[1] / scale];
    };
    const at = () => point([body.x, body.y], "x and y");
    const button = (() => {
      const value = body.button ?? "left";
      if (value !== "left" && value !== "right" && value !== "middle") {
        throw new HttpError(400, "button must be left, right or middle.");
      }
      return value;
    })();
    const held = { left: 1, right: 2, middle: 4 }[button];
    const send = (event: Parameters<Desktop["mouse"]>[1]) =>
      desktop.mouse(windowId, event).catch((error: Error) => {
        throw new HttpError(409, error.message);
      });
    const keys = (events: ReturnType<typeof textKeys>) =>
      desktop.keys(windowId, events).catch((error: Error) => {
        throw new HttpError(409, error.message);
      });
    switch (body.action) {
      case "move": {
        const [x, y] = at();
        await send({ type: "mouseMoved", x, y });
        break;
      }
      case "click": {
        const [x, y] = at();
        const count = body.count === 2 || body.count === 3 ? body.count : 1;
        await send({ type: "mouseMoved", x, y });
        for (let click = 1; click <= count; click++) {
          await send({ type: "mousePressed", x, y, button, buttons: held, clickCount: click });
          await send({ type: "mouseReleased", x, y, button, buttons: 0, clickCount: click });
        }
        break;
      }
      case "drag": {
        const [fromX, fromY] = point(body.from, "from");
        const [toX, toY] = point(body.to, "to");
        await send({ type: "mouseMoved", x: fromX, y: fromY });
        await send({ type: "mousePressed", x: fromX, y: fromY, button, buttons: held, clickCount: 1 });
        const steps = 12;
        for (let step = 1; step <= steps; step++) {
          await sleep(16);
          await send({
            type: "mouseMoved",
            x: fromX + ((toX - fromX) * step) / steps,
            y: fromY + ((toY - fromY) * step) / steps,
            buttons: held,
          });
        }
        await send({ type: "mouseReleased", x: toX, y: toY, button, buttons: 0, clickCount: 1 });
        break;
      }
      case "scroll": {
        const [x, y] = at();
        const deltaX = typeof body.dx === "number" ? body.dx : 0;
        const deltaY = typeof body.dy === "number" ? body.dy : 0;
        await send({ type: "mouseMoved", x, y });
        await send({ type: "mouseWheel", x, y, deltaX, deltaY });
        break;
      }
      case "type": {
        if (typeof body.text !== "string") throw new HttpError(400, "text is required.");
        let events;
        try {
          events = textKeys(body.text);
        } catch (error) {
          throw new HttpError(400, (error as Error).message);
        }
        // In batches, so a long text doesn't hold the keyboard all at once, and
        // apart: Exo drops a client that can't keep up (a busy LibreOffice died
        // of a poem typed back to back). Each batch is a focus blip
        // (docs/features/AGENT_CONTROL.md, Limits), so they stay big enough for
        // what fills a field.
        for (let i = 0; i < events.length; i += TYPE_BATCH) {
          if (i > 0) await sleep(TYPE_BATCH_GAP_MS);
          await keys(events.slice(i, i + TYPE_BATCH));
        }
        break;
      }
      case "press": {
        const combos = Array.isArray(body.keys) ? body.keys : [body.keys];
        if (!combos.every((combo) => typeof combo === "string" && combo)) {
          throw new HttpError(400, "keys must be a key combination or a list of them.");
        }
        let events;
        try {
          events = (combos as string[]).flatMap(comboKeys);
        } catch (error) {
          throw new HttpError(400, (error as Error).message);
        }
        await keys(events);
        break;
      }
      case "resize": {
        if (typeof body.width !== "number" || typeof body.height !== "number") {
          throw new HttpError(400, "width and height are required.");
        }
        await desktop.resizeWindow(windowId, Math.round(body.width), Math.round(body.height)).catch((error: Error) => {
          throw new HttpError(409, error.message);
        });
        break;
      }
      default:
        throw new HttpError(400, "action must be move, click, drag, scroll, type, press or resize.");
    }
    return {};
  }

  // Driving pages: Playwright on the thread's tabs (pages.ts). Elements are
  // found by the refs a page snapshot gives ("e12") or by a Playwright selector.

  async pageAction(threadId: string, tabId: number, body: Record<string, unknown>): Promise<unknown> {
    await this.requireDirect("Driving pages");
    if (!this.pages) throw new HttpError(501, "No DevTools port.");
    await this.ownedTab(threadId, tabId);
    const page = await this.pages.page(threadId, tabId);
    const timeout = typeof body.timeoutMs === "number" ? Math.min(Math.max(body.timeoutMs, 0), 60_000) : 10_000;
    const target = () => {
      if (typeof body.ref === "string" && body.ref) return page.locator(`aria-ref=${body.ref}`);
      if (typeof body.selector === "string" && body.selector) return page.locator(body.selector);
      throw new HttpError(400, "ref (from a snapshot) or selector is required.");
    };
    const state = async () => ({ url: page.url(), title: await page.title().catch(() => "") });
    try {
      switch (body.action) {
        case "snapshot":
          return { ...(await state()), snapshot: await page.ariaSnapshot({ mode: "ai", timeout }) };
        case "click": {
          const button = body.button === "right" || body.button === "middle" ? body.button : "left";
          const locator = target();
          if (body.double === true) await locator.dblclick({ button, timeout });
          else await locator.click({ button, timeout });
          break;
        }
        case "hover":
          await target().hover({ timeout });
          break;
        case "type": {
          if (typeof body.text !== "string") throw new HttpError(400, "text is required.");
          const locator = target();
          if (body.slowly === true) await locator.pressSequentially(body.text, { timeout });
          else await locator.fill(body.text, { timeout });
          if (body.submit === true) await locator.press("Enter", { timeout });
          break;
        }
        case "select": {
          const values = Array.isArray(body.values) ? body.values.map(String) : [String(body.values ?? "")];
          await target().selectOption(values, { timeout });
          break;
        }
        case "press": {
          if (typeof body.key !== "string" || !body.key) throw new HttpError(400, "key is required.");
          await page.keyboard.press(body.key);
          break;
        }
        case "scroll": {
          const dx = typeof body.dx === "number" ? body.dx : 0;
          const dy = typeof body.dy === "number" ? body.dy : 0;
          if (typeof body.ref === "string" || typeof body.selector === "string") await target().hover({ timeout });
          await page.mouse.wheel(dx, dy);
          break;
        }
        case "evaluate": {
          if (typeof body.expression !== "string" || !body.expression) throw new HttpError(400, "expression is required.");
          // An expression, or a function's source (called with the element,
          // given a target), as Playwright takes them; not subject to the page's CSP.
          const value =
            typeof body.ref === "string" || typeof body.selector === "string"
              ? await target().evaluate(body.expression, undefined, { timeout })
              : await page.evaluate(body.expression);
          return { ...(await state()), value: value === undefined ? null : value };
        }
        case "wait_for": {
          if (typeof body.text === "string" && body.text) {
            await page.getByText(body.text).first().waitFor({ state: "visible", timeout });
          } else if (typeof body.text_gone === "string" && body.text_gone) {
            await page.getByText(body.text_gone).first().waitFor({ state: "hidden", timeout });
          } else if (typeof body.selector === "string" && body.selector) {
            await page.locator(body.selector).first().waitFor({ state: "visible", timeout });
          } else {
            await page.waitForLoadState("load", { timeout });
          }
          break;
        }
        default:
          throw new HttpError(
            400,
            "action must be snapshot, click, hover, type, select, press, scroll, evaluate or wait_for.",
          );
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      // Playwright's messages say what went wrong (no such element, timeout).
      throw new HttpError(409, (error as Error).message.split("\n").slice(0, 6).join("\n"));
    }
    return state();
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

  /**
   * What a frontend's server adds to a thread's agents (`env`) and to the
   * terminals the user types in (`terminalEnv`: their windows are shown).
   */
  threadSetup(threadId: string) {
    return {
      env: this.threads.environment(threadId),
      terminalEnv: this.threads.environment(threadId, { show: true }),
      // The agent bridge, for agents that take MCP servers.
      mcpServer: { command: process.execPath, args: [CLI, "mcp"] },
    };
  }

  // HTTP.

  private async handle(request: IncomingMessage, response: ServerResponse, local: boolean): Promise<void> {
    const url = new URL(request.url ?? "/", "http://plutonium");
    const method = request.method ?? "GET";
    const path = url.pathname;

    if (path === "/v1/terminal" || path.startsWith("/v1/terminal/")) {
      await this.handleTerminal(request, response, url, local);
      return;
    }

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
          (other) => other === HELPER_PAGE || this.relay.has(other),
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
        // Windows and tabs straight from the browser (else through a shell).
        direct: (await this.direct()) !== null,
        gpu: await this.gpu(),
      });
    }
    if (method === "GET" && path === "/v1/window-threads") {
      return sendJson(response, 200, threadsForPids(pidsParameter(url)));
    }
    if (method === "GET" && path === "/v1/window-shows") {
      return sendJson(response, 200, showsForPids(pidsParameter(url)));
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
      const { thread, id, waitMs, show } = await readJson(request);
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
        // Launchers start apps for the user to see.
        await this.launch(thread, command.argv, command.cwd, waitMsOf(waitMs), show !== false),
      );
    }
    if (method === "POST" && path === "/v1/launch") {
      const body = await readJson(request);
      const { thread, argv, cwd, waitMs, show } = body;
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
          show === true,
        ),
      );
    }

    if (local) {
      // The agent bridge's tools for a frontend's own MCP server (T3 Code
      // offers the window tools to every provider's agents with its own).
      if (method === "GET" && path === "/v1/mcp/tools") {
        return sendJson(response, 200, { tools: mcpTools(url.searchParams.get("set") ?? undefined) });
      }
      const mcpCall = path.match(/^\/v1\/threads\/([^/]+)\/mcp\/call$/);
      if (method === "POST" && mcpCall) {
        const { name, arguments: args } = await readJson(request);
        if (typeof name !== "string") throw new HttpError(400, "name is required.");
        const threadId = decodeURIComponent(mcpCall[1]!);
        try {
          const content = await callTool(
            name,
            args && typeof args === "object" ? (args as Record<string, unknown>) : {},
            this.options.socketPath,
            threadId,
          );
          return sendJson(response, 200, { content });
        } catch (error) {
          return sendJson(response, 200, { content: [{ type: "text", text: (error as Error).message }], isError: true });
        }
      }
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
          if (what === "page") return sendJson(response, 200, await this.pageAction(threadId, tabId, body));
        }
      }
      const windows = path.match(/^\/v1\/threads\/([^/]+)\/windows$/);
      if (method === "GET" && windows) {
        const threadId = decodeURIComponent(windows[1]!);
        return sendJson(response, 200, (await this.threadWindows(threadId)).map(threadWindow));
      }
      const action = path.match(/^\/v1\/threads\/([^/]+)\/windows\/(\d+)\/(focus|close|snapshot|input)$/);
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
        if (method === "POST" && action[3] === "input") {
          try {
            return sendJson(response, 200, await this.windowInput(threadId, windowId, await readJson(request)));
          } finally {
            this.lastInput.set(windowId, Date.now());
          }
        }
      }
    }
    throw new HttpError(404, "Not found.");
  }

  // The backup terminal. Its page is public; its sessions are for this user's
  // processes, and for the page itself: a same-origin request from this
  // origin (other pages can't send one, nor make Sec-Fetch-Site say so).
  private async handleTerminal(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    local: boolean,
  ): Promise<void> {
    const method = request.method ?? "GET";
    const path = url.pathname;
    if (method === "GET" && path === "/v1/terminal") {
      response.writeHead(308, { Location: "/v1/terminal/" }).end();
      return;
    }
    const file = TERMINAL_FILES[path];
    if (method === "GET" && file) {
      response.writeHead(200, {
        "Content-Type": file[1],
        "Cache-Control": "no-cache",
        "Content-Security-Policy": "frame-ancestors 'none'",
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(readFileSync(file[0]));
      return;
    }
    if (!local) {
      const uid = loopbackPeerUid(request.socket.remotePort ?? 0, this.options.port);
      const origin = request.headers.origin;
      if (
        uid !== process.getuid?.() ||
        request.headers["sec-fetch-site"] !== "same-origin" ||
        (origin !== undefined && origin !== `http://127.0.0.1:${this.options.port}`)
      ) {
        throw new HttpError(403, "Only the terminal page may use this.");
      }
    }
    const sizeOf = (body: Record<string, unknown>) => ({
      rows: typeof body.rows === "number" ? body.rows : 24,
      cols: typeof body.cols === "number" ? body.cols : 80,
    });
    if (path === "/v1/terminal/sessions") {
      if (method === "GET") return sendJson(response, 200, this.terminals.list());
      if (method === "POST") {
        const { rows, cols } = sizeOf(await readJson(request));
        try {
          return sendJson(response, 200, { id: this.terminals.create(rows, cols).id });
        } catch (error) {
          throw new HttpError(429, (error as Error).message);
        }
      }
    }
    const match = path.match(/^\/v1\/terminal\/sessions\/([\w-]+)\/(stream|input|resize|close)$/);
    const session = match ? this.terminals.get(match[1]!) : undefined;
    if (match && !session) throw new HttpError(404, "No such terminal.");
    if (session && method === "GET" && match![2] === "stream") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      });
      const stop = session.listen((event) => {
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
      });
      const heartbeat = setInterval(() => response.write(": \n\n"), 15_000);
      request.socket.setNoDelay(true);
      response.once("close", () => {
        clearInterval(heartbeat);
        stop();
      });
      return;
    }
    if (session && method === "POST") {
      switch (match![2]) {
        case "input":
          session.input((await readBody(request)).toString("utf8"));
          break;
        case "resize": {
          const { rows, cols } = sizeOf(await readJson(request));
          session.resize(rows, cols);
          break;
        }
        case "close":
          session.close();
          break;
        default:
          throw new HttpError(404, "Not found.");
      }
      response.writeHead(204).end();
      return;
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
    this.terminals.closeAll();
    this.pages?.closeAll();
    for (const server of this.servers) server.close();
    this.threads.shutdown();
    try {
      unlinkSync(this.options.socketPath);
    } catch {
      // Gone.
    }
  }
}
