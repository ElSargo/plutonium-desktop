// The desktop's windows and tabs, straight from the browser: its DevTools
// Plutonium domain (chrome/browser/devtools/cros_protocol.pdl), on the
// DevTools socket (or port) the session gives the helper. The helper drives
// windows and tabs through it without a shell page: list them, open and close
// tabs, snapshot both, and send windows mouse and keys.
//
// Showing something to the user (focus) stays the shells' business, through
// the shell relay. A browser from before the domain has none of this: then
// `available()` is false and the daemon asks the shell instead.
import { type BrowserCdp, type CdpEvent, CdpError } from "./cdp.ts";
import type { BrowserSession } from "./services/media.ts";
import type { BrowserIdle } from "./services/session.ts";
import { type Layout, type TypedChar, layoutOf } from "./keys.ts";

/** A browser tab (Plutonium.Tab). */
export interface DesktopTab {
  readonly id: number;
  readonly targetId: string;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly embedded: boolean;
  readonly focused: boolean;
  readonly tags: readonly string[];
  readonly openerId: number;
  readonly openedBy: string;
  /** In a throwaway off-the-record profile of its own (browsers with EXO-INCOGNITO). */
  readonly incognito?: boolean;
  readonly dialogType?: string;
  readonly dialogMessage?: string;
  readonly dialogDefaultPrompt?: string;
  /** What the tab's features report, a JSON object (TAB_FEATURES.md); older browsers: missing. */
  readonly stateJson?: string;
}

/** EXO-SERVICES: a tab's web notification (Plutonium.WebNotification). */
export interface WebNotification {
  readonly id: string;
  /** The site's origin. */
  readonly origin: string;
  readonly title: string;
  readonly body: string;
  /** A PNG data URL, or "". */
  readonly icon: string;
  /** Its action buttons' labels. */
  readonly buttons: readonly string[];
  readonly requireInteraction: boolean;
  readonly silent: boolean;
}

/** A native window (Plutonium.Window). */
export interface DesktopWindow {
  readonly id: number;
  readonly appId: string;
  readonly title: string;
  /** The window geometry, in DIPs. */
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
  readonly embedded: boolean;
  readonly focused: boolean;
  readonly onDesktop: boolean;
  readonly pid: number;
  readonly tags: readonly string[];
}

/** A popup (menu, tooltip) open on a window, in the window's DIPs. */
export interface WindowPopup {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** EXO-TAB-FEATURES: a download (Plutonium.downloadAdded's JSON; TAB_FEATURES.md). */
export interface DesktopDownload {
  readonly id: number;
  /** The tab that started it (it may have closed since), or 0. */
  readonly tabId: number;
  /** That tab's thread (its origin tag), or "". */
  readonly thread: string;
  readonly url: string;
  readonly filename: string;
  /** Where the file is (or goes); "" until the browser knows. */
  readonly path: string;
  readonly mime: string;
  readonly receivedBytes: number;
  /** 0 if unknown. */
  readonly totalBytes: number;
  readonly state: "in-progress" | "paused" | "complete" | "cancelled" | "interrupted";
  /** Chrome's danger type, while a dangerous file waits on the user's keep or discard. */
  readonly danger?: string;
  /** Why it was interrupted. */
  readonly error?: string;
  readonly canResume: boolean;
  /** ms since the epoch. */
  readonly startTime: number;
}

export interface Capture {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
}

export interface WindowMouseEvent {
  readonly type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
  /** DIPs from the window geometry's top left. */
  readonly x: number;
  readonly y: number;
  readonly button?: "none" | "left" | "middle" | "right" | "back" | "forward";
  /** Buttons held: left=1, right=2, middle=4. */
  readonly buttons?: number;
  readonly clickCount?: number;
  /** Wheel notches, down and right positive. */
  readonly deltaX?: number;
  readonly deltaY?: number;
  /** Alt=1, Ctrl=2, Meta=4, Shift=8. */
  readonly modifiers?: number;
}

export interface WindowKeyEvent {
  readonly type: "keyDown" | "keyUp";
  /** A KeyboardEvent.code ("KeyA", "Enter"). */
  readonly code: string;
  readonly modifiers?: number;
}

export interface ScreencastFrame {
  readonly windowId: number;
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
}

/** EXO-CAPTURE: a capture (Plutonium.captureEvent's JSON; docs/features/CAPTURE.md). */
export interface DesktopCapture {
  readonly id: number;
  readonly kind: "stream" | "pipewire" | "display";
  readonly source: { readonly type: "output" | "window" | "tab"; readonly id: number | string };
  readonly label: string;
  readonly consumer: Record<string, unknown>;
  readonly size?: { readonly width: number; readonly height: number };
  readonly cursor: string;
  readonly nodeId?: number;
  readonly startTime: number;
}

export class Desktop {
  private readonly cdp: BrowserCdp;
  /** Plutonium.enable's outcome for this connection; null before the first try. */
  private enabling: Promise<boolean> | null = null;
  private readonly tabMap = new Map<number, DesktopTab>();
  private readonly windowMap = new Map<number, DesktopWindow>();
  private readonly downloadMap = new Map<number, DesktopDownload>();
  /** setTabAwake's holds, by tab id. */
  private readonly awakeTabs = new Map<number, number>();
  /** Screencast listeners, by window id. */
  private readonly frameListeners = new Map<number, Set<(frame: ScreencastFrame | null) => void>>();
  /** Tabs or windows came, changed or went. */
  readonly changeListeners = new Set<() => void>();
  /** A window came (`previous` undefined) or changed. */
  readonly windowListeners = new Set<(window: DesktopWindow, previous: DesktopWindow | undefined) => void>();
  /** EXO-CAPTURE: a capture started, changed or stopped. */
  /** The browser's active media session as it changes (null when there's none). */
  readonly mediaListeners = new Set<(session: BrowserSession | null) => void>();
  /** EXO-LOCK: the lock went up or down. */
  readonly lockListeners = new Set<(locked: boolean) => void>();
  /** EXO-DISPLAYS: a display came, went or changed (the display service). */
  readonly displayListeners = new Set<() => void>();
  readonly captureListeners = new Set<(type: "start" | "change" | "stop", capture: DesktopCapture) => void>();
  /** The Plutonium domain was enabled: the browser came up, or came back. */
  readonly enableListeners = new Set<() => void>();
  /** EXO-SERVICES: tabs' web notifications came or changed (`notification`), or went (an id). */
  readonly notificationListeners = new Set<(event: { shown: WebNotification } | { closed: string }) => void>();

  constructor(cdp: BrowserCdp) {
    this.cdp = cdp;
    cdp.addEventListener((event) => this.event(event));
    cdp.addCloseListener(() => {
      this.enabling = null;
      this.tabMap.clear();
      this.windowMap.clear();
      this.downloadMap.clear();
      this.awakeTabs.clear();
      for (const listeners of this.frameListeners.values()) for (const listener of listeners) listener(null);
      this.frameListeners.clear();
    });
  }

  /**
   * Whether the browser has the Plutonium domain (and is up). Connects on
   * first use, and again after the browser restarts. A failed attempt is
   * retried on the next call. `quiet`: no warning when it fails.
   */
  available(quiet = false): Promise<boolean> {
    if (!this.enabling) {
      const enabling = this.cdp.send("Plutonium.enable").then(
        () => {
          for (const listener of this.enableListeners) listener();
          return true;
        },
        (error: unknown) => {
          if (!quiet && (!(error instanceof CdpError) || !/wasn't found|not found/i.test(error.message))) {
            console.warn(`plutoniumd: no Plutonium DevTools domain: ${(error as Error).message}`);
          }
          // Try again next time: the browser may not be up yet.
          if (this.enabling === enabling) this.enabling = null;
          return false;
        },
      );
      this.enabling = enabling;
    }
    return this.enabling;
  }

  private event({ method, params, sessionId }: CdpEvent): void {
    if (sessionId || !method.startsWith("Plutonium.")) return;
    const value = params as Record<string, unknown>;
    switch (method) {
      case "Plutonium.tabAdded":
      case "Plutonium.tabChanged": {
        const tab = value.tab as DesktopTab;
        this.tabMap.set(tab.id, tab);
        break;
      }
      case "Plutonium.tabRemoved":
        this.tabMap.delete(value.id as number);
        this.awakeTabs.delete(value.id as number);
        break;
      case "Plutonium.windowAdded":
      case "Plutonium.windowChanged": {
        const window = value.window as DesktopWindow;
        const previous = this.windowMap.get(window.id);
        this.windowMap.set(window.id, window);
        for (const listener of this.windowListeners) listener(window, previous);
        break;
      }
      case "Plutonium.windowRemoved":
        this.windowMap.delete(value.id as number);
        break;
      case "Plutonium.downloadAdded":
      case "Plutonium.downloadChanged": {
        const download = parseDownload(value.downloadJson);
        if (download) this.downloadMap.set(download.id, download);
        break;
      }
      case "Plutonium.downloadRemoved":
        this.downloadMap.delete(value.id as number);
        break;
      case "Plutonium.windowScreencastFrame": {
        const windowId = value.id as number;
        const listeners = this.frameListeners.get(windowId);
        // Acknowledged at once: listeners that fall behind drop frames themselves.
        void this.cdp
          .send("Plutonium.windowScreencastFrameAck", { id: windowId, sessionId: value.sessionId })
          .catch(() => {});
        if (!listeners) return;
        const frame = {
          windowId,
          data: Buffer.from(value.data as string, "base64"),
          width: value.width as number,
          height: value.height as number,
        };
        for (const listener of listeners) listener(frame);
        return;
      }
      case "Plutonium.captureEvent": {
        const type = value.type as string;
        if (type !== "start" && type !== "change" && type !== "stop") return;
        let capture: DesktopCapture;
        try {
          capture = JSON.parse(value.json as string) as DesktopCapture;
        } catch {
          return;
        }
        for (const listener of this.captureListeners) listener(type, capture);
        return;
      }
      case "Plutonium.displayConfigChanged": {
        for (const listener of this.displayListeners) listener();
        return;
      }
      case "Plutonium.lockChanged": {
        for (const listener of this.lockListeners) listener(value.locked === true);
        return;
      }
      case "Plutonium.mediaSessionChanged": {
        const session = mediaSessionOf(value.session);
        for (const listener of this.mediaListeners) listener(session);
        return;
      }
      case "Plutonium.notificationShown":
        for (const listener of this.notificationListeners) listener({ shown: value.notification as WebNotification });
        return;
      case "Plutonium.notificationClosed":
        for (const listener of this.notificationListeners) listener({ closed: value.id as string });
        return;
      case "Plutonium.windowScreencastStopped": {
        const listeners = this.frameListeners.get(value.id as number);
        this.frameListeners.delete(value.id as number);
        for (const listener of listeners ?? []) listener(null);
        return;
      }
      default:
        return;
    }
    for (const listener of this.changeListeners) listener();
  }

  /** The browser's active media session (a tab's, a shell page's), or null: none, or an older browser. */
  async mediaSession(): Promise<BrowserSession | null> {
    if (!(await this.available())) return null;
    try {
      return mediaSessionOf(((await this.cdp.send("Plutonium.getMediaSession")) as { session?: unknown }).session);
    } catch {
      return null;
    }
  }

  /** The browser process's pid (SystemInfo.getProcessInfo), or null. */
  async browserPid(): Promise<number | null> {
    try {
      const { processInfo } = (await this.cdp.send("SystemInfo.getProcessInfo")) as { processInfo?: { type: string; id: number }[] };
      return processInfo?.find((process) => process.type === "browser")?.id ?? null;
    } catch {
      return null;
    }
  }

  /** Plays, pauses… the browser's active media session ("play-pause", "next", …). */
  async mediaSessionAction(action: string): Promise<void> {
    await this.cdp.send("Plutonium.mediaSessionAction", { action });
  }

  /** EXO-LOCK: puts Ash's lock up (only the password takes it down). */
  async lock(user: string, message: string): Promise<void> {
    if (!(await this.available())) throw new Error("The browser has no Plutonium domain.");
    await this.cdp.send("Plutonium.lock", { user, message });
  }

  /** EXO-LOCK: the lock, the idle time, the displays and the browser's wake locks. */
  async idle(): Promise<BrowserIdle> {
    if (!(await this.available())) throw new Error("The browser has no Plutonium domain.");
    return (await this.cdp.send("Plutonium.getIdle")) as BrowserIdle;
  }

  /** EXO-LOCK: the displays off (until the user does something) or on; false where it can't (X11). */
  async setDisplaysOff(off: boolean): Promise<boolean> {
    return ((await this.cdp.send("Plutonium.setDisplaysOff", { off })) as { applied: boolean }).applied;
  }

  /** EXO-DISPLAYS: the displays' configuration (the display service's state), or null: an older browser. */
  async displayConfig(): Promise<Record<string, unknown> | null> {
    if (!(await this.available())) return null;
    try {
      const { json } = (await this.cdp.send("Plutonium.getDisplayConfig")) as { json: string };
      return JSON.parse(json) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof CdpError && /wasn't found|not found/i.test(error.message)) return null;
      throw error;
    }
  }

  /** EXO-DISPLAYS: applies a display change (the domain's JSON); throws with the browser's reason. */
  async configureDisplays(change: Record<string, unknown>): Promise<void> {
    await this.cdp.send("Plutonium.configureDisplays", { changeJson: JSON.stringify(change) });
  }

  /** Opens the switcher (Super+Tab's) on one of its pages: "displays", "settings", … */
  async openSwitcher(page: string): Promise<void> {
    await this.cdp.send("Plutonium.openSwitcher", { page });
  }

  /** EXO-LOCK: whether an inhibitor holds idle off, for Wayland apps' ext_idle_notify_v1. */
  async setIdleInhibited(inhibited: boolean): Promise<void> {
    await this.cdp.send("Plutonium.setIdleInhibited", { inhibited });
  }

  /** Clicks a web notification (or one of its buttons), or closes it as the user would. */
  async notificationAction(id: string, action: "click" | "close", button?: number): Promise<void> {
    await this.cdp.send("Plutonium.notificationAction", { id, action, ...(button !== undefined ? { button } : {}) });
  }

  /** EXO-SERVICES: Ash's dark mode, from the host's color scheme. False if the browser can't. */
  async setColorScheme(dark: boolean): Promise<boolean> {
    if (!(await this.available())) return false;
    try {
      await this.cdp.send("Plutonium.setColorScheme", { dark });
      return true;
    } catch {
      return false;
    }
  }

  /** Every tab, oldest first. Call available() first. */
  tabs(): DesktopTab[] {
    return [...this.tabMap.values()].sort((a, b) => a.id - b.id);
  }

  /** Every window, oldest first. Call available() first. */
  windows(): DesktopWindow[] {
    return [...this.windowMap.values()].sort((a, b) => a.id - b.id);
  }

  /** Every download this session, oldest first. Call available() first. */
  downloads(): DesktopDownload[] {
    return [...this.downloadMap.values()].sort((a, b) => a.id - b.id);
  }

  download(id: number): DesktopDownload | undefined {
    return this.downloadMap.get(id);
  }

  /**
   * Runs a command on download `id`: pause, resume, cancel, discard or
   * remove (open and show are the helper's own; keep is the user's).
   */
  async downloadCommand(id: number, command: string): Promise<void> {
    await this.cdp.send("Plutonium.downloadCommand", { id, command });
  }

  tab(id: number): DesktopTab | undefined {
    return this.tabMap.get(id);
  }

  window(id: number): DesktopWindow | undefined {
    return this.windowMap.get(id);
  }

  /**
   * Opens a tab; `tags` starts with its thread. With `incognito`, in a
   * throwaway profile of its own; a browser that can't do that fails it.
   */
  async createTab(
    url: string,
    tags: readonly string[],
    options: { readonly incognito?: boolean } = {},
  ): Promise<DesktopTab> {
    const { tab } = (await this.cdp.send("Plutonium.createTab", {
      url,
      tags,
      ...(options.incognito ? { incognito: true } : {}),
    })) as { tab: DesktopTab };
    if (options.incognito && tab.incognito !== true) {
      await this.tabCommand(tab.id, "close").catch(() => {});
      throw new Error("This browser can't open incognito tabs.");
    }
    this.tabMap.set(tab.id, tab);
    return tab;
  }

  async navigateTab(id: number, url: string): Promise<void> {
    await this.cdp.send("Plutonium.navigateTab", { id, url });
  }

  /**
   * Runs a command on tab `id`: back, forward, reload, stop, close, or a tab
   * feature's ("zoom-in", "find", ...), with `args`. Resolves with its result.
   */
  async tabCommand(id: number, command: string, args?: Record<string, unknown>): Promise<unknown> {
    const { resultJson } = (await this.cdp.send("Plutonium.tabCommand", {
      id,
      command,
      ...(args ? { argsJson: JSON.stringify(args) } : {}),
    })) as { resultJson?: string };
    return resultJson ? JSON.parse(resultJson) : null;
  }

  /** Answers tab request `requestId` (a tab's `pending`) as an agent. */
  async answerTabRequest(requestId: number, answer: unknown): Promise<void> {
    await this.cdp.send("Plutonium.answerTabRequest", { requestId, answerJson: JSON.stringify(answer ?? null) });
  }

  async answerTabDialog(id: number, accept: boolean, promptText: string): Promise<void> {
    await this.cdp.send("Plutonium.answerTabDialog", { id, accept, promptText });
  }

  /**
   * Keeps tab `id` rendering at full rate while no page shows it. Counted:
   * the browser's flag is one per DevTools connection, and the agents' pages
   * and the frontend server's relay can both hold a tab awake.
   */
  async setTabAwake(id: number, awake: boolean): Promise<void> {
    const holds = (this.awakeTabs.get(id) ?? 0) + (awake ? 1 : -1);
    if (holds < 0) return;
    if (holds) this.awakeTabs.set(id, holds);
    else this.awakeTabs.delete(id);
    if (holds !== (awake ? 1 : 0)) return;
    try {
      await this.cdp.send("Plutonium.setTabAwake", { id, awake });
    } catch (error) {
      // Not held after all (no such tab, or the browser went).
      if (awake && this.awakeTabs.get(id) === 1) this.awakeTabs.delete(id);
      throw error;
    }
  }

  async captureTab(id: number, format: "png" | "jpeg" = "png", quality?: number): Promise<Capture> {
    return decodeCapture(await this.cdp.send("Plutonium.captureTab", { id, format, quality }));
  }

  async captureWindow(id: number, format: "png" | "jpeg" = "png", quality?: number): Promise<Capture> {
    return decodeCapture(await this.cdp.send("Plutonium.captureWindow", { id, format, quality }));
  }

  /** Keeps window `id` drawing at full rate while no page shows it. */
  async setWindowAwake(id: number, awake: boolean): Promise<void> {
    await this.cdp.send("Plutonium.setWindowAwake", { id, awake });
  }

  /**
   * Keeps window `id`'s app keyboard focused for the agent's keys, beside the
   * user's focus in another app (a browser without it: only during each keys()).
   */
  async setWindowAgentFocus(id: number, focused: boolean): Promise<void> {
    await this.cdp.send("Plutonium.setWindowAgentFocus", { id, focused });
  }

  /**
   * Names an untagged window's origin (the thread that started its client),
   * for the browser and every shell, when the browser couldn't read the
   * client's environment. False if it didn't take: the browser read it
   * itself, it was named already, or the browser has no such command.
   */
  async setWindowOriginTag(id: number, tag: string): Promise<boolean> {
    try {
      return ((await this.cdp.send("Plutonium.setWindowOriginTag", { id, tag })) as { ok?: boolean }).ok === true;
    } catch {
      return false;
    }
  }

  async closeWindow(id: number): Promise<void> {
    await this.cdp.send("Plutonium.closeWindow", { id });
  }

  async resizeWindow(id: number, width: number, height: number): Promise<void> {
    await this.cdp.send("Plutonium.resizeWindow", { id, width, height });
  }

  /**
   * The window's open popups (menus, tooltips), in its DIPs, parents first.
   * captureWindow draws them over the window. [] from a browser without them.
   */
  async windowPopups(id: number): Promise<WindowPopup[]> {
    try {
      const { popups } = (await this.cdp.send("Plutonium.getWindowPopups", { id })) as { popups: WindowPopup[] };
      return popups;
    } catch (error) {
      if (error instanceof CdpError && /wasn't found|not found/i.test(error.message)) return [];
      throw error;
    }
  }

  async mouse(id: number, event: WindowMouseEvent): Promise<void> {
    await this.cdp.send("Plutonium.dispatchWindowMouseEvent", { id, ...event });
  }

  async keys(id: number, events: readonly WindowKeyEvent[]): Promise<void> {
    await this.cdp.send("Plutonium.dispatchWindowKeyEvents", { id, events });
  }

  /** The session's keymap (keys.ts), or undefined from a browser without Plutonium.getKeymap. */
  async keymap(): Promise<Layout | undefined> {
    try {
      const { keymap, chars } = (await this.cdp.send("Plutonium.getKeymap")) as {
        keymap: string;
        chars: TypedChar[];
      };
      return chars.length > 0 ? layoutOf(keymap, chars) : undefined;
    } catch (error) {
      if (error instanceof CdpError && /wasn't found|not found/i.test(error.message)) return undefined;
      throw error;
    }
  }

  /** Window `id`'s app gets `keymap` (XKB text) in place of the session's; undefined: the session's again. */
  async setWindowKeymap(id: number, keymap?: string): Promise<void> {
    await this.cdp.send("Plutonium.setWindowKeymap", keymap === undefined ? { id } : { id, keymap });
  }

  /**
   * Window `id`'s frames as it draws (`null` once it stops: the window
   * closed, or the browser went away). Returns a function that stops
   * listening; the screencast stops with its last listener.
   */
  async screencast(
    id: number,
    options: { format?: "png" | "jpeg"; quality?: number; maxWidth?: number; maxHeight?: number },
    listener: (frame: ScreencastFrame | null) => void,
  ): Promise<() => void> {
    let listeners = this.frameListeners.get(id);
    if (!listeners) {
      listeners = new Set();
      this.frameListeners.set(id, listeners);
      try {
        await this.cdp.send("Plutonium.startWindowScreencast", { id, format: "jpeg", ...options });
      } catch (error) {
        this.frameListeners.delete(id);
        throw error;
      }
    }
    listeners.add(listener);
    return () => {
      const current = this.frameListeners.get(id);
      if (!current?.delete(listener) || current.size > 0) return;
      this.frameListeners.delete(id);
      void this.cdp.send("Plutonium.stopWindowScreencast", { id }).catch(() => {});
    };
  }

  /**
   * EXO-CAPTURE: runs capture command `command` (Plutonium.captureCommand:
   * "sources", "list", "settings", "stop", "setSize", "request",
   * "cancelRequest", "start"); resolves to its result.
   */
  async captureCommand(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const { resultJson } = (await this.cdp.send("Plutonium.captureCommand", {
      command,
      argsJson: JSON.stringify(args),
    })) as { resultJson: string };
    return JSON.parse(resultJson) as unknown;
  }

  async captureSources(): Promise<CaptureSourceList> {
    return (await this.captureCommand("sources")) as CaptureSourceList;
  }

  /** A PNG of a capture source ({type, id, region?}). */
  async screenshot(source: Record<string, unknown>): Promise<Capture> {
    return decodeCapture(await this.cdp.send("Plutonium.screenshot", { sourceJson: JSON.stringify(source) }));
  }
}

export interface CaptureSourceList {
  readonly outputs: readonly { id: string; name: string; width: number; height: number; scaleFactor: number; primary: boolean }[];
  readonly windows: readonly { id: number; title: string; appId: string; width: number; height: number; tags: string[] }[];
  readonly tabs: readonly { id: number; title: string; url: string; tags: string[] }[];
}

export function parseDownload(json: unknown): DesktopDownload | undefined {
  if (typeof json !== "string") return undefined;
  try {
    const download = JSON.parse(json) as DesktopDownload;
    return typeof download?.id === "number" ? download : undefined;
  } catch {
    return undefined;
  }
}

function decodeCapture(result: unknown): Capture {
  const { data, width, height } = result as { data: string; width: number; height: number };
  return { data: Buffer.from(data, "base64"), width, height };
}

/** A media session as the Plutonium domain sends it. */
function mediaSessionOf(value: unknown): BrowserSession | null {
  if (!value || typeof value !== "object") return null;
  const session = value as Record<string, unknown>;
  if (session.active === false) return null;
  const text = (key: string) => (typeof session[key] === "string" ? (session[key] as string) : "");
  return {
    playing: session.playing === true,
    title: text("title"),
    artist: text("artist"),
    album: text("album"),
    source: text("source"),
    actions: Array.isArray(session.actions) ? session.actions.map(String) : [],
    ...(typeof session.tabId === "number" ? { tab: session.tabId } : {}),
  };
}
