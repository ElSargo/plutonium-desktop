// Server-driven browser tabs: a frontend's server drives some of the shell's
// tabs itself, with the DevTools protocol (T3 Code drives them with Playwright,
// as it drives the tabs its desktop app renders). The shell creates the tab and
// shows it; this file is the server's way in.
//
// The protocol is T3 Code's desktop browser channel (DesktopBrowserEvent and
// DesktopBrowserCommand in its contracts): newline-delimited JSON over one
// connection, here an upgraded request on the helper's Unix socket.
//   helper → server  {type: "attached" | "detached", threadId, tabId}
//                    {type: "cdp", threadId, tabId, message}
//   server → helper  {type: "cdp", threadId, tabId, message}
//                    {type: "release", threadId, tabId}
//                    {type: "pointer", threadId, tabId, phase, x, y}
//                    {type: "open", threadId, tabId, tag, incognito?} (Plutonium's own)
//                    {type: "close", threadId, tabId}       (Plutonium's own)
//                    {type: "scratch", threadId, tabId}     (Plutonium's own)
//                    {type: "recording", threadId, tabId, phase: "start" | "stop"}
//   helper → server  {type: "recording", threadId, tabId,    (Plutonium's own)
//                     phase: "started" | "refused" | "ended", message?}
// (threadId and tabId are the server's names for the tab.)
//
// "open": the server has a tab no shell page shows (none is open, or none
// shows the thread). The helper opens one itself, tagged `tag` (the thread's
// Plutonium tag; with `incognito`, in throwaway storage of its own), and
// attaches it as the page HELPER_PAGE: the server drives
// it at once instead of waiting for a page and then going headless. A shell
// page that shows the tab later adopts it, as it would another page's.
// "close": the server's tab closed; the helper closes the tab if it opened it
// (a shell page closes its own).
// "scratch": the server wants a page for its own work (a recording's encoder,
// which T3 Code would otherwise run in a headless browser of its own). The
// helper opens a hidden page, in no window and no shell, and attaches it as
// the page SCRATCH_PAGE; "close" or the server's disconnect closes it.
// "recording": the server records the tab its own way (T3 Code's
// preview_recording_*: screencast frames into an encoder on a scratch page).
// "start" registers it as a capture with no node (onCaptureStart), so every
// shell sees it and can stop it; the helper answers "started", or "refused"
// with why (the recording switch is off). "stop" ends the capture. When a
// shell, the switch or the tab going ends it first, the helper says "ended",
// and the server stops recording (docs/features/CAPTURE.md, "Agents").
//
// Each tab's CDP connection only reaches that tab's page: the relay below
// presents it as a browser with one page, the way T3 Code's desktop app does
// (apps/desktop/src/preview/CdpRelay.ts), on a flat session of the real
// browser's DevTools (cdp.ts). Of the browser's own commands it adds only
// Plutonium.getTabs, answered with that tab alone: the server reads whether a
// shell shows it (`embedded`) for preview_status's `visible`.
//
// Browser.grantPermissions asks the user, as the thread relay's does
// (pages.ts): the prompt a page's request gets, marked as the agent's, over
// this tab. It succeeds once the user allows, and fails if they don't.
import type { Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";

import { type BrowserCdp, type CdpEvent } from "./cdp.ts";
import { RelayDownloads } from "./relayDownloads.ts";
import { promptPermissions, REFUSAL_MEMORY_MS } from "./pages.ts";

export interface ServerTabKey {
  readonly threadId: string;
  readonly tabId: string;
}

const keyOf = ({ threadId, tabId }: ServerTabKey) => `${threadId}\u0000${tabId}`;

// PLUTONIUM_DEBUG_TABS=1: log the server's traffic.
const debug = process.env.PLUTONIUM_DEBUG_TABS ? (...args: unknown[]) => console.log("serverTabs:", ...args) : () => {};

// --- The relay (after T3 Code's CdpRelay) ---

interface RelayTarget {
  /** Sends a command to the tab's page, or to one of its child sessions (iframes, workers). */
  readonly send: (method: string, params: Record<string, unknown>, sessionId: string | undefined) => Promise<unknown>;
  readonly targetId: string;
  /** The browser's id for the tab (-1 for a scratch page). */
  readonly browserTabId: number;
  /** Cancels download `id` in the browser. */
  readonly cancelDownload: (id: number) => Promise<void>;
  readonly url: () => string;
  readonly title: () => string;
  readonly version: () => Promise<Record<string, unknown>>;
  /** The browser's Plutonium.Tab for the page (whether a shell shows it: `embedded`). */
  readonly tab: () => Promise<unknown>;
  /** Browser.grantPermissions: asks the user over the tab. */
  readonly grantPermissions: (params: Record<string, unknown>) => Promise<unknown>;
}

interface RelayConnection {
  /** One message from the server. */
  readonly receive: (raw: string) => void;
  /** One event from the page (`sessionId` undefined) or a child session. */
  readonly event: (method: string, params: unknown, sessionId: string | undefined) => void;
  /** Every event of the real browser's own connection (the downloads come from there). */
  readonly browserEvent: (event: CdpEvent) => void;
}

interface CdpCommand {
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
  readonly sessionId?: string;
}

const isCommand = (value: unknown): value is CdpCommand =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { id?: unknown }).id === "number" &&
  typeof (value as { method?: unknown }).method === "string";

const BROWSER_CONTEXT_ID = "plutonium-tab";
const ANNOUNCE = Symbol("announce");
/** The page name of tabs the helper opened for the server ("open"). */
export const HELPER_PAGE = "plutoniumd";
/** The page name of the server's hidden pages ("scratch"). */
export const SCRATCH_PAGE = "plutoniumd-scratch";
/** The page's root session id, as the server sees it. */
const PAGE_SESSION_ID = "plutonium-tab-page";

/** Browser-level commands that only need acknowledging for a page the shell owns. */
const ACKNOWLEDGED = new Set([
  "Target.setDiscoverTargets",
  // Revoking is the user's, as in the thread relay (pages.ts).
  "Browser.resetPermissions",
]);

function createRelay(target: RelayTarget, write: (message: string) => void): RelayConnection {
  const send = (message: Record<string, unknown>) => write(JSON.stringify(message));
  let attached = false;
  // Sessions this relay invented: extra page sessions all reach the one real
  // page session; other ids are the page's own child sessions.
  const sessions = new Map<string, "browser" | "page">([[PAGE_SESSION_ID, "page"]]);
  let sessionSequence = 0;
  const newSession = (kind: "browser" | "page") => {
    const sessionId = `plutonium-tab-${kind}-${++sessionSequence}`;
    sessions.set(sessionId, kind);
    return sessionId;
  };
  // Downloads go where the user's do: the browser's download behaviour is
  // the whole browser's, not this tab's. The server gets Playwright's events
  // for this tab's, and a link where it asked (relayDownloads.ts).
  const downloads = new RelayDownloads(
    (method, params) => attached && send({ method, params }),
    (tabId) => (attached && tabId === target.browserTabId && tabId >= 0 ? target.targetId : undefined),
    target.cancelDownload,
  );
  const targetInfo = () => ({
    targetId: target.targetId,
    type: "page",
    title: target.title(),
    url: target.url(),
    attached: true,
    canAccessOpener: false,
    browserContextId: BROWSER_CONTEXT_ID,
  });

  const browserCommand = async (command: CdpCommand): Promise<unknown> => {
    if (ACKNOWLEDGED.has(command.method)) return {};
    switch (command.method) {
      case "Browser.getVersion":
        return target.version();
      case "Browser.setDownloadBehavior":
        downloads.setBehavior(command.params ?? {});
        return {};
      case "Browser.cancelDownload":
        await downloads.cancel(command.params ?? {});
        return {};
      case "Browser.grantPermissions":
        return target.grantPermissions(command.params ?? {});
      // Plutonium's own: only this tab, so the server can tell whether it is on screen.
      case "Plutonium.getTabs":
        return { tabs: [await target.tab()] };
      case "Target.getTargetInfo":
        return {
          targetInfo: { targetId: "browser", type: "browser", title: "", url: "", attached: true, canAccessOpener: false },
        };
      case "Target.getBrowserContexts":
        return { browserContextIds: [] };
      case "Target.getTargets":
        return { targetInfos: [targetInfo()] };
      case "Target.attachToBrowserTarget":
        return { sessionId: newSession("browser") };
      case "Target.attachToTarget": {
        if (command.params?.["targetId"] !== target.targetId) {
          throw new Error("Only this tab's page can be attached.");
        }
        return { sessionId: newSession("page") };
      }
      case "Target.detachFromTarget": {
        const sessionId = command.params?.["sessionId"];
        if (typeof sessionId === "string" && sessionId !== PAGE_SESSION_ID) sessions.delete(sessionId);
        return {};
      }
      case "Target.setAutoAttach": {
        if (attached) return {};
        attached = true;
        // The page is announced once, right after this reply, as Chromium does.
        return {
          [ANNOUNCE]: {
            method: "Target.attachedToTarget",
            params: { sessionId: PAGE_SESSION_ID, targetInfo: targetInfo(), waitingForDebugger: false },
          },
        };
      }
      default:
        throw new Error(`Not supported for a Plutonium tab: ${command.method}`);
    }
  };

  const pageCommand = (command: CdpCommand): Promise<unknown> => {
    const child = sessions.get(command.sessionId!) === "page" ? undefined : command.sessionId;
    // The page is already running; only its new child frames and workers wait
    // for the debugger (the server auto-attaches with waitForDebuggerOnStart).
    if (command.method === "Runtime.runIfWaitingForDebugger" && child === undefined) {
      return Promise.resolve({});
    }
    return target.send(command.method, command.params ?? {}, child);
  };

  return {
    receive: (raw) => {
      let command: unknown;
      try {
        command = JSON.parse(raw);
      } catch {
        return;
      }
      if (!isCommand(command)) return;
      const result =
        command.sessionId === undefined || sessions.get(command.sessionId) === "browser"
          ? browserCommand(command)
          : pageCommand(command);
      const route = command.sessionId === undefined ? {} : { sessionId: command.sessionId };
      // Replies leave as commands finish, so a slow one never holds up the rest.
      void result.then(
        (value) => {
          const announce =
            typeof value === "object" && value !== null && ANNOUNCE in value
              ? (value as { [ANNOUNCE]: Record<string, unknown> })[ANNOUNCE]
              : undefined;
          send({ id: command.id, result: announce ? {} : (value ?? {}), ...route });
          if (announce) send(announce);
        },
        (cause: unknown) =>
          send({
            id: command.id,
            error: { code: -32000, message: cause instanceof Error ? cause.message : String(cause) },
            ...route,
          }),
      );
    },
    event: (method, params, sessionId) => {
      if (!attached) return;
      if (sessionId) {
        send({ method, params, sessionId });
        return;
      }
      for (const [id, kind] of sessions) if (kind === "page") send({ method, params, sessionId: id });
    },
    browserEvent: (event) => downloads.browserEvent(event),
  };
}

// --- The tabs ---

/** What the shell said about a tab it shows for the server. */
export interface ServerTabInfo {
  /** The page's DevTools target id. */
  readonly targetId: string;
  /** The browser's id for the tab (the window broker's). */
  readonly browserTabId: number;
  /** The shell page that showed it first (pointer events go there). */
  readonly page: string;
  readonly url: () => string;
  readonly title: () => string;
}

interface AttachedTab {
  readonly key: ServerTabKey;
  readonly info: ServerTabInfo;
  relay: RelayConnection | null;
  /** The real page session, while a relay uses it (`sessionId` once it is known). */
  session: Promise<string> | null;
  sessionId: string | null;
  /** Its child sessions (frames, workers), by real session id. */
  readonly children: Set<string>;
  /** While the server's input keeps the tab drawing (keepAwake): the timer that lets it sleep. */
  awake: ReturnType<typeof setTimeout> | null;
  /** Whether the server asked for focus emulation (Emulation.setFocusEmulationEnabled), which the page gets while awake. */
  focusEmulation: boolean;
  /** The last grantPermissions the user refused, and when. */
  refused: { key: string; at: number } | null;
  /** The capture of the server's recording of it ("recording"), once registered. */
  captureId: number | null;
}

/** The user's answer to a permission request (the tab command `permission-request`). */
export interface PermissionAnswer {
  readonly answer?: string;
  readonly scope?: string;
}

/** How long a tab the server sent input to stays at full frame rate. */
const AWAKE_MS = 60_000;

/**
 * Focus emulation, which Playwright turns on for every page it attaches to,
 * makes the browser count the page as captured and visible: it ran at full
 * frame rate, timers unthrottled, for as long as the server stayed connected,
 * whether or not anything showed it (seven idle tabs, two of them YouTube, on
 * the live desktop). The page gets it only while the tab is awake.
 */
const FOCUS_EMULATION = "Emulation.setFocusEmulationEnabled";

/**
 * How long Page.captureScreenshot gets before the browser's own tab capture
 * answers instead. DevTools' screenshot waits for the page's next frame to be
 * presented on a display, and a tab no shell shows is presented only when its
 * display draws: with the displays off (idle, on DRM) that never happens, and
 * every snapshot hung. The page still draws, so Plutonium.captureTab (a copy of
 * the tab's surface) has the frame.
 */
const SCREENSHOT_FALLBACK_MS = 1_500;

export interface Pointer extends ServerTabKey {
  readonly phase: "move" | "click";
  readonly x: number;
  readonly y: number;
}

export class ServerTabs {
  private readonly cdp: BrowserCdp;
  private readonly tabs = new Map<string, AttachedTab>();
  /** The frontend server's connection (the latest one, if several connect). */
  private server: Socket | null = null;
  private version: Promise<Record<string, unknown>> | null = null;
  /** The server pointed at a spot in a tab: the shell draws the agent's cursor there. */
  onPointer: (page: string, pointer: Pointer) => void = () => {};
  /** A page that showed `key` went away: another page that shows it may take over. */
  onOrphaned: (key: ServerTabKey) => void = () => {};
  /** The server wants a tab for `key`, tagged `tag`, and no page shows one. */
  onOpen: (key: ServerTabKey, tag: string, incognito: boolean) => void = () => {};
  /** The server's tab `key` closed; it was the helper's (HELPER_PAGE). */
  onClose: (key: ServerTabKey, browserTabId: number) => void = () => {};
  /** Keeps browser tab `browserTabId` drawing at full rate while no page shows it (Desktop.setTabAwake). */
  keepAwake: (browserTabId: number, awake: boolean) => Promise<void> = async () => {};
  /** Asks the user for `permissions` over browser tab `browserTabId`, marked as an agent's. */
  onRequestPermissions: (
    browserTabId: number,
    permissions: string[],
    origin: string | undefined,
  ) => Promise<PermissionAnswer | null> = () => Promise.reject(new Error("There is no browser to ask the user in."));
  /** Registers the server's recording of browser tab `browserTabId` as a capture; its id. */
  onCaptureStart: (browserTabId: number) => Promise<number> = () =>
    Promise.reject(new Error("Recording needs Plutonium's browser."));
  /** Ends capture `captureId` (the server stopped recording). */
  onCaptureStop: (captureId: number) => void = () => {};

  constructor(cdp: BrowserCdp) {
    this.cdp = cdp;
    cdp.addEventListener((event) => this.browserEvent(event));
    cdp.addCloseListener(() => {
      for (const tab of this.tabs.values()) {
        tab.session = null;
        tab.sessionId = null;
        tab.children.clear();
      }
      this.version = null;
    });
  }

  private emit(event: Record<string, unknown>): void {
    debug(">", JSON.stringify(event).slice(0, 300), this.server ? "" : "(no server)");
    this.server?.write(`${JSON.stringify(event)}\n`);
  }

  /**
   * The shell shows `key` with the page `info.targetId`; the server may drive
   * it. Several shell pages can show the server's tabs (several shells run at
   * once): the first page's tab is the one, and the browser tab id returned is
   * the one every page should show. With `replace` (a tab the page brought
   * from elsewhere), the page's tab wins over one the helper opened itself,
   * which closes.
   */
  attach(
    key: ServerTabKey,
    info: ServerTabInfo,
    pageConnected: (page: string) => boolean,
    replace = false,
  ): number {
    const current = this.tabs.get(keyOf(key));
    if (current?.info.targetId === info.targetId) return current.info.browserTabId;
    const helpers = current?.info.page === HELPER_PAGE && info.page !== HELPER_PAGE;
    if (current && current.info.page !== info.page && pageConnected(current.info.page) && !(replace && helpers)) {
      return current.info.browserTabId;
    }
    if (current) this.detach(key);
    if (current && replace && helpers) this.onClose(key, current.info.browserTabId);
    this.tabs.set(keyOf(key), {
      key,
      info,
      relay: null,
      session: null,
      sessionId: null,
      children: new Set(),
      awake: null,
      focusEmulation: false,
      refused: null,
      captureId: null,
    });
    this.emit({ type: "attached", ...key });
    return info.browserTabId;
  }

  /** The shell stopped showing it (closed, or the page went away); only its page's say counts. */
  detach(key: ServerTabKey, page?: string): void {
    const tab = this.tabs.get(keyOf(key));
    if (!tab || (page !== undefined && tab.info.page !== page)) return;
    this.tabs.delete(keyOf(key));
    this.release(tab);
    this.endCapture(tab, "The tab went away.");
    this.emit({ type: "detached", ...key });
  }

  /** Capture `captureId` stopped (a shell, the switch, or its source): the server's recording ends. */
  captureStopped(captureId: number): void {
    for (const tab of this.tabs.values()) {
      if (tab.captureId !== captureId) continue;
      tab.captureId = null;
      this.emit({
        type: "recording",
        ...tab.key,
        phase: "ended",
        message: "The recording was stopped (by the user, the recording switch, or its tab closing).",
      });
    }
  }

  /** The server's recording of `tab` ends here: its capture stops, and the server hears why. */
  private endCapture(tab: AttachedTab, message: string): void {
    if (tab.captureId === null) return;
    this.onCaptureStop(tab.captureId);
    tab.captureId = null;
    this.emit({ type: "recording", ...tab.key, phase: "ended", message });
  }

  private async startCapture(tab: AttachedTab): Promise<void> {
    const refuse = (message: string) => this.emit({ type: "recording", ...tab.key, phase: "refused", message });
    if (tab.captureId !== null) {
      this.emit({ type: "recording", ...tab.key, phase: "started" });
      return;
    }
    if (tab.info.browserTabId < 0) return refuse("Only a tab can be recorded.");
    let captureId: number;
    try {
      captureId = await this.onCaptureStart(tab.info.browserTabId);
    } catch (cause) {
      return refuse(cause instanceof Error ? cause.message : String(cause));
    }
    // It went meanwhile, or the server asked twice.
    if (this.tabs.get(keyOf(tab.key)) !== tab || tab.captureId !== null) {
      this.onCaptureStop(captureId);
      if (this.tabs.get(keyOf(tab.key)) !== tab) return refuse("The tab went away.");
    } else tab.captureId = captureId;
    this.emit({ type: "recording", ...tab.key, phase: "started" });
  }

  /** Every tab shell page `page` showed (it disconnected). */
  detachPage(page: string): void {
    for (const tab of [...this.tabs.values()]) {
      if (tab.info.page !== page) continue;
      this.detach(tab.key);
      this.onOrphaned(tab.key);
    }
  }

  /** The tabs page `page` showed first, with their browser tab ids. */
  pageTabs(page: string): { readonly key: ServerTabKey; readonly browserTabId: number }[] {
    return [...this.tabs.values()]
      .filter((tab) => tab.info.page === page)
      .map((tab) => ({ key: tab.key, browserTabId: tab.info.browserTabId }));
  }

  attachedTabs(): ServerTabKey[] {
    return [...this.tabs.values()].map((tab) => tab.key);
  }

  /** Lets go of the real session; the next server connection starts afresh. */
  private release(tab: AttachedTab): void {
    this.sleep(tab);
    tab.relay = null;
    const session = tab.session;
    tab.session = null;
    tab.sessionId = null;
    tab.children.clear();
    void session
      ?.then((sessionId) => this.cdp.send("Target.detachFromTarget", { sessionId }))
      .catch(() => {});
  }

  private pageSession(tab: AttachedTab): Promise<string> {
    if (tab.session) return tab.session;
    const session = this.cdp
      .send("Target.attachToTarget", { targetId: tab.info.targetId, flatten: true })
      .then((result) => {
        const { sessionId } = result as { sessionId: string };
        // Released meanwhile: let go of it again.
        if (tab.session !== session) {
          void this.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
        } else tab.sessionId = sessionId;
        return sessionId;
      });
    tab.session = session;
    session.catch(() => {
      if (tab.session === session) tab.session = null;
    });
    return session;
  }

  /**
   * The server's input reaches a page with its next frame, and a tab no page
   * shows draws one a second: a path drag's moves (one per 8 px) took a
   * second each. From the first input until AWAKE_MS without any, the tab
   * draws at full rate.
   */
  private async wake(tab: AttachedTab): Promise<void> {
    if (tab.info.browserTabId < 0) return;
    const asleep = tab.awake === null;
    if (tab.awake) clearTimeout(tab.awake);
    tab.awake = setTimeout(() => this.sleep(tab), AWAKE_MS);
    tab.awake.unref();
    if (!asleep) return;
    await this.keepAwake(tab.info.browserTabId, true).catch(() => {});
    if (tab.focusEmulation) await this.setFocusEmulation(tab, true);
  }

  private sleep(tab: AttachedTab): void {
    if (tab.awake === null) return;
    clearTimeout(tab.awake);
    tab.awake = null;
    void this.keepAwake(tab.info.browserTabId, false).catch(() => {});
    if (tab.focusEmulation) void this.setFocusEmulation(tab, false);
  }

  private async setFocusEmulation(tab: AttachedTab, enabled: boolean): Promise<void> {
    if (!tab.session) return;
    await this.pageSession(tab)
      .then((sessionId) => this.cdp.send(FOCUS_EMULATION, { enabled }, sessionId))
      .catch(() => {});
  }

  private relayFor(tab: AttachedTab): RelayConnection {
    if (tab.relay) return tab.relay;
    const relay = createRelay(
      {
        send: async (method, params, child) => {
          if (child !== undefined && !tab.children.has(child)) throw new Error(`No session ${child} in this tab.`);
          if (child === undefined && method === FOCUS_EMULATION) {
            tab.focusEmulation = params?.["enabled"] === true;
            if (tab.focusEmulation && tab.awake === null) return {};
          }
          if (child === undefined && method.startsWith("Input.")) await this.wake(tab);
          const sent = this.cdp.send(method, params, child ?? (await this.pageSession(tab)));
          if (child === undefined && method === "Page.captureScreenshot") return this.screenshot(tab, params, sent);
          return sent;
        },
        targetId: tab.info.targetId,
        browserTabId: tab.info.browserTabId,
        cancelDownload: async (id) => {
          await this.cdp.send("Plutonium.downloadCommand", { id, command: "cancel" });
        },
        url: () => tab.info.url(),
        title: () => tab.info.title(),
        tab: async () => {
          const { tabs } = (await this.cdp.send("Plutonium.getTabs")) as { tabs: { targetId: string }[] };
          const found = tabs.find((candidate) => candidate.targetId === tab.info.targetId);
          if (!found) throw new Error("The browser has no such tab.");
          return found;
        },
        grantPermissions: (params) => this.grantPermissions(tab, params),
        version: () => {
          this.version ??= this.cdp.send("Browser.getVersion").then((value) => value as Record<string, unknown>);
          this.version.catch(() => {
            this.version = null;
          });
          return this.version;
        },
      },
      // A released relay's late replies belong to a connection that is gone.
      (message) => {
        if (tab.relay === relay && this.tabs.get(keyOf(tab.key)) === tab) {
          this.emit({ type: "cdp", ...tab.key, message });
        }
      },
    );
    tab.relay = relay;
    // Its events start with the page session.
    void this.pageSession(tab).catch(() => {});
    return relay;
  }

  /**
   * Page.captureScreenshot's answer, or the browser's capture of the tab when
   * that doesn't come in SCREENSHOT_FALLBACK_MS (SCREENSHOT_FALLBACK_MS says
   * why). Only whole-viewport captures fall back: the browser's is the
   * viewport, at the device scale, as DevTools' is without a clip.
   */
  private screenshot(tab: AttachedTab, params: Record<string, unknown>, sent: Promise<unknown>): Promise<unknown> {
    const id = tab.info.browserTabId;
    if (id < 0 || params.clip !== undefined) return sent;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        const format = params.format === "jpeg" ? "jpeg" : "png";
        const quality = typeof params.quality === "number" ? { quality: params.quality } : {};
        this.cdp.send("Plutonium.captureTab", { id, format, ...quality }).then(
          (value) => {
            if (settled) return;
            settled = true;
            debug("screenshot from Plutonium.captureTab for tab", id);
            resolve({ data: (value as { data: string }).data });
          },
          // The browser's capture failed too: wait on DevTools' after all.
          () => {},
        );
      }, SCREENSHOT_FALLBACK_MS);
      timer.unref();
      sent.then(
        (value) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          resolve(value);
        },
        (cause: unknown) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          reject(cause);
        },
      );
    });
  }

  /** EXO-TAB-PERMISSIONS: the server can't grant a permission itself; the user is asked over the tab. */
  private async grantPermissions(tab: AttachedTab, params: Record<string, unknown>): Promise<unknown> {
    const permissions = promptPermissions(params.permissions);
    if (!permissions.length) return {};
    if (tab.info.page === SCRATCH_PAGE) throw new Error("A hidden page can't ask the user for permissions.");
    const origin = typeof params.origin === "string" && params.origin ? params.origin : undefined;
    // Playwright sends the command again when it fails: the user isn't asked twice.
    const key = JSON.stringify([permissions, origin ?? ""]);
    if (tab.refused?.key === key && Date.now() - tab.refused.at < REFUSAL_MEMORY_MS) {
      throw new Error(`The user didn't allow ${permissions.join(", ")}.`);
    }
    const result = await this.onRequestPermissions(tab.info.browserTabId, permissions, origin);
    if (result?.answer !== "allow") {
      tab.refused = { key, at: Date.now() };
      throw new Error(`The user didn't allow ${permissions.join(", ")} (${result?.answer ?? "no answer"}).`);
    }
    return {};
  }

  private browserEvent(event: CdpEvent): void {
    const { method, params, sessionId } = event;
    for (const tab of this.tabs.values()) tab.relay?.browserEvent(event);
    if (!sessionId) {
      // A page session ended from the browser's side (the tab crashed or closed).
      if (method === "Target.detachedFromTarget") {
        const ended = (params as { sessionId?: string }).sessionId;
        for (const tab of this.tabs.values()) {
          if (ended && tab.sessionId === ended) {
            tab.session = null;
            tab.sessionId = null;
            tab.children.clear();
          }
        }
      }
      return;
    }
    for (const tab of this.tabs.values()) {
      const child = tab.children.has(sessionId);
      if (!child && tab.sessionId !== sessionId) continue;
      this.trackChildren(tab, method, params);
      tab.relay?.event(method, params, child ? sessionId : undefined);
      return;
    }
  }

  private trackChildren(tab: AttachedTab, method: string, params: unknown): void {
    const child = (params as { sessionId?: string } | undefined)?.sessionId;
    if (!child) return;
    if (method === "Target.attachedToTarget") tab.children.add(child);
    if (method === "Target.detachedFromTarget") tab.children.delete(child);
  }

  /** Takes over as the server's connection: announces the attached tabs, then serves its commands. */
  serve(socket: Socket): void {
    if (this.server && this.server !== socket) this.server.destroy();
    this.server = socket;
    for (const tab of this.tabs.values()) {
      this.release(tab);
      this.emit({ type: "attached", ...tab.key });
    }
    let buffered = "";
    // (An upgraded HTTP socket can't change its encoding.)
    const decoder = new StringDecoder("utf8");
    socket.on("data", (chunk: Buffer) => {
      buffered += decoder.write(chunk);
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.trim()) this.command(line);
      }
    });
    const end = () => {
      if (this.server !== socket) return;
      this.server = null;
      for (const tab of [...this.tabs.values()]) {
        // Its recordings went with it.
        if (tab.captureId !== null) {
          this.onCaptureStop(tab.captureId);
          tab.captureId = null;
        }
        if (tab.info.page === SCRATCH_PAGE) this.closeScratch(tab);
        else this.release(tab);
      }
    };
    socket.once("close", end);
    socket.once("error", end);
  }

  /**
   * A hidden page (Target.createTarget's `hidden`): no tab strip, window or
   * shell shows it. It paints nothing on its own, so the server turns on focus
   * emulation for it, which makes it visible to its scripts.
   */
  private async openScratch(key: ServerTabKey): Promise<void> {
    const server = this.server;
    try {
      const { targetId } = (await this.cdp.send("Target.createTarget", {
        url: "about:blank",
        hidden: true,
        background: true,
      })) as { targetId: string };
      // The server went away meanwhile, or asked twice.
      if (this.server !== server || !server || this.tabs.has(keyOf(key))) {
        void this.cdp.send("Target.closeTarget", { targetId }).catch(() => {});
        return;
      }
      this.attach(key, { targetId, browserTabId: -1, page: SCRATCH_PAGE, url: () => "about:blank", title: () => "" }, () => false);
    } catch (cause) {
      // The server times out and reports it.
      console.error("serverTabs: no scratch page:", cause instanceof Error ? cause.message : cause);
    }
  }

  private closeScratch(tab: AttachedTab): void {
    this.detach(tab.key);
    void this.cdp.send("Target.closeTarget", { targetId: tab.info.targetId }).catch(() => {});
  }

  private command(line: string): void {
    debug("<", line.slice(0, 300));
    let command: {
      type?: string;
      threadId?: string;
      tabId?: string;
      message?: string;
      phase?: string;
      x?: number;
      y?: number;
      tag?: string;
      incognito?: boolean;
    };
    try {
      command = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof command.threadId !== "string" || typeof command.tabId !== "string") return;
    const key = { threadId: command.threadId, tabId: command.tabId };
    const tab = this.tabs.get(keyOf(key));
    if (command.type === "open") {
      if (!tab && typeof command.tag === "string" && command.tag)
        this.onOpen(key, command.tag, command.incognito === true);
      return;
    }
    if (command.type === "scratch") {
      if (!tab) void this.openScratch(key);
      return;
    }
    if (command.type === "recording" && command.phase === "start" && !tab) {
      this.emit({ type: "recording", ...key, phase: "refused", message: "No shell shows the tab." });
      return;
    }
    if (!tab) return;
    switch (command.type) {
      case "close":
        if (tab.info.page === SCRATCH_PAGE) {
          this.closeScratch(tab);
          return;
        }
        if (tab.info.page !== HELPER_PAGE) return;
        this.detach(tab.key);
        this.onClose(tab.key, tab.info.browserTabId);
        return;
      case "cdp":
        if (typeof command.message === "string") this.relayFor(tab).receive(command.message);
        return;
      case "release":
        this.release(tab);
        return;
      case "recording":
        if (command.phase === "start") void this.startCapture(tab);
        else if (command.phase === "stop" && tab.captureId !== null) {
          this.onCaptureStop(tab.captureId);
          tab.captureId = null;
        }
        return;
      case "pointer":
        if ((command.phase === "move" || command.phase === "click") && Number.isFinite(command.x) && Number.isFinite(command.y)) {
          this.onPointer(tab.info.page, { ...tab.key, phase: command.phase, x: command.x!, y: command.y! });
        }
        return;
    }
  }
}
