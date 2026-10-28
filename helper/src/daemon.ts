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
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { A11yError, Accessibility } from "./a11y.ts";
import { type AgentWindow, AgentWindows } from "./agentWindows.ts";
import { DesktopApps } from "./apps.ts";
import { BrowserCdp } from "./cdp.ts";
import {
  Desktop,
  type DesktopDownload,
  type DesktopTab,
  type DesktopWindow,
  type WindowKeyEvent,
  type WindowMouseEvent,
} from "./desktop.ts";
import { type GpuReport, probeGpu } from "./gpu.ts";
import {
  type BrowserTabEntry,
  type ItemGroup,
  RelayError,
  ShellRelay,
  type NativeWindowEntry,
} from "./relay.ts";
import { countFiles, FilesError, listDirectory, makeFolder, places, recentFiles } from "./files.ts";
import { comboKeys, commitRuns, typingRuns } from "./keys.ts";
import { installOpeners, openerEnvironment } from "./opener.ts";
import { ThreadPages } from "./pages.ts";
import { callTool, mcpTools } from "./mcp.ts";
import { Appearance } from "./appearance.ts";
import { Portal } from "./portal.ts";
import { Recordings, type RecordingSource } from "./recordings.ts";
import { saveScreenshot } from "./screenshots.ts";
import { DesktopServices, mayUse, ServiceError } from "./services.ts";
import { NativeError, ShellNative } from "./shellNative.ts";
import { NotificationsService } from "./services/notifications.ts";
import { AudioService } from "./services/audio.ts";
import { PowerService } from "./services/power.ts";
import { MediaService } from "./services/media.ts";
import { BluetoothService } from "./services/bluetooth.ts";
import { NetworkService } from "./services/network.ts";
import { SessionService } from "./services/session.ts";
import { findChecker, unixChecker } from "./password.ts";
import { type BrowserShell, ShellPackages } from "./shellPackages.ts";
import { plutoHome, ShellError } from "./shells.ts";
import { defaultPdfPath, listPrinters, pdfArguments, printPdf, savePdf } from "./printing.ts";
import { HELPER_PAGE, type PermissionAnswer, ServerTabs } from "./serverTabs.ts";
import { TERMINAL_THREAD, Terminals } from "./terminal.ts";
import { ThreadBuses } from "./threadBus.ts";
import { streamWindow } from "./windowStream.ts";
import {
  explainPid,
  findExecutable,
  rememberLaunch,
  SHOW_VARIABLE,
  showsForPids,
  threadForPid,
  threadsForPids,
  Threads,
  type XDisplayOptions,
} from "./threads.ts";

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
  /** Where the threads' X servers go (tests use their own). */
  readonly xDisplays?: XDisplayOptions;
  /** Whether each thread's apps get their own session bus (threadBus.ts; default unless PLUTONIUM_THREAD_BUS=0). */
  readonly threadBuses?: boolean;
  /** The installed shells: the static ones are served on their own port (shells.ts). */
  readonly shells?: ShellPackages;
  readonly shellsPort?: number;
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
// The installed shells' page (history, log, updates, adding one).
const SHELLS_PAGE = join(HELPER_ROOT, "web", "shells", "index.html");
const MAX_BODY = 1 << 26;
// How long a group list from the browser is used for routing.
const GROUPS_TTL_MS = 2_000;
// How long a window snapshot waits after input, for the app to draw.
const INPUT_SETTLE_MS = 200;
// How long a window action waits for the windows and menus it opens.
const ACTION_SETTLE_MS = 250;
// How long after launch_app's wait an agent's app's new windows are still held
// at its size (a slow first start; the main window after a splash).
const LATE_WINDOWS_MS = 60_000;
// A launch's wait ends once the app's windows have stayed the same this long
// (a splash or a recovery dialog closing doesn't end it).
const LAUNCH_SETTLE_MS = 1_000;
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
  /** The size an agent holds it at: the shell shows it scaled, at this size. */
  readonly agentSize?: { readonly width: number; readonly height: number };
  /** The user took control of its size: the shell sizes it. */
  readonly userControl?: true;
}

function threadWindow(entry: NativeWindowEntry, agent?: AgentWindow): ThreadWindow {
  return {
    id: entry.id,
    title: entry.title,
    appId: entry.appId,
    width: entry.width,
    height: entry.height,
    shown: entry.embedded,
    focused: entry.focused,
    ...(agent?.width && agent.height ? { agentSize: { width: agent.width, height: agent.height } } : {}),
    ...(agent?.userControl ? { userControl: true as const } : {}),
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
  /**
   * What the page waits on the user for, by kind ("permission", "fileChooser",
   * ...; TAB_FEATURES.md): answer it with the kind's tool.
   */
  readonly pending?: Readonly<Record<string, TabRequestInfo>>;
  /** The rest of what the tab's features report ("zoom", ...). */
  readonly state?: Readonly<Record<string, unknown>>;
}

/** An open tab request (a tab's `pending`). */
export interface TabRequestInfo {
  readonly requestId: number;
  /** Whether a shell shows it to the user. */
  readonly taken: boolean;
  readonly detail: Readonly<Record<string, unknown>>;
}

/** A tab's feature state (BrowserTabEntry.stateJson), as an object. */
export function tabState(entry: { readonly stateJson?: string }): Record<string, unknown> {
  try {
    const state: unknown = JSON.parse(entry.stateJson || "{}");
    return state && typeof state === "object" && !Array.isArray(state) ? (state as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function threadTab(entry: BrowserTabEntry): ThreadTab {
  const { pending, ...state } = tabState(entry);
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
    ...(pending && typeof pending === "object" ? { pending: pending as Record<string, TabRequestInfo> } : {}),
    ...(Object.keys(state).length > 0 ? { state } : {}),
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

/** EXO-DISPLAYS: a request's display (1-based), or undefined. */
function displayOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Seconds since `start` (ms), for the logs. */
const seconds = (start: number) => `${((Date.now() - start) / 1000).toFixed(1)} s`;

// type_window: key events per batch, and the pause between batches.
const TYPE_BATCH = 64;
const TYPE_BATCH_GAP_MS = 25;
// After a Tab or Enter with keys after it: LibreOffice Calc loses a key that
// comes while it commits a cell.
const COMMIT_GAP_MS = 80;
// Before and after keys under a temporary keymap (Plutonium.setWindowKeymap).
const KEYMAP_GAP_MS = 50;

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
  /** Desktop services (services.ts): their changes go to the shells that may use them. */
  /** Installed shells' storage and native sides (none without installed shells). */
  readonly native: ShellNative | null;
  readonly services = new DesktopServices((service, state) =>
    this.relay.notifyWhere((origin) => this.mayUse(origin, service), "system", { service, state }),
  );
  readonly apps = new DesktopApps();
  /** EXO-LOCK: the lock screen and idle (services/session.ts). */
  readonly session: SessionService;
  readonly terminals: Terminals;
  readonly serverTabs: ServerTabs | null;
  /** The browser's windows and tabs, if it has the Plutonium DevTools domain. */
  readonly desktop: Desktop | null;
  readonly pages: ThreadPages | null;
  /** When each window last got input (windowInput). */
  private readonly lastInput = new Map<number, number>();
  /** The next desktop service request's handle number (askForService). */
  private systemRequests = 1;
  /**
   * The windows each thread's agent has been told of (by an action's result,
   * list_windows or launch_app): an action names the others as new, so a
   * dialog that came after the last action's wait is named by the next.
   */
  private readonly reportedWindows = new Map<string, Set<number>>();
  /** Windows kept awake after input, with the timer that lets them sleep. */
  private readonly awakeWindows = new Map<number, ReturnType<typeof setTimeout>>();
  /** Windows streamed to a frontend's remote clients, with how many streams each. */
  private readonly streamedWindows = new Map<number, number>();
  /** The sizes agents hold windows at, and which they're working in (for the shells). */
  readonly agentWindows = new AgentWindows();
  /** Windows as accessibility trees (read_window, act_window). */
  readonly a11y = new Accessibility();
  /** EXO-CAPTURE: the desktop portal's ScreenCast and Screenshot backend (portal.ts). */
  private portal: Portal | null = null;
  /** EXO-CAPTURE: agents' recordings (start_recording, stop_recording). */
  private recordings: Recordings | null = null;
  private appearance: Appearance | null = null;
  private readonly servers: Server[] = [];
  private groupsCache: { at: number; groups: Promise<ItemGroup[]> } | null = null;
  /** Shell origins a shell page reported (shells added in the browser at runtime). */
  private reportedOrigins = new Set<string>();
  /** gpu.ts's answer for the Exo instance behind the socket's inode. */
  private gpuProbe: { inode: number; report: Promise<GpuReport> } | null = null;
  /**
   * The thread each untagged window's client was started by, by window id.
   * The browser can't read the environment of every client (a sandbox's own
   * user namespace, Flatpak's), the helper can, and knows what it started.
   */
  private readonly pidThreads = new Map<number, { pid: number; threadId: string | undefined }>();
  /** Threads whose permission grants the next shell page to connect forgets (forgetThreadPermissions()). */
  private readonly threadsToForget = new Set<string>();

  constructor(options: DaemonOptions) {
    this.options = options;
    // Started from a Plutonium terminal (not by `plutonium run`, which unsets
    // it), the helper has PLUTONIUM_SHOW=1, and would pass it on: everything
    // agents start, and every X window, would be shown.
    delete process.env[SHOW_VARIABLE];
    const activate = findExecutable("systemd-socket-activate");
    const buses =
      (options.threadBuses ?? process.env.PLUTONIUM_THREAD_BUS !== "0") && activate && process.platform === "linux"
        ? new ThreadBuses({ dir: join(dirname(options.socketPath), "buses"), activate })
        : undefined;
    this.threads = new Threads(options.waylandDisplay, options.socketPath, options.xDisplays, buses);
    this.terminals = new Terminals(() => ({
      ...process.env,
      // Typed in by the user: what it starts is shown.
      ...this.threads.environment(TERMINAL_THREAD, { show: true }),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    }));
    const cdp = options.cdpPort ? new BrowserCdp(options.cdpPort) : null;
    const notifications = new NotificationsService(
      undefined,
      {
        // EXO-SERVICES: the tabs' web notifications, through the Plutonium domain.
        onChange: (listener) => this.desktop?.notificationListeners.add(listener),
        action: async (id, action, button) => {
          if (!this.desktop) throw new Error("No browser.");
          await this.desktop.notificationAction(id, action, button);
        },
        showSite: (origin) => this.showSite(origin),
      },
      notificationsOnBus(options),
    );
    this.services.register(notifications);
    this.services.register(new AudioService());
    this.services.register(new PowerService({ logOut: () => this.logOut() }));
    this.services.register(
      new MediaService({
        // The browser's own media session (a tab playing), through the Plutonium domain.
        browser: {
          session: async () => (await this.desktop?.mediaSession()) ?? null,
          action: async (action) => {
            if (!this.desktop) throw new Error("No browser.");
            await this.desktop.mediaSessionAction(action);
          },
          onChange: (listener) => this.desktop?.mediaListeners.add(listener),
          pid: async () => (await this.desktop?.browserPid()) ?? null,
        },
      }),
    );
    // One secret agent per helper: NetworkManager replaces an agent with the same identifier.
    const agentId = `org.plutonium.helper.${basename(options.socketPath).replace(/[^A-Za-z0-9_-]/g, "_")}`;
    this.services.register(new NetworkService({ agentId, ask: (kind, detail, signal) => this.askForService("network", kind, detail, signal) }));
    this.services.register(new BluetoothService({ ask: (kind, detail, signal) => this.askForService("bluetooth", kind, detail, signal) }));
    // EXO-LOCK: unix_chkpwd checks the password; PLUTONIUM_PASSWORD_CHECKER
    // names a stand-in with its interface, for tests.
    const checker = process.env.PLUTONIUM_PASSWORD_CHECKER || findChecker();
    this.session = new SessionService({
      browser: cdp
        ? {
            lock: (user, message) => this.desktop!.lock(user, message),
            idle: () => this.desktop!.idle(),
            setDisplaysOff: (off) => this.desktop!.setDisplaysOff(off),
            setIdleInhibited: (inhibited) => this.desktop!.setIdleInhibited(inhibited),
            onLockChanged: (listener) => this.desktop?.lockListeners.add(listener),
          }
        : null,
      checker: checker ? unixChecker(checker) : null,
      // The session's own home: a test slot's, not ~/.pluto (--pluto-home, not $PLUTO_HOME).
      settingsFile: join(options.shells?.home ?? plutoHome(), "session.json"),
      // org.freedesktop.ScreenSaver: only the user's own session (slot 0) by default; a test
      // session in another slot would take the host desktop's apps' inhibitors
      // (PLUTONIUM_SCREENSAVER=1 serves it anyway, 0 never).
      sessionBus:
        (process.env.PLUTONIUM_SCREENSAVER ?? ((options.shells?.context.slot ?? 0) === 0 ? "1" : "0")) === "0"
          ? null
          : process.env.DBUS_SESSION_BUS_ADDRESS || null,
      // logind's Lock and sleep: only for the session a DRM launch named
      // (lib/session.sh), never one inherited from the shell that started it
      // (a test session's helper would follow the user's own).
      systemBus: process.env.PLUTONIUM_LOGIND_SESSION ? "unix:path=/run/dbus/system_bus_socket" : null,
      sessionId: process.env.PLUTONIUM_LOGIND_SESSION,
      sessionTty: process.env.PLUTONIUM_LOGIND_TTY,
      notify: (summary, body) => void notifications.notify(["Plutonium", 0, "", summary, body, [], new Map(), -1]),
    });
    this.services.register(this.session);
    const shells = options.shells;
    this.native = shells
      ? new ShellNative(shells.home, (name, event, detail) =>
          this.relay.notifyWhere((origin) => shells.byOrigin(origin)?.name === name, "native", { event, detail }),
        )
      : null;
    if (options.shells) {
      options.shells.hooks = {
        reloadPages: async (origin) => (cdp ? reloadPages(cdp, origin) : 0),
        stopNative: (name) => this.native?.stop(name),
        openTerminal: (terminal) => this.terminals.create(24, 80, terminal).id,
        threadSetup: (thread) => this.threadSetup(thread),
        // A rollback, a crash, a failed server: the shells' shellnotice, and a notification
        // (which the shells using the notifications service pop up).
        notice: (notice) => {
          this.relay.notifyAll("shellnotice", { ...notice });
          const summary =
            notice.kind === "rollback"
              ? `${notice.title}: a change was rolled back`
              : notice.kind === "crash"
                ? `${notice.title} crashed`
                : `${notice.title}'s server failed`;
          notifications.notify(["Plutonium", 0, "", summary, notice.message, [], new Map([["urgency", 2]]), -1]);
        },
      };
    }
    this.serverTabs = cdp ? new ServerTabs(cdp) : null;
    this.desktop = cdp ? new Desktop(cdp) : null;
    this.pages = cdp && this.desktop ? new ThreadPages(cdp, this.desktop) : null;
    if (cdp && this.desktop && options.shells) this.watchCrashes(cdp, this.desktop, options.shells);
    if (this.serverTabs) {
      const serverTabs = this.serverTabs;
      this.relay.onDisconnect = (page) => serverTabs.detachPage(page);
      serverTabs.onPointer = (page, pointer) =>
        // A tab the helper opened: whichever page shows it draws the cursor.
        page === HELPER_PAGE
          ? this.relay.notifyAll("pointer", { ...pointer })
          : this.relay.notify(page, "pointer", { ...pointer });
      serverTabs.onOrphaned = (key) => this.relay.notifyAll("server_tab_orphaned", { ...key });
      const desktop = this.desktop;
      if (desktop) serverTabs.keepAwake = (browserTabId, awake) => desktop.setTabAwake(browserTabId, awake);
      if (this.desktop) this.openServerTabs(serverTabs, this.desktop);
    }
    {
      // EXO-LOCK: a shell's inhibitor goes with its last page.
      const disconnect = this.relay.onDisconnect;
      this.relay.onDisconnect = (page) => {
        disconnect(page);
        this.session.keepShells(new Set(this.relay.shells().map(({ origin }) => this.callerOf(origin))));
      };
    }
    // The shells show the windows agents work in as such (agent_windows),
    // also to a page that connects later.
    this.agentWindows.onChange = (windows) => this.relay.notifyAll("agent_windows", { windows });
    this.relay.onAttach = (key) => {
      // An installed shell that came up (after a change, or at the start).
      const origin = this.relay.originOf(key);
      if (origin) this.options.shells?.connected(origin);
      this.relay.notify(key, "agent_windows", { windows: this.agentWindows.list() });
      // EXO-CAPTURE: the keys apps bound through the portal.
      if (this.portal) this.relay.notify(key, "global_shortcuts", { shortcuts: this.portal.globalShortcuts() });
    };
    if (this.desktop) {
      const desktop = this.desktop;
      desktop.changeListeners.add(() => {
        const windows = desktop.windows();
        const existing = new Set(windows.map((window) => window.id));
        this.agentWindows.prune(existing);
        for (const id of this.pidThreads.keys()) if (!existing.has(id)) this.pidThreads.delete(id);
        for (const window of windows) {
          if (!window.embedded) this.agentWindows.follow(window.id, window.width, window.height);
        }
        this.a11y.prune(existing);
      });
      desktop.windowListeners.add((window, previous) => this.logWindow(window, previous));
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
      .filter((entry) => (entry.tags?.length ? entry.tags.includes(threadId) : this.pidThread(entry) === threadId))
      .sort((a, b) => a.id - b.id);
  }

  /** An untagged window's thread: the one that started its client, if any. */
  private pidThread(entry: { readonly id: number; readonly pid: number }): string | undefined {
    const known = this.pidThreads.get(entry.id);
    if (known?.pid === entry.pid) return known.threadId;
    const threadId = threadForPid(entry.pid);
    this.pidThreads.set(entry.id, { pid: entry.pid, threadId });
    return threadId;
  }

  /** Logs a new window's client and thread, and later changes to its tags. */
  private logWindow(window: DesktopWindow, previous: DesktopWindow | undefined): void {
    const tags = `[${window.tags.join(", ")}]`;
    const what = `window #${window.id} ${JSON.stringify(window.appId)} pid ${window.pid}`;
    if (previous) {
      if (previous.tags.join("\0") !== window.tags.join("\0")) console.log(`plutoniumd: ${what}: tags now ${tags}`);
      return;
    }
    if (window.tags.length > 0) {
      console.log(`plutoniumd: ${what}: tags ${tags}, thread ${window.tags[0]}`);
      return;
    }
    const { threadId, how } = explainPid(window.pid);
    this.pidThreads.set(window.id, { pid: window.pid, threadId });
    console.log(
      `plutoniumd: ${what}: no tags from the browser; ` +
        (threadId ? `thread ${threadId} (${how})` : `no thread: ${how}`),
    );
    // The browser couldn't read its client's environment (Ash in a container
    // with its own user namespace): name it there, once for every shell.
    if (threadId && window.pid > 0) void this.desktop?.setWindowOriginTag(window.id, threadId);
  }

  /**
   * A hardware key (POST /v1/system/key, from Ash): runs its service's action
   * and tells the shells (a `systemkey` notice, for an on-screen level).
   * False if it did nothing (no PipeWire, no backlight, no player), so Ash can
   * do its own thing.
   */
  private async systemKey(key: string): Promise<boolean> {
    const step = 0.05;
    const keys: Record<string, [service: string, action: string, args: Record<string, unknown>]> = {
      "volume-up": ["audio", "step", { by: step }],
      "volume-down": ["audio", "step", { by: -step }],
      "volume-mute": ["audio", "set-mute", {}],
      "mic-mute": ["audio", "set-mute", { device: "input" }],
      "brightness-up": ["power", "step", { by: step }],
      "brightness-down": ["power", "step", { by: -step }],
      "play-pause": ["media", "play-pause", {}],
      play: ["media", "play", {}],
      pause: ["media", "pause", {}],
      stop: ["media", "stop", {}],
      next: ["media", "next", {}],
      previous: ["media", "previous", {}],
    };
    const entry = keys[key];
    if (!entry) throw new HttpError(404, `No system key "${key}".`);
    const [service, action, args] = entry;
    let state: unknown;
    try {
      state = await this.services.call(service, action, args);
    } catch (error) {
      if (error instanceof ServiceError) return false;
      throw error;
    }
    this.relay.notifyWhere((origin) => this.mayUse(origin, service), "systemkey", { key, service, state });
    return true;
  }

  /**
   * Log out (the power service): ends this Plutonium session, as `plutonium
   * stop` does, which stops this helper too, so it runs on its own.
   */
  private logOut(): void {
    const mode = this.options.waylandDisplay.includes("-x11") ? "--x11" : "--drm";
    const child = spawn(join(HELPER_ROOT, "..", "bin", "plutonium"), ["stop", mode], { detached: true, stdio: "ignore" });
    child.on("error", (error) => console.error(`plutoniumd: log out: ${error.message}`));
    child.unref();
  }

  /**
   * A desktop service needs the user (a Wi-Fi password, a pairing code): the
   * visible shell that may use it asks ("system_request"). The answer's
   * values, null if the user said no, undefined if no shell could ask.
   */
  private async askForService(
    service: string,
    kind: string,
    detail: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | null | undefined> {
    const shells = this.relay.shells().filter((shell) => shell.shellId && this.mayUse(shell.origin, service));
    const shell = shells.find((candidate) => candidate.visible) ?? shells[0];
    if (!shell || signal?.aborted) return undefined;
    const handle = `system-${this.systemRequests++}`;
    const takeBack = () =>
      this.relay.notifyWhere((origin) => this.mayUse(origin, service), "system_request_cancel", { handle });
    signal?.addEventListener("abort", takeBack, { once: true });
    try {
      const reply = await this.relay.request("system_request", { handle, service, kind, detail }, 120_000, shell.shellId);
      return reply.kind === "json" ? ((reply.value as Record<string, unknown> | null) ?? null) : null;
    } catch (error) {
      // Not answered in time: the question goes away; refused or gone: no shell asked.
      if (error instanceof RelayError && error.status === 504) {
        takeBack();
        return null;
      }
      return undefined;
    } finally {
      signal?.removeEventListener("abort", takeBack);
    }
  }

  /** Who a shell is to the services: its name, or its origin if it isn't installed. */
  private callerOf(origin: string): string {
    return this.options.shells?.byOrigin(origin)?.name ?? origin;
  }

  /** Whether the shell on `origin` may use desktop service `service` (its "uses"). */
  private mayUse(origin: string, service: string): boolean {
    const shell = this.options.shells?.byOrigin(origin);
    return mayUse(shell?.manifest?.uses, shell !== undefined, service);
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
   * Starts `argv` as one of the thread's processes. With `waitMs`, waits up to
   * that long for the thread's new windows to appear and stop changing, and
   * returns those open then. With `show`, the shell brings
   * its windows to the front (PLUTONIUM_SHOW). With `agent`, an agent started
   * it to work in: its windows are held at `agent.size`, or at the size the
   * app picks (shells show them scaled at that size until the user takes
   * control), so what the agent sees stays put.
   */
  async launch(
    threadId: string,
    argv: readonly string[],
    cwd: string | undefined,
    waitMs: number,
    show = false,
    agent?: { readonly size?: { readonly width: number; readonly height: number } },
  ): Promise<{ pid: number; windows: ThreadWindow[] }> {
    const before =
      this.relay.connected || (await this.direct())
      ? new Set((await this.threadWindows(threadId)).map((entry) => entry.id))
      : undefined;
    const allBefore = before ? new Set((await this.allWindows()).map((entry) => entry.id)) : undefined;
    const started = Date.now();
    void this.gpu();
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: cwd || process.env.HOME,
      env: { ...process.env, ...this.threads.environment(threadId, { show }) },
      detached: true,
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (error) => reject(new HttpError(400, this.launchError(argv[0]!, cwd, error, agent !== undefined))));
    }).catch((error: Error) => {
      console.log(`plutoniumd: could not launch ${JSON.stringify(argv)} in thread ${threadId}: ${error.message}`);
      throw error;
    });
    child.unref();
    rememberLaunch(child, threadId, show);
    const pid = child.pid ?? 0;
    console.log(`plutoniumd: launched pid ${pid} in thread ${threadId}: ${JSON.stringify(argv)}`);
    const holds = agent !== undefined && (agent.size !== undefined || !show);
    // Windows that come after the wait (a slow first start, the main window
    // after a splash) are held too.
    if (before && holds) void this.holdLate(threadId, before, agent.size, Date.now() + Math.max(waitMs, 0) + LATE_WINDOWS_MS);
    if (!before || waitMs <= 0) return { pid, windows: [] };
    const deadline = Date.now() + waitMs;
    // The new windows and since when they've been these; windows that came and went.
    let current = "";
    let since = 0;
    const gone = new Map<number, string>();
    let fresh: NativeWindowEntry[] = [];
    while (Date.now() < deadline) {
      await sleep(200);
      const now = (await this.threadWindows(threadId)).filter((entry) => !before.has(entry.id));
      for (const entry of fresh) if (!now.some((other) => other.id === entry.id)) gone.set(entry.id, entry.appId);
      fresh = now;
      const ids = fresh.map((entry) => entry.id).join(",");
      if (ids !== current) [current, since] = [ids, Date.now()];
      // Some windows, the same for a while: the app has settled.
      if (fresh.length > 0 && Date.now() - since >= LAUNCH_SETTLE_MS) break;
      if (fresh.length === 0 && child.exitCode !== null && child.exitCode !== 0) break;
    }
    if (gone.size > 0) {
      console.log(
        `plutoniumd: pid ${pid}'s windows that closed while it started: ` +
          [...gone].map(([id, appId]) => `#${id} ${JSON.stringify(appId)}`).join(", "),
      );
    }
    if (fresh.length > 0) {
      const settled = holds ? await this.holdNew(fresh, agent.size) : fresh;
      console.log(
        `plutoniumd: pid ${pid}'s windows after ${seconds(started)}: ` +
          settled.map((entry) => `#${entry.id} ${JSON.stringify(entry.appId)}`).join(", "),
      );
      for (const entry of settled) this.reportedWindows.get(threadId)?.add(entry.id);
      return { pid, windows: settled.map((entry) => threadWindow(entry, this.agentWindows.get(entry.id))) };
    }
    // What came instead, if anything: windows the thread didn't get.
    const others = (await this.allWindows().catch(() => [])).filter((entry) => !allBefore?.has(entry.id));
    console.log(
      `plutoniumd: no window in thread ${threadId} from pid ${pid} after ${seconds(started)}` +
        (child.exitCode !== null ? ` (it exited with ${child.exitCode})` : "") +
        (others.length > 0
          ? `; other new windows: ${others
              .map((entry) => `#${entry.id} ${JSON.stringify(entry.appId)} pid ${entry.pid} tags [${(entry.tags ?? []).join(", ")}]`)
              .join("; ")}`
          : "; no other new windows"),
    );
    return { pid, windows: [] };
  }

  /** Why `program` didn't start; for an agent, a program not found points to find_apps and what it would find. */
  private launchError(program: string, cwd: string | undefined, error: NodeJS.ErrnoException, agent: boolean): string {
    if (error.code !== "ENOENT" || !agent) return `Could not start ${program}: ${error.message}`;
    // spawn says ENOENT for a missing working directory too.
    if (cwd && !existsSync(cwd)) return `Could not start ${program}: the working directory ${cwd} doesn't exist.`;
    const where = program.includes("/") ? "doesn't exist" : "isn't on PATH";
    let found: readonly { name: string; argv: readonly string[] }[] = [];
    try {
      found = this.apps.find(basename(program)).apps.slice(0, 3);
    } catch {
      // Only a hint.
    }
    return (
      `${program} ${where}; find_apps lists installed apps and how to launch them.` +
      found.map((app) => `\n${app.name}: ${JSON.stringify(app.argv)}`).join("")
    );
  }

  /**
   * Holds an agent's new windows at `size` (else at their own size): resized
   * now if no page shows them, else by the shell, which follows the hold.
   * Returns them as they are then.
   */
  private async holdNew(
    windows: NativeWindowEntry[],
    size: { readonly width: number; readonly height: number } | undefined,
  ): Promise<NativeWindowEntry[]> {
    const desktop = await this.direct();
    for (const entry of windows) {
      const width = size?.width ?? entry.width;
      const height = size?.height ?? entry.height;
      if (width < 1 || height < 1) continue;
      this.agentWindows.hold(entry.id, width, height, !size);
      if (size && desktop && !entry.embedded) {
        await desktop.resizeWindow(entry.id, width, height).catch(() => {});
      }
    }
    if (!size) return windows;
    // The app's answer.
    const ids = new Set(windows.map((entry) => entry.id));
    await this.waitForSizes(ids, size, 1_500);
    return (await this.allWindows()).filter((entry) => ids.has(entry.id));
  }

  /** Holds the thread's windows new since `before` that aren't held yet, until `until`. */
  private async holdLate(
    threadId: string,
    before: ReadonlySet<number>,
    size: { readonly width: number; readonly height: number } | undefined,
    until: number,
  ): Promise<void> {
    const seen = new Set(before);
    while (Date.now() < until) {
      await sleep(500);
      const fresh = (await this.threadWindows(threadId).catch(() => [])).filter((entry) => !seen.has(entry.id));
      if (fresh.length === 0) continue;
      for (const entry of fresh) seen.add(entry.id);
      const unheld = fresh.filter((entry) => !this.agentWindows.get(entry.id));
      if (unheld.length > 0) await this.holdNew(unheld, size).catch(() => {});
    }
  }

  /** Waits up to `waitMs` for windows `ids` to take `size` (an app may pick another). */
  private async waitForSizes(
    ids: ReadonlySet<number>,
    size: { readonly width: number; readonly height: number },
    waitMs: number,
  ): Promise<void> {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const windows = (await this.allWindows()).filter((entry) => ids.has(entry.id));
      if (windows.every((entry) => entry.width === size.width && entry.height === size.height)) return;
      await sleep(100);
    }
  }

  /** Asks the frontend to show the window to the user (it pops it out if the frontend can't). */
  async focus(threadId: string, windowId: number, display?: number): Promise<{ how: string }> {
    await this.ownedWindow(threadId, windowId);
    return this.ask<{ how: string }>(threadId, "focus", { windowId, threadId, ...(display ? { display } : {}) });
  }

  /** EXO-DISPLAYS: the displays, with the shell each shows (a shell page knows them). */
  async displays(): Promise<unknown[]> {
    try {
      return await this.relay.json<unknown[]>("displays");
    } catch (error) {
      // An older shell library, or browser.
      if (error instanceof RelayError && error.status === 409) return [];
      throw error;
    }
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
    if (desktop) await desktop.tabCommand(tabId, command);
    else await this.ask(threadId, "tab_command", { tabId, command });
    return threadTab(await this.waitForLoad(threadId, tabId, waitMs));
  }

  /**
   * EXO-TAB-FEATURES: runs a tab feature's command ("zoom-in", "find", ...)
   * on one of the thread's tabs; resolves with its result.
   */
  async runTabCommand(
    threadId: string,
    tabId: number,
    command: string,
    args?: Record<string, unknown>,
  ): Promise<{ result: unknown; tab: ThreadTab }> {
    await this.ownedTab(threadId, tabId);
    // EXO-TAB-PERMISSIONS: the prompt says an agent asked.
    if (command === "permission-request") args = { ...args, by: "agent" };
    const desktop = await this.direct();
    let result: unknown;
    try {
      result = desktop
        ? await desktop.tabCommand(tabId, command, args)
        : ((await this.ask<{ result?: unknown }>(threadId, "tab_command", { tabId, command, args })).result ?? null);
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
    return { result, tab: threadTab(await this.ownedTab(threadId, tabId)) };
  }

  /**
   * EXO-TAB-FEATURES: answers the request of `kind` that one of the thread's
   * tabs waits on (its `pending`), as an agent. The kind decides which
   * answers an agent may give.
   */
  async answerTabRequest(threadId: string, tabId: number, kind: string, answer: unknown): Promise<ThreadTab> {
    const tab = await this.ownedTab(threadId, tabId);
    const request = (tabState(tab).pending as Record<string, TabRequestInfo> | undefined)?.[kind];
    if (!request) throw new HttpError(409, `Tab ${tabId} has no ${kind} request open.`);
    const desktop = await this.direct();
    if (!desktop) throw new HttpError(501, "This browser can't answer tab requests for agents.");
    await desktop.answerTabRequest(request.requestId, answer).catch((error: Error) => {
      throw new HttpError(400, error.message);
    });
    await sleep(150);
    return threadTab(await this.ownedTab(threadId, tabId));
  }

  // EXO-TAB-FEATURES: downloads (TAB_FEATURES.md, "Downloads").

  /** The thread's downloads: from its tabs, or from a tab now in the thread. Oldest first. */
  async threadDownloads(threadId: string): Promise<DesktopDownload[]> {
    const desktop = await this.direct();
    if (!desktop) return [];
    const tabIds = new Set((await this.threadTabs(threadId)).map((tab) => tab.id));
    return desktop.downloads().filter((download) => download.thread === threadId || tabIds.has(download.tabId));
  }

  /**
   * Runs `command` on one of the thread's downloads, as an agent: pause,
   * resume, cancel, discard, remove, or open and show (the helper's own).
   * Not keep: a dangerous file is the user's to keep.
   */
  async downloadAction(threadId: string, id: number, command: string): Promise<DesktopDownload | { removed: true }> {
    const download = (await this.threadDownloads(threadId)).find((entry) => entry.id === id);
    if (!download) throw new HttpError(404, `This thread has no download ${id}.`);
    if (command === "open" || command === "show") {
      if (command === "open" && download.state !== "complete") throw new HttpError(409, "It hasn't finished.");
      await this.openDownload(download.path, threadId, command === "show");
      return download;
    }
    if (!["pause", "resume", "cancel", "discard", "remove"].includes(command)) {
      throw new HttpError(400, "command must be pause, resume, cancel, open, show, discard or remove.");
    }
    const desktop = await this.requireDirect("Downloads");
    await desktop.downloadCommand(id, command).catch((error: Error) => {
      throw new HttpError(400, error.message);
    });
    await sleep(150);
    return desktop.download(id) ?? { removed: true };
  }

  /**
   * Opens a downloaded file (or with `show`, its folder) in `thread`, with
   * the thread's environment (its xdg-open goes through the opener). Not
   * FileManager1.ShowItems: D-Bus would start the file manager outside the
   * session's display, and outside the thread.
   */
  async openDownload(path: string, thread: string, show: boolean): Promise<void> {
    if (!path.startsWith("/")) throw new HttpError(400, "path must be absolute.");
    const target = show ? dirname(path) : path;
    if (!existsSync(target)) throw new HttpError(404, `${target} isn't there (from here).`);
    console.log(`plutoniumd: ${show ? "showing" : "opening"} ${path} in thread ${thread || "(none)"}`);
    await this.launch(thread, ["xdg-open", target], dirname(path), 0, true);
  }

  /**
   * EXO-TAB-FEATURES: prints one of the thread's tabs, as an agent: to the host's
   * printer (CUPS), or to a PDF file with `path`. Agents may print like any other
   * program (TAB_FEATURES.md, Decision 8). A print the page asked for (its
   * pending.print, from window.print() or Ctrl+P) is answered "done".
   */
  async printTab(
    threadId: string,
    tabId: number,
    body: Record<string, unknown>,
  ): Promise<{ job?: string; path?: string; bytes: number; tab: ThreadTab }> {
    const string = (key: string) => (typeof body[key] === "string" && body[key] ? (body[key] as string) : undefined);
    const boolean = (key: string) => (typeof body[key] === "boolean" ? (body[key] as boolean) : undefined);
    const number = (key: string) => (typeof body[key] === "number" ? (body[key] as number) : undefined);
    let args;
    try {
      args = pdfArguments({
        paper: string("paper"),
        landscape: boolean("landscape"),
        scale: number("scale"),
        margins: string("margins"),
        background: boolean("background"),
        headerFooter: boolean("headerFooter"),
        pageRanges: string("pageRanges"),
      });
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
    const { result, tab } = await this.runTabCommand(threadId, tabId, "print-to-pdf", args);
    const data = (result as { data?: unknown } | null)?.data;
    if (typeof data !== "string" || !data) throw new HttpError(502, `Tab ${tabId} couldn't be printed to PDF.`);
    const pdf = Buffer.from(data, "base64");
    let outcome: { job?: string; path?: string };
    try {
      const path = string("path");
      outcome = path
        ? savePdf(pdf, path, { overwrite: boolean("overwrite") === true })
        : await printPdf(pdf, {
            printer: string("printer"),
            copies: number("copies"),
            duplex: string("duplex") as "none" | "long-edge" | "short-edge" | undefined,
            color: boolean("color"),
            title: tab.title,
          });
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
    if (tab.pending?.print) await this.answerTabRequest(threadId, tabId, "print", "done").catch(() => {});
    return { ...outcome, bytes: pdf.length, tab: threadTab(await this.ownedTab(threadId, tabId)) };
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

  /**
   * Installed shells' pages that crash (Target.targetCrashed, with target
   * discovery on): an edit that just went in is rolled back, else the shells
   * are told (ShellPackages.crashed).
   */
  private watchCrashes(cdp: BrowserCdp, desktop: Desktop, shells: ShellPackages): void {
    const urls = new Map<string, string>();
    cdp.addEventListener(({ method, params, sessionId }) => {
      if (sessionId) return;
      const value = params as { targetInfo?: { targetId: string; type: string; url: string }; targetId?: string };
      if (method === "Target.targetCreated" || method === "Target.targetInfoChanged") {
        if (value.targetInfo?.type === "page") urls.set(value.targetInfo.targetId, value.targetInfo.url);
      } else if (method === "Target.targetDestroyed") {
        urls.delete(value.targetId ?? "");
      } else if (method === "Target.targetCrashed") {
        const url = urls.get(value.targetId ?? "");
        if (!url) return;
        try {
          shells.crashed(new URL(url).origin);
        } catch {
          // Not a URL with an origin.
        }
      }
    });
    desktop.enableListeners.add(() => {
      urls.clear();
      void cdp.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
    });
  }

  /** Shows a tab of `origin` in its thread's shell (a web notification was clicked): the focused one, else the newest. */
  private async showSite(origin: string): Promise<void> {
    const desktop = await this.direct();
    if (!desktop) return;
    const originOf = (url: string) => {
      try {
        return new URL(url).origin;
      } catch {
        return "";
      }
    };
    const tabs = desktop.tabs().filter((tab) => originOf(tab.url) === origin);
    const tab = tabs.find((candidate) => candidate.focused) ?? tabs.at(-1);
    const threadId = tab?.tags[0];
    if (!tab || !threadId) return;
    await this.ask(threadId, "focus_tab", { tabId: tab.id });
  }

  async focusTab(threadId: string, tabId: number, display?: number): Promise<{ how: string }> {
    await this.ownedTab(threadId, tabId);
    return this.ask<{ how: string }>(threadId, "focus_tab", { tabId, ...(display ? { display } : {}) });
  }

  async snapshotTab(threadId: string, tabId: number): Promise<Buffer> {
    await this.ownedTab(threadId, tabId);
    const desktop = await this.direct();
    if (desktop) return (await desktop.captureTab(tabId)).data;
    const reply = await this.askRaw(threadId, "snapshot_tab", { tabId }, 10_000);
    if (reply.kind !== "png") throw new HttpError(502, "The shell did not send an image.");
    return reply.data;
  }

  /** EXO-CAPTURE: records the thread's window or tab ({window_id} or {tab_id}, path?) to a file. */
  async startRecording(threadId: string, body: Record<string, unknown>) {
    await this.requireDirect("Recording");
    if (!this.recordings) throw new HttpError(501, "Recording needs the browser.");
    const windowId = body.window_id;
    const tabId = body.tab_id;
    let source: RecordingSource;
    if (typeof windowId === "number" && tabId === undefined) {
      await this.ownedWindow(threadId, windowId);
      source = { type: "window", id: windowId };
    } else if (typeof tabId === "number" && windowId === undefined) {
      await this.ownedTab(threadId, tabId);
      source = { type: "tab", id: tabId };
    } else {
      throw new HttpError(400, "Give window_id or tab_id.");
    }
    if (body.path !== undefined && typeof body.path !== "string") throw new HttpError(400, "path must be a string.");
    try {
      return await this.recordings.start(threadId, source, body.path || undefined);
    } catch (error) {
      throw new HttpError(409, (error as Error).message);
    }
  }

  async stopRecording(threadId: string, id: number | undefined) {
    if (!this.recordings) throw new HttpError(501, "Recording needs the browser.");
    try {
      return await this.recordings.stop(threadId, id);
    } catch (error) {
      throw new HttpError(404, (error as Error).message);
    }
  }

  // Driving windows: mouse and keys from agents, straight into the app. Points
  // are in snapshot_window's pixels (the window's DIPs times its scale).

  /**
   * Forgets thread `thread`'s permission grants (the browser keeps them per
   * thread until a shell revokes them). Only a shell page's broker can, so a
   * page does it (`shell.forgetThreadPermissions`); with none connected, the
   * next page to connect does.
   */
  private async forgetThreadPermissions(thread: string): Promise<{ revoked?: number; queued?: boolean }> {
    try {
      const result = await this.relay.json<{ revoked?: number } | null>("forget_thread_permissions", { thread });
      return { revoked: result?.revoked ?? 0 };
    } catch (error) {
      if (!(error instanceof RelayError) || (error.status !== 503 && error.status !== 504)) throw error;
      this.threadsToForget.add(thread);
      return { queued: true };
    }
  }

  private forgetPendingThreadPermissions(): void {
    const threads = [...this.threadsToForget];
    this.threadsToForget.clear();
    for (const thread of threads) {
      void this.forgetThreadPermissions(thread).catch((error: Error) =>
        console.warn(`plutoniumd: can't forget ${thread}'s permissions: ${error.message}`),
      );
    }
  }

  /**
   * The server's tabs no shell page shows: the helper opens them itself
   * (serverTabs.ts, "open"), straight from the browser, so the server needn't
   * wait for a page. Without the Plutonium domain the server waits as before.
   */
  private openServerTabs(serverTabs: ServerTabs, desktop: Desktop): void {
    const opening = new Set<string>();
    serverTabs.onOpen = (key, tag, incognito) => {
      const id = `${key.threadId}\u0000${key.tabId}`;
      if (opening.has(id)) return;
      opening.add(id);
      void (async () => {
        if (!(await desktop.available())) return;
        const tab = await desktop.createTab("about:blank", [tag], { incognito });
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
    serverTabs.onRequestPermissions = async (browserTabId, permissions, origin) =>
      (await desktop.tabCommand(browserTabId, "permission-request", {
        permissions,
        ...(origin ? { origin } : {}),
        by: "agent",
      })) as PermissionAnswer | null;
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
    this.agentWindows.touch(windowId);
    const timer = this.awakeWindows.get(windowId);
    if (timer) clearTimeout(timer);
    else {
      void desktop.setWindowAwake(windowId, true).catch(() => {});
      // The app stays focused between the agent's keys (a browser without
      // this focuses it for each batch of keys only).
      void desktop.setWindowAgentFocus(windowId, true).catch(() => {});
    }
    const expiry = setTimeout(() => {
      this.awakeWindows.delete(windowId);
      this.lastInput.delete(windowId);
      if (!this.streamedWindows.has(windowId)) void desktop.setWindowAwake(windowId, false).catch(() => {});
      void desktop.setWindowAgentFocus(windowId, false).catch(() => {});
    }, AWAKE_MS);
    expiry.unref();
    this.awakeWindows.set(windowId, expiry);
  }

  /** Keeps a window drawing at full rate while any stream of it is open. */
  private streamAwake(desktop: Desktop, windowId: number, on: boolean): void {
    const count = (this.streamedWindows.get(windowId) ?? 0) + (on ? 1 : -1);
    if (count > 0) this.streamedWindows.set(windowId, count);
    else this.streamedWindows.delete(windowId);
    if (on && count === 1) void desktop.setWindowAwake(windowId, true).catch(() => {});
    // An agent's input keeps it awake by itself (keepAwake).
    if (count === 0 && !this.awakeWindows.has(windowId)) {
      void desktop.setWindowAwake(windowId, false).catch(() => {});
    }
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
    const keys = (events: ReturnType<typeof comboKeys>) =>
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
        const layout = await desktop.keymap();
        let runs;
        try {
          runs = typingRuns(body.text, layout);
        } catch (error) {
          throw new HttpError(400, (error as Error).message);
        }
        // In batches, so a long text doesn't hold the keyboard all at once, and
        // apart: Exo drops a client that can't keep up (a busy LibreOffice died
        // of a poem typed back to back). Each batch is a focus blip
        // (docs/features/AGENT_CONTROL.md, Limits), so they stay big enough for
        // what fills a field.
        // And a pause after each Tab or Enter, while the app commits.
        // Characters the layout lacks go in under a temporary keymap, with a
        // pause each side for the app (and Xwayland) to take it.
        let first = true;
        for (const { keymap, events } of runs) {
          if (keymap) {
            await desktop.setWindowKeymap(windowId, keymap).catch((error: Error) => {
              throw new HttpError(409, error.message);
            });
            await sleep(KEYMAP_GAP_MS);
          }
          try {
            for (const run of commitRuns(events)) {
              if (!first) await sleep(COMMIT_GAP_MS);
              first = false;
              for (let i = 0; i < run.length; i += TYPE_BATCH) {
                if (i > 0) await sleep(TYPE_BATCH_GAP_MS);
                await keys(run.slice(i, i + TYPE_BATCH));
              }
            }
          } finally {
            if (keymap) {
              await sleep(KEYMAP_GAP_MS);
              await desktop.setWindowKeymap(windowId).catch(() => {});
            }
          }
        }
        break;
      }
      case "press": {
        const combos = Array.isArray(body.keys) ? body.keys : [body.keys];
        if (!combos.every((combo) => typeof combo === "string" && combo)) {
          throw new HttpError(400, "keys must be a key combination or a list of them.");
        }
        const layout = await desktop.keymap();
        let events;
        try {
          events = (combos as string[]).flatMap((combo) => comboKeys(combo, layout));
        } catch (error) {
          throw new HttpError(400, (error as Error).message);
        }
        let first = true;
        for (const run of commitRuns(events)) {
          if (!first) await sleep(COMMIT_GAP_MS);
          first = false;
          await keys(run);
        }
        break;
      }
      case "resize": {
        if (typeof body.width !== "number" || typeof body.height !== "number") {
          throw new HttpError(400, "width and height are required.");
        }
        const size = { width: Math.round(body.width), height: Math.round(body.height) };
        if (size.width < 1 || size.height < 1) throw new HttpError(400, "width and height must be positive.");
        const held = this.agentWindows.hold(windowId, size.width, size.height);
        const shown = desktop.window(windowId)?.embedded === true;
        if (!held && shown) {
          throw new HttpError(
            409,
            "The user took control of this window's size: it's shown at the size they gave it.",
          );
        }
        // Shown: the shell follows the agent's size (T3 Code does; other shells size it themselves).
        if (!shown) {
          await desktop.resizeWindow(windowId, size.width, size.height).catch((error: Error) => {
            throw new HttpError(409, error.message);
          });
        }
        await this.waitForSizes(new Set([windowId]), size, 1_000);
        const now = desktop.window(windowId);
        return { width: now?.width, height: now?.height };
      }
      default:
        throw new HttpError(400, "action must be move, click, drag, scroll, type, press or resize.");
    }
    return {};
  }

  /** A window's open popups (menus), in snapshot_window's pixels. */
  async windowPopups(windowId: number): Promise<{ x: number; y: number; width: number; height: number }[]> {
    const desktop = await this.direct();
    if (!desktop) return [];
    const scale = desktop.window(windowId)?.deviceScaleFactor || 1;
    const popups = await desktop.windowPopups(windowId).catch(() => []);
    return popups.map((popup) => ({
      x: Math.round(popup.x * scale),
      y: Math.round(popup.y * scale),
      width: Math.round(popup.width * scale),
      height: Math.round(popup.height * scale),
    }));
  }

  /**
   * Runs an agent's action in a window, then says what changed: the
   * thread's windows that opened (a dialog) or closed since its agent last
   * heard (reportedWindows), and the window's open menus, so the agent
   * needn't snapshot to find out.
   */
  private async withWindowChanges(
    threadId: string,
    windowId: number,
    action: unknown,
    run: () => Promise<unknown>,
  ): Promise<unknown> {
    if (action === "resize" || !(await this.direct())) return run();
    const before =
      this.reportedWindows.get(threadId) ?? new Set((await this.threadWindows(threadId)).map((window) => window.id));
    const popupsBefore = (await this.windowPopups(windowId)).length;
    const result = await run();
    await sleep(ACTION_SETTLE_MS);
    const after = await this.threadWindows(threadId);
    this.reportedWindows.set(threadId, new Set(after.map((window) => window.id)));
    const changes: Record<string, unknown> = {};
    const opened = after.filter((window) => !before.has(window.id));
    if (opened.length) {
      changes.newWindows = opened.map(
        (window) =>
          `new window #${window.id} (${window.title ? JSON.stringify(window.title) : "untitled"}, ${window.width}×${window.height})`,
      );
    }
    const closed = [...before].filter((id) => !after.some((window) => window.id === id));
    if (closed.length) changes.closedWindows = closed.map((id) => `window #${id} closed`);
    const popups = await this.windowPopups(windowId);
    if (popups.length) changes.popups = popups;
    else if (popupsBefore) changes.popups = "closed";
    if (!Object.keys(changes).length) return result;
    return result && typeof result === "object" && !Array.isArray(result) ? { ...result, ...changes } : { result, ...changes };
  }

  /** The window as accessibility knows it (its pid, title and size). */
  private async a11yWindow(threadId: string, windowId: number) {
    const entry = await this.ownedWindow(threadId, windowId);
    const window = (await this.direct())?.window(windowId);
    return {
      id: windowId,
      pid: entry.pid,
      title: entry.title,
      width: entry.width,
      height: entry.height,
      deviceScaleFactor: window?.deviceScaleFactor || entry.deviceScaleFactor || 1,
    };
  }

  /** read_window: the window (or one element) as an accessibility outline. */
  async readWindow(threadId: string, windowId: number, ref?: string, all = false): Promise<string> {
    const window = await this.a11yWindow(threadId, windowId);
    try {
      return await this.a11y.read(window, { ref, all });
    } catch (error) {
      if (error instanceof A11yError) throw new HttpError(409, error.message);
      throw error;
    }
  }

  /** act_window: an action on an element of the window, by its ref from read_window. */
  async actInWindow(threadId: string, windowId: number, body: Record<string, unknown>): Promise<unknown> {
    const window = await this.a11yWindow(threadId, windowId);
    if (typeof body.ref !== "string" || !body.ref) throw new HttpError(400, "ref is required.");
    if (typeof body.action !== "string" || !body.action) throw new HttpError(400, "action is required.");
    const desktop = await this.direct();
    if (desktop) this.keepAwake(desktop, windowId);
    let result;
    try {
      result = await this.a11y.act(window, body.ref, body.action, {
        text: typeof body.text === "string" ? body.text : undefined,
        value: typeof body.value === "number" ? body.value : undefined,
      });
    } catch (error) {
      if (error instanceof A11yError) throw new HttpError(409, error.message);
      throw error;
    }
    if ("click" in result) {
      // No action of its own: a click at its center.
      const [x, y] = result.click;
      await this.windowInput(threadId, windowId, { action: "click", x, y });
      return { done: `clicked at ${x},${y}${result.why ? ` (${result.why})` : ""}` };
    }
    return result;
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
    if (path.startsWith("/v1/shells/")) {
      await this.handleShells(request, response, url, local);
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
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE",
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
          url.searchParams.get("display") ?? "",
        );
        this.forgetPendingThreadPermissions();
        return;
      }
      const visibility = path.match(/^\/v1\/shell\/pages\/([\w-]+)\/visibility$/);
      if (method === "POST" && visibility) {
        const { visible } = JSON.parse((await readBody(request)).toString("utf8") || "{}") as { visible?: boolean };
        const found = this.relay.setVisible(visibility[1]!, visible !== false);
        response.writeHead(found ? 204 : 404).end();
        return;
      }
      // EXO-CAPTURE: a shell caught a key an app bound through the portal.
      if (method === "POST" && path === "/v1/shell/global-shortcut") {
        const { session, id, phase } = await readJson(request);
        const known =
          typeof session === "string" &&
          typeof id === "string" &&
          (phase === "activated" || phase === "deactivated") &&
          (this.portal?.shortcut(session, id, phase) ?? false);
        response.writeHead(known ? 204 : 404).end();
        return;
      }
      // Desktop services (services.ts): what there is, a service's state, an action.
      if (method === "GET" && path === "/v1/shell/system") {
        return sendJson(response, 200, {
          services: this.services.names().map((name) => ({ name, allowed: this.mayUse(origin, name) })),
        });
      }
      const system = path.match(/^\/v1\/shell\/system\/([a-z]+)(?:\/([\w-]+))?$/);
      if (system) {
        const [, name, action] = system as unknown as [string, string, string | undefined];
        if (!this.mayUse(origin, name)) {
          throw new HttpError(403, `This shell doesn't use "${name}": add it to "uses" in its shell.json.`);
        }
        try {
          if (method === "GET" && !action) return sendJson(response, 200, await this.services.state(name));
          if (method === "POST" && action) {
            const args = (await readJson(request)) as Record<string, unknown>;
            return sendJson(response, 200, {
              value: (await this.services.call(name, action, args ?? {}, this.callerOf(origin))) ?? null,
            });
          }
        } catch (error) {
          if (error instanceof ServiceError) throw new HttpError(error.status, error.message);
          throw error;
        }
      }
      // An installed shell's storage and native side (shellNative.ts).
      const own = path.match(/^\/v1\/shell\/(storage|native)(?:\/([\w.$-]+))?$/);
      if (own) {
        const [, kind, key] = own as unknown as [string, string, string | undefined];
        const shell = this.options.shells?.byOrigin(origin);
        if (!shell || !this.native) throw new HttpError(403, "Only an installed shell has storage and a native side.");
        try {
          if (kind === "native" && key && method === "POST") {
            return sendJson(response, 200, { value: (await this.native.call(shell, key, await readJson(request))) ?? null });
          }
          if (kind === "storage" && !key && method === "GET") return sendJson(response, 200, { keys: this.native.keys(shell.name) });
          if (kind === "storage" && key && method === "GET") {
            const value = this.native.get(shell.name, key);
            if (value === undefined) throw new HttpError(404, `Nothing stored at "${key}".`);
            return sendJson(response, 200, { value });
          }
          if (kind === "storage" && key && method === "PUT") {
            this.native.set(shell.name, key, (await readJson(request)).value);
            return void response.writeHead(204).end();
          }
          if (kind === "storage" && key && method === "DELETE") {
            this.native.delete(shell.name, key);
            return void response.writeHead(204).end();
          }
        } catch (error) {
          if (error instanceof NativeError) throw new HttpError(error.status, error.message);
          throw error;
        }
      }
      if (method === "POST" && path === "/v1/shell/origins") {
        // The browser's shells, from a page that is already a shell: what
        // the shells overlay added or removed.
        const { origins, shells } = await readJson(request);
        if (!Array.isArray(origins)) throw new HttpError(400, "origins must be an array.");
        this.reportedOrigins = new Set(origins.filter(isOrigin));
        // The whole list, in order: shells.json follows the switcher.
        if (Array.isArray(shells)) {
          this.options.shells?.browserList(
            shells.filter(
              (shell): shell is BrowserShell =>
                typeof shell?.name === "string" && typeof shell.url === "string" && typeof shell.enabled === "boolean",
            ),
          );
        }
        response.writeHead(204).end();
        return;
      }
      if (method === "POST" && (path === "/v1/shell/server-tabs" || path === "/v1/shell/server-tabs/detach")) {
        if (!this.serverTabs) throw new HttpError(409, "This helper has no DevTools port (--cdp-port).");
        const { page, threadId, tabId, targetId, browserTabId, url, title, replace } = await readJson(request);
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
          replace === true,
        );
        return sendJson(response, 200, { browserTabId: shownTabId });
      }
      // The user took control of a window an agent held the size of.
      const release = path.match(/^\/v1\/shell\/windows\/(\d+)\/release$/);
      if (method === "POST" && release) {
        this.agentWindows.release(Number(release[1]));
        response.writeHead(204).end();
        return;
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
    if (method === "GET" && path === "/v1/shells") {
      return sendJson(response, 200, this.options.shells?.status() ?? []);
    }
    if (method === "GET" && path === "/v1/displays") {
      return sendJson(response, 200, await this.displays());
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
    if (method === "GET" && path === "/v1/apps/find") {
      return sendJson(response, 200, this.apps.find(url.searchParams.get("filter") || undefined));
    }
    // EXO-TAB-FEATURES: the host's files, for the file picker.
    if (path === "/v1/files" || path.startsWith("/v1/files/")) {
      try {
        if (method === "GET" && path === "/v1/files") {
          const hidden = url.searchParams.get("hidden") === "1";
          return sendJson(response, 200, await listDirectory(url.searchParams.get("dir") ?? "", { hidden }));
        }
        if (method === "GET" && path === "/v1/files/count") {
          return sendJson(response, 200, await countFiles(url.searchParams.get("dir") ?? ""));
        }
        if (method === "GET" && path === "/v1/files/places") {
          return sendJson(response, 200, { places: places(), recent: recentFiles() });
        }
        if (method === "POST" && path === "/v1/files/folder") {
          const { path: folder } = await readJson(request);
          return sendJson(response, 200, await makeFolder(typeof folder === "string" ? folder : ""));
        }
      } catch (error) {
        if (error instanceof FilesError) throw new HttpError(error.status, error.message);
        throw error;
      }
    }
    const icon = path.match(/^\/v1\/apps\/([^/]+)\/icon$/);
    if (method === "GET" && icon) {
      const found = this.apps.icon(decodeURIComponent(icon[1]!));
      if (!found) throw new HttpError(404, "No icon.");
      response.writeHead(200, { "Content-Type": found.contentType, "Cache-Control": "max-age=3600" });
      response.end(found.data);
      return;
    }
    // EXO-TAB-FEATURES: printing (src/printing.ts).
    if (method === "GET" && path === "/v1/printers") {
      return sendJson(response, 200, {
        ...(await listPrinters()),
        defaultPdfPath: defaultPdfPath(url.searchParams.get("title") ?? ""),
      });
    }
    // EXO-CAPTURE: a screenshot (a PNG body) into ~/Pictures/Screenshots.
    if (method === "POST" && path === "/v1/screenshots") {
      const png = await readBody(request);
      try {
        return sendJson(response, 200, saveScreenshot(png));
      } catch (error) {
        throw new HttpError(400, (error as Error).message);
      }
    }
    if (method === "POST" && (path === "/v1/print" || path === "/v1/print/save")) {
      const pdf = await readBody(request);
      if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new HttpError(400, "Expected a PDF.");
      const query = url.searchParams;
      try {
        if (path === "/v1/print/save") {
          const target = query.get("path") || defaultPdfPath(query.get("title") ?? "");
          return sendJson(response, 200, savePdf(pdf, target, { overwrite: query.get("overwrite") === "1" }));
        }
        const copies = query.get("copies");
        const color = query.get("color");
        return sendJson(
          response,
          200,
          await printPdf(pdf, {
            printer: query.get("printer") || undefined,
            copies: copies ? Number(copies) : undefined,
            duplex: (query.get("duplex") || undefined) as "none" | "long-edge" | "short-edge" | undefined,
            color: color === null ? undefined : color === "1",
            title: query.get("title") || undefined,
          }),
        );
      } catch (error) {
        throw new HttpError(400, (error as Error).message);
      }
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
      const { thread, argv, cwd, waitMs, show, agent, width, height } = body;
      if (typeof thread !== "string" || !thread) throw new HttpError(400, "thread is required.");
      if (!Array.isArray(argv) || argv.length === 0 || !argv.every((arg) => typeof arg === "string")) {
        throw new HttpError(400, "argv must be a non-empty array of strings.");
      }
      const sized = typeof width === "number" && typeof height === "number";
      if (sized && (width < 1 || height < 1)) throw new HttpError(400, "width and height must be positive.");
      if ((typeof width === "number") !== (typeof height === "number")) {
        throw new HttpError(400, "Give both width and height, or neither.");
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
          agent === true || sized
            ? { size: sized ? { width: Math.round(width), height: Math.round(height) } : undefined }
            : undefined,
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
      // EXO-CAPTURE: an agent records one of its thread's windows or tabs.
      const recordings = path.match(/^\/v1\/threads\/([^/]+)\/recordings(?:\/(\d+)\/stop|\/stop)?$/);
      if (recordings) {
        const threadId = decodeURIComponent(recordings[1]!);
        if (method === "GET" && !path.endsWith("/stop")) {
          return sendJson(response, 200, this.recordings?.list(threadId) ?? []);
        }
        if (method === "POST") {
          const body = await readJson(request);
          if (path.endsWith("/stop")) {
            return sendJson(response, 200, await this.stopRecording(threadId, recordings[2] ? Number(recordings[2]) : undefined));
          }
          return sendJson(response, 200, await this.startRecording(threadId, body));
        }
      }
      // EXO-TAB-PERMISSIONS: a frontend archived or deleted a thread (T3 Code's server).
      const forget = path.match(/^\/v1\/threads\/([^/]+)\/permissions\/forget$/);
      if (method === "POST" && forget) {
        return sendJson(response, 200, await this.forgetThreadPermissions(decodeURIComponent(forget[1]!)));
      }
      // The hardware keys (volume, brightness, media) Ash hands over in shell mode.
      if (method === "POST" && path === "/v1/system/key") {
        const { key } = await readJson(request);
        return sendJson(response, 200, { handled: await this.systemKey(String(key)) });
      }
      // EXO-LOCK: from Ash: Super+L, and the password typed on the lock.
      if (method === "POST" && path === "/v1/session/lock") {
        try {
          await this.services.call("session", "lock", {});
        } catch (error) {
          if (error instanceof ServiceError) throw new HttpError(error.status, error.message);
          throw error;
        }
        return sendJson(response, 200, { ok: true });
      }
      if (method === "POST" && path === "/v1/session/unlock") {
        const { password } = await readJson(request);
        if (typeof password !== "string") throw new HttpError(400, "password is required.");
        return sendJson(response, 200, await this.session.unlock(password));
      }
      // EXO-TAB-FEATURES: the browser's "open" and "show" for a download.
      if (method === "POST" && path === "/v1/downloads/open") {
        const { path: file, thread, show } = await readJson(request);
        if (typeof file !== "string" || !file) throw new HttpError(400, "path is required.");
        await this.openDownload(file, typeof thread === "string" ? thread : "", show === true);
        return sendJson(response, 200, { ok: true });
      }
      const downloads = path.match(/^\/v1\/threads\/([^/]+)\/downloads$/);
      if (method === "GET" && downloads) {
        return sendJson(response, 200, await this.threadDownloads(decodeURIComponent(downloads[1]!)));
      }
      const downloadAction = path.match(/^\/v1\/threads\/([^/]+)\/downloads\/(\d+)\/(\w+)$/);
      if (method === "POST" && downloadAction) {
        return sendJson(
          response,
          200,
          await this.downloadAction(
            decodeURIComponent(downloadAction[1]!),
            Number(downloadAction[2]),
            downloadAction[3]!,
          ),
        );
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
          if (what === "focus") {
            return sendJson(response, 200, await this.focusTab(threadId, tabId, displayOf(body.display)));
          }
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
          // EXO-TAB-FEATURES: {command, args?}; {kind, answer}.
          if (what === "command") {
            if (typeof body.command !== "string" || !body.command) throw new HttpError(400, "command is required.");
            const args =
              body.args && typeof body.args === "object" ? (body.args as Record<string, unknown>) : undefined;
            return sendJson(response, 200, await this.runTabCommand(threadId, tabId, body.command, args));
          }
          if (what === "request") {
            if (typeof body.kind !== "string" || !body.kind) throw new HttpError(400, "kind is required.");
            return sendJson(response, 200, await this.answerTabRequest(threadId, tabId, body.kind, body.answer));
          }
          if (what === "print") return sendJson(response, 200, await this.printTab(threadId, tabId, body));
          if (what === "page") return sendJson(response, 200, await this.pageAction(threadId, tabId, body));
        }
      }
      // The user's own view of windows from elsewhere (a frontend's server
      // streams them to its remote clients): every window, its frames, input.
      if (method === "GET" && path === "/v1/windows") {
        return sendJson(response, 200, await this.allWindows());
      }
      const userWindow = path.match(/^\/v1\/windows\/(\d+)\/(stream|mouse|keys)$/);
      if (userWindow) {
        const desktop = await this.requireDirect("Streaming windows");
        const windowId = Number(userWindow[1]);
        if (!desktop.window(windowId)) throw new HttpError(404, `No window ${windowId}.`);
        if (method === "GET" && userWindow[2] === "stream") {
          const size = (name: string) => Number(url.searchParams.get(name)) || undefined;
          return streamWindow(
            desktop,
            windowId,
            { quality: size("quality"), maxWidth: size("maxWidth"), maxHeight: size("maxHeight") },
            response,
            (on) => this.streamAwake(desktop, windowId, on),
          );
        }
        if (method === "POST" && userWindow[2] === "mouse") {
          await desktop.mouse(windowId, (await readJson(request)) as unknown as WindowMouseEvent);
          return void response.writeHead(204).end();
        }
        if (method === "POST" && userWindow[2] === "keys") {
          const { events } = await readJson(request);
          if (!Array.isArray(events)) throw new HttpError(400, "Give events.");
          await desktop.keys(windowId, events as WindowKeyEvent[]);
          return void response.writeHead(204).end();
        }
      }
      const windows = path.match(/^\/v1\/threads\/([^/]+)\/windows$/);
      if (method === "GET" && windows) {
        const threadId = decodeURIComponent(windows[1]!);
        const entries = await this.threadWindows(threadId);
        this.reportedWindows.set(threadId, new Set(entries.map((entry) => entry.id)));
        return sendJson(
          response,
          200,
          entries.map((entry) => threadWindow(entry, this.agentWindows.get(entry.id))),
        );
      }
      const action = path.match(/^\/v1\/threads\/([^/]+)\/windows\/(\d+)\/(focus|close|snapshot|input|a11y)$/);
      if (action) {
        const threadId = decodeURIComponent(action[1]!);
        const windowId = Number(action[2]);
        if (method === "GET" && action[3] === "snapshot") {
          const png = await this.snapshot(threadId, windowId);
          const popups = await this.windowPopups(windowId);
          response.writeHead(200, {
            "Content-Type": "image/png",
            ...(popups.length ? { "X-Plutonium-Popups": JSON.stringify(popups) } : {}),
          });
          response.end(png);
          return;
        }
        if (method === "POST" && action[3] === "focus") {
          const body = await readJson(request);
          return sendJson(response, 200, await this.focus(threadId, windowId, displayOf(body.display)));
        }
        if (method === "POST" && action[3] === "close") {
          return sendJson(response, 200, await this.close(threadId, windowId));
        }
        if (method === "GET" && action[3] === "a11y") {
          const text = await this.readWindow(
            threadId,
            windowId,
            url.searchParams.get("ref") ?? undefined,
            url.searchParams.get("all") === "1",
          );
          response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          response.end(text);
          return;
        }
        if (method === "POST" && action[3] === "a11y") {
          try {
            const body = await readJson(request);
            return sendJson(
              response,
              200,
              await this.withWindowChanges(threadId, windowId, body.action, () =>
                this.actInWindow(threadId, windowId, body),
              ),
            );
          } finally {
            this.lastInput.set(windowId, Date.now());
          }
        }
        if (method === "POST" && action[3] === "input") {
          try {
            const body = await readJson(request);
            return sendJson(
              response,
              200,
              await this.withWindowChanges(threadId, windowId, body.action, () =>
                this.windowInput(threadId, windowId, body),
              ),
            );
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

  // The installed shells (shellPackages.ts): for the switcher (the socket),
  // the shells page (/v1/shells/page/, on the helper's own origin, as the
  // terminal page is) and shells.
  private async handleShells(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    local: boolean,
  ): Promise<void> {
    const method = request.method ?? "GET";
    const path = url.pathname;
    if (method === "GET" && (path === "/v1/shells/page" || path === "/v1/shells/page/")) {
      if (path === "/v1/shells/page") return void response.writeHead(308, { Location: "/v1/shells/page/" }).end();
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        "Content-Security-Policy": "frame-ancestors 'none'",
        "X-Frame-Options": "DENY",
      });
      response.end(readFileSync(SHELLS_PAGE));
      return;
    }
    if (!local) {
      const uid = loopbackPeerUid(request.socket.remotePort ?? 0, this.options.port);
      const origin = request.headers.origin;
      const page = request.headers["sec-fetch-site"] === "same-origin" &&
        (origin === undefined || origin === `http://127.0.0.1:${this.options.port}`);
      if (uid !== process.getuid?.() || !(page || (origin && this.isShellOrigin(origin)))) {
        throw new HttpError(403, "Only the shells page, a shell or the switcher may use this.");
      }
      if (origin && !page) {
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Vary", "Origin");
      }
    }
    const shells = this.options.shells;
    if (!shells) throw new HttpError(404, "This session has no installed shells.");
    try {
      if (method === "GET" && path === "/v1/shells/list") return sendJson(response, 200, shells.status());
      if (method === "POST" && path === "/v1/shells/add") return sendJson(response, 200, shells.add(await readJson(request)));
      if (method === "POST" && path === "/v1/shells/new") return sendJson(response, 200, shells.create(await readJson(request)));
      if (method === "GET" && path === "/v1/shells/prompt") {
        return sendJson(response, 200, { skill: shells.skillPath(), new: shells.newShellPrompt() });
      }
      if (method === "GET" && path === "/v1/shells/wait") {
        await shells.whenServersUp();
        return sendJson(response, 200, shells.status());
      }
      const match = path.match(/^\/v1\/shells\/([a-z0-9-]+)\/([a-z]+)$/);
      if (!match) throw new HttpError(404, "No such shells request.");
      const [, name, what] = match as unknown as [string, string, string];
      if (method === "GET" && ["log", "history", "diff"].includes(what)) {
        response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        response.end(shells.text(name, what));
        return;
      }
      if (method === "POST") return sendJson(response, 200, (await shells.action(name, what, await readJson(request))) ?? {});
      throw new HttpError(405, "GET or POST.");
    } catch (error) {
      if (error instanceof ShellError) throw new HttpError(400, error.message);
      throw error;
    }
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
    const { shells, shellsPort } = this.options;
    if (shells && shellsPort) {
      // http://<name>.localhost:<port>/: Chromium resolves *.localhost to
      // loopback itself, both addresses.
      for (const host of ["127.0.0.1", "::1"]) {
        const server = createServer((request, response) => shells.serve(request, response));
        this.servers.push(server);
        await new Promise<void>((resolve, reject) => {
          server.once("error", (error) => (host === "::1" ? resolve() : reject(error))).listen(shellsPort, host, resolve);
        });
      }
    }
    shells?.start(this.options.shellOrigins);
    console.log(
      `plutoniumd: ${this.options.waylandDisplay}, shells ${this.options.shellOrigins.join(" ")}, ` +
        `socket ${socketPath}, shell API http://127.0.0.1:${port}` +
        (shells && shellsPort ? `, shells from ${shells.home} on http://<name>.localhost:${shellsPort}` : "") +
        (this.options.cdpPort ? `, server-driven tabs on DevTools ${this.options.cdpPort}` : ""),
    );
    // Ash usually starts after the helper: check the GPU once Exo is up.
    const check = setInterval(() => {
      void this.gpu().then((gpu) => gpu && clearInterval(check));
    }, 2000);
    setTimeout(() => clearInterval(check), 120_000).unref();
    check.unref();
    // Apps' and tabs' notifications reach the shells from the start, whether or not one shows
    // them yet (on the bus only in the user's own session: notificationsOnBus).
    if (this.options.cdpPort && process.env.PLUTONIUM_NOTIFICATIONS !== "0") {
      this.services
        .state("notifications")
        .catch((error: unknown) => console.warn(`plutoniumd: no notifications: ${(error as Error).message}`));
    }
    // EXO-LOCK: idle, logind and apps' inhibitors from the start.
    if (this.options.cdpPort) {
      this.services.state("session").catch((error: unknown) => console.warn(`plutoniumd: no session: ${(error as Error).message}`));
    }
    if (this.desktop) {
      const desktop = this.desktop;
      // Connected whenever the browser is up, so its events (tabs' notifications) arrive
      // without waiting for something to ask it.
      setInterval(() => void desktop.available(true), 5000).unref();
      // EXO-SERVICES: Ash's dark mode follows the host's color scheme.
      const appearance = new Appearance();
      this.appearance = appearance;
      const apply = (retry = true) => {
        const dark = appearance.current;
        if (dark === null) return;
        void desktop.setColorScheme(dark).then((done) => {
          // Before the user session is up: once more, a little later.
          if (!done && retry) setTimeout(() => apply(false), 3000).unref();
        });
      };
      appearance.onChange(() => apply());
      desktop.enableListeners.add(() => apply());
      void appearance.start();
      void desktop.available(true);
    }
    if (this.desktop) {
      const desktop = this.desktop;
      const recordings = new Recordings({ captureCommand: (command, args) => desktop.captureCommand(command, args) });
      desktop.captureListeners.add((type, capture) => recordings.onCapture(type, capture));
      this.recordings = recordings;
    }
    // EXO-CAPTURE: apps' screen captures and screenshots, through the browser.
    if (this.desktop && process.env.PLUTONIUM_PORTAL !== "0") {
      const portal = new Portal({
        desktop: this.desktop,
        apps: this.apps,
        threadForPid,
        askShell: async (op, args, timeoutMs) => {
          const reply = await this.relay.request(op, args, timeoutMs);
          return reply.kind === "json" ? reply.value : null;
        },
        notifyShells: (op, args) => this.relay.notifyAll(op, args),
        windows: () => this.relay.windows(),
        inhibit: (key, who, why) => this.session.portalInhibit(key, who, why),
        uninhibit: (key) => this.session.portalUninhibit(key),
      });
      portal.start().then(
        () => (this.portal = portal),
        (error: unknown) => console.warn(`plutoniumd: no portal backend: ${(error as Error).message}`),
      );
    }
  }

  stop(): void {
    this.options.shells?.stop();
    this.services.stop();
    this.native?.stopAll();
    this.portal?.stop();
    this.recordings?.stopAll();
    this.appearance?.stop();
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

/**
 * Whether the helper is the session bus's notification server: only in the user's own session
 * (slot 0) by default, since a test session in another slot would take the host desktop's
 * notifications (PLUTONIUM_NOTIFICATIONS=1 serves them anyway, =0 turns the service off).
 */
function notificationsOnBus(options: DaemonOptions): boolean {
  const slot = options.shells?.context.slot ?? 0;
  return (process.env.PLUTONIUM_NOTIFICATIONS ?? (slot === 0 ? "1" : "0")) !== "0";
}

/** Reloads the browser's pages on `origin`, bypassing the cache; returns how many. */
async function reloadPages(cdp: BrowserCdp, origin: string): Promise<number> {
  const { targetInfos } = (await cdp.send("Target.getTargets")) as {
    targetInfos: { targetId: string; type: string; url: string }[];
  };
  let reloaded = 0;
  for (const target of targetInfos) {
    let targetOrigin: string;
    try {
      targetOrigin = new URL(target.url).origin;
    } catch {
      continue;
    }
    if (target.type !== "page" || targetOrigin !== origin) continue;
    const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })) as {
      sessionId: string;
    };
    await cdp.send("Page.reload", { ignoreCache: true }, sessionId).catch(() => {});
    await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    reloaded++;
  }
  return reloaded;
}
