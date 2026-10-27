// Agents drive the pages of their thread's tabs with Playwright: the helper
// connects Playwright (connectOverCDP) to a relay that looks like a browser
// whose only pages are the thread's tabs. The relay runs each page's commands
// on a flat session of the real browser's DevTools (cdp.ts), as the relay for
// a frontend server's tabs does (serverTabs.ts); a new page is a new tab of
// the thread (desktop.ts).
//
// One connection per thread, opened on first use and closed when idle. The
// connection never emulates a viewport or device: the page stays the size its
// shell shows it at, so the user and a frontend's server (T3 Code drives the
// same tabs) see the same page.
import type { Browser, BrowserContext, Page } from "playwright-core";

import type { BrowserCdp, CdpEvent } from "./cdp.ts";
import type { Desktop, DesktopTab } from "./desktop.ts";
import { RelayDownloads } from "./relayDownloads.ts";
import { listenWebSocket, type WebSocketConnection, type WebSocketEndpoint } from "./websocket.ts";

const BROWSER_CONTEXT_ID = "plutonium-thread";
const IDLE_MS = 10 * 60_000;
/** How long a refused Browser.grantPermissions is refused again without asking. */
const REFUSAL_MEMORY_MS = 5_000;
const debug = process.env.PLUTONIUM_DEBUG_PAGES ? (...args: unknown[]) => console.log("pages:", ...args) : () => {};

/** Browser-level commands that only need acknowledging: the browser is the user's. */
const ACKNOWLEDGED = new Set([
  "Target.setDiscoverTargets",
  "Target.activateTarget",
  // Revoking is the user's: Playwright resets a context's permissions as it
  // closes, and the thread's grants outlive the connection.
  "Browser.resetPermissions",
  "Browser.close",
]);

/**
 * DevTools' permission names (Browser.PermissionType, what Playwright sends)
 * as the browser's prompt names them; null for those a page never asks for.
 */
const CDP_PERMISSIONS: Readonly<Record<string, string | null>> = {
  videoCapture: "camera",
  audioCapture: "microphone",
  videoCapturePanTiltZoom: "camera-pan-tilt-zoom",
  geolocation: "geolocation",
  notifications: "notifications",
  clipboardReadWrite: "clipboard-read",
  clipboardSanitizedWrite: null,
  midiSysex: "midi-sysex",
  midi: null,
  sensors: "sensors",
  storageAccess: "storage-access",
  topLevelStorageAccess: "top-level-storage-access",
  localFonts: "local-fonts",
  windowManagement: "window-management",
  idleDetection: "idle-detection",
  keyboardLock: "keyboard-lock",
  pointerLock: "pointer-lock",
  protectedMediaIdentifier: "protected-media-identifier",
  backgroundSync: null,
  backgroundFetch: null,
  durableStorage: null,
  paymentHandler: null,
  wakeLockScreen: null,
  wakeLockSystem: null,
  displayCapture: null,
  nfc: null,
};

interface CdpCommand {
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
  readonly sessionId?: string;
}

/** A page the relay announced: a tab of the thread. */
interface RelayPage {
  readonly tabId: number;
  readonly targetId: string;
  /** The relay's session ids for it (Playwright attaches once, newCDPSession again). */
  readonly sessions: Set<string>;
  /** The real flat session (one per connection and page). */
  real: Promise<string> | null;
  realId: string | null;
  /** Its child sessions (frames, workers), by real session id. */
  readonly children: Set<string>;
}

/**
 * The relay for one thread: Playwright's whole browser. Commands for the
 * browser are answered here; the pages' go to the real browser.
 */
class ThreadRelay {
  private readonly threadId: string;
  private readonly cdp: BrowserCdp;
  private readonly desktop: Desktop;
  private connection: WebSocketConnection | null = null;
  private autoAttach = false;
  private readonly pages = new Map<string, RelayPage>();
  private readonly browserSessions = new Set<string>();
  /** The connection's downloads, for Playwright's download events. */
  private downloads: RelayDownloads | null = null;
  /** The last grantPermissions the user refused, and when (see grantPermissions()). */
  private refused: { key: string; at: number } | null = null;
  private sequence = 0;

  constructor(threadId: string, cdp: BrowserCdp, desktop: Desktop) {
    this.threadId = threadId;
    this.cdp = cdp;
    this.desktop = desktop;
  }

  private send(message: Record<string, unknown>): void {
    debug(this.threadId, ">", JSON.stringify(message).slice(0, 200));
    this.connection?.send(JSON.stringify(message));
  }

  private threadTabs(): DesktopTab[] {
    return this.desktop.tabs().filter((tab) => tab.tags.includes(this.threadId) && tab.targetId);
  }

  private targetInfo(tab: DesktopTab) {
    return {
      targetId: tab.targetId,
      type: "page",
      title: tab.title,
      url: tab.url,
      attached: true,
      canAccessOpener: false,
      browserContextId: BROWSER_CONTEXT_ID,
    };
  }

  private newSession(page: RelayPage): string {
    const sessionId = `plutonium-page-${page.tabId}-${++this.sequence}`;
    page.sessions.add(sessionId);
    return sessionId;
  }

  private pageFor(tab: DesktopTab): RelayPage {
    let page = this.pages.get(tab.targetId);
    if (!page) {
      page = { tabId: tab.id, targetId: tab.targetId, sessions: new Set(), real: null, realId: null, children: new Set() };
      this.pages.set(tab.targetId, page);
    }
    return page;
  }

  /** Announces a tab to Playwright as an attached page (once). */
  private announce(tab: DesktopTab): void {
    if (!this.autoAttach || this.pages.get(tab.targetId)?.sessions.size) return;
    const page = this.pageFor(tab);
    const sessionId = this.newSession(page);
    this.send({
      method: "Target.attachedToTarget",
      params: { sessionId, targetInfo: this.targetInfo(tab), waitingForDebugger: false },
    });
  }

  /** The thread's tabs changed: announce new ones, let go of gone ones. */
  sync(): void {
    if (!this.connection) return;
    const tabs = this.threadTabs();
    for (const tab of tabs) this.announce(tab);
    const live = new Set(tabs.map((tab) => tab.targetId));
    for (const [targetId, page] of this.pages) {
      if (live.has(targetId)) continue;
      this.pages.delete(targetId);
      for (const sessionId of page.sessions) {
        this.send({ method: "Target.detachedFromTarget", params: { sessionId, targetId } });
      }
      this.send({ method: "Target.targetDestroyed", params: { targetId } });
      this.releaseReal(page);
    }
  }

  private realSession(page: RelayPage): Promise<string> {
    if (page.real) return page.real;
    const real = this.cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true }).then((result) => {
      const { sessionId } = result as { sessionId: string };
      if (page.real !== real) void this.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      else page.realId = sessionId;
      return sessionId;
    });
    page.real = real;
    real.catch(() => {
      if (page.real === real) page.real = null;
    });
    return real;
  }

  private releaseReal(page: RelayPage): void {
    const real = page.real;
    page.real = null;
    page.realId = null;
    page.children.clear();
    void real?.then((sessionId) => this.cdp.send("Target.detachFromTarget", { sessionId })).catch(() => {});
  }

  private pageOfSession(sessionId: string): RelayPage | undefined {
    for (const page of this.pages.values()) if (page.sessions.has(sessionId)) return page;
    return undefined;
  }

  private async browserCommand(command: CdpCommand): Promise<unknown> {
    if (ACKNOWLEDGED.has(command.method)) return {};
    const params = command.params ?? {};
    switch (command.method) {
      case "Browser.getVersion":
        return this.cdp.send("Browser.getVersion");
      case "Target.getTargetInfo":
        return {
          targetInfo: { targetId: "browser", type: "browser", title: "", url: "", attached: true, canAccessOpener: false },
        };
      case "Target.getBrowserContexts":
        return { browserContextIds: [] };
      case "Target.getTargets":
        return { targetInfos: this.threadTabs().map((tab) => this.targetInfo(tab)) };
      case "Target.attachToBrowserTarget": {
        const sessionId = `plutonium-browser-${++this.sequence}`;
        this.browserSessions.add(sessionId);
        return { sessionId };
      }
      case "Target.setAutoAttach": {
        if (command.sessionId !== undefined) return {};
        this.autoAttach = params.autoAttach === true;
        // The pages are announced right after this reply, as Chromium does.
        queueMicrotask(() => this.sync());
        return {};
      }
      case "Target.attachToTarget": {
        const tab = this.threadTabs().find((entry) => entry.targetId === params.targetId);
        if (!tab) throw new Error("Only this thread's tabs can be attached.");
        return { sessionId: this.newSession(this.pageFor(tab)) };
      }
      case "Target.detachFromTarget": {
        const sessionId = params.sessionId;
        if (typeof sessionId === "string") this.pageOfSession(sessionId)?.sessions.delete(sessionId);
        return {};
      }
      case "Target.createTarget": {
        // A new page is a new tab of the thread, announced before the reply
        // (Playwright looks the page up as soon as it has the target id).
        const url = typeof params.url === "string" && params.url ? params.url : "about:blank";
        const tab = await this.desktop.createTab(url, [this.threadId]);
        this.announce(tab);
        return { targetId: tab.targetId };
      }
      case "Browser.grantPermissions":
        return this.grantPermissions(params);
      // Downloads go where the user's do; Playwright gets the events and a link (relayDownloads.ts).
      case "Browser.setDownloadBehavior":
        this.downloads?.setBehavior(params);
        return {};
      case "Browser.cancelDownload":
        await this.downloads?.cancel(params);
        return {};
      case "Target.closeTarget": {
        const tab = this.threadTabs().find((entry) => entry.targetId === params.targetId);
        if (!tab) return { success: false };
        await this.desktop.tabCommand(tab.id, "close");
        return { success: true };
      }
      default:
        throw new Error(`Not supported for a Plutonium thread: ${command.method}`);
    }
  }

  /**
   * EXO-TAB-PERMISSIONS: an agent can't grant a permission itself; this asks
   * the user, with the prompt a page's request gets, marked as the agent's,
   * over one of the thread's tabs (one showing `origin` if there is one).
   * It resolves once the user allows them, in the thread or everywhere.
   */
  private async grantPermissions(params: Record<string, unknown>): Promise<unknown> {
    const names = Array.isArray(params.permissions) ? params.permissions : [];
    const permissions: string[] = [];
    for (const name of names) {
      const mapped = typeof name === "string" ? CDP_PERMISSIONS[name] : undefined;
      if (mapped === undefined) throw new Error(`Unknown permission: ${String(name)}`);
      if (mapped && !permissions.includes(mapped)) permissions.push(mapped);
    }
    if (!permissions.length) return {};
    const origin = typeof params.origin === "string" && params.origin ? params.origin : undefined;
    const originOf = (url: string) => {
      try {
        return new URL(url).origin;
      } catch {
        return "";
      }
    };
    // Playwright sends the command again when it fails (with another name
    // for one permission): the user isn't asked twice.
    const key = JSON.stringify([permissions, origin ?? ""]);
    if (this.refused?.key === key && Date.now() - this.refused.at < REFUSAL_MEMORY_MS) {
      throw new Error(`The user didn't allow ${permissions.join(", ")}.`);
    }
    const tabs = this.threadTabs();
    const tab = (origin && tabs.find((entry) => originOf(entry.url) === originOf(origin))) || tabs.at(-1);
    if (!tab) throw new Error("Open a page in this thread first: the user is asked over one of its tabs.");
    const result = (await this.desktop.tabCommand(tab.id, "permission-request", {
      permissions,
      ...(origin ? { origin } : {}),
      by: "agent",
    })) as { answer?: string } | null;
    if (result?.answer !== "allow") {
      this.refused = { key, at: Date.now() };
      throw new Error(`The user didn't allow ${permissions.join(", ")} (${result?.answer ?? "no answer"}).`);
    }
    return {};
  }

  private async pageCommand(command: CdpCommand, page: RelayPage): Promise<unknown> {
    // The page is already running.
    if (command.method === "Runtime.runIfWaitingForDebugger") return {};
    return this.cdp.send(command.method, command.params ?? {}, await this.realSession(page));
  }

  receive(raw: string): void {
    debug(this.threadId, "<", raw.slice(0, 200));
    let command: CdpCommand;
    try {
      command = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof command.id !== "number" || typeof command.method !== "string") return;
    const sessionId = command.sessionId;
    let result: Promise<unknown>;
    if (sessionId === undefined || this.browserSessions.has(sessionId)) {
      result = this.browserCommand(command);
    } else {
      const page = this.pageOfSession(sessionId);
      const child = page ? undefined : [...this.pages.values()].find((entry) => entry.children.has(sessionId));
      if (page) result = this.pageCommand(command, page);
      else if (child) result = this.cdp.send(command.method, command.params ?? {}, sessionId);
      else result = Promise.reject(new Error(`No session ${sessionId}.`));
    }
    const route = sessionId === undefined ? {} : { sessionId };
    void result.then(
      (value) => this.send({ id: command.id, result: value ?? {}, ...route }),
      (cause: unknown) =>
        this.send({
          id: command.id,
          error: { code: -32000, message: cause instanceof Error ? cause.message : String(cause) },
          ...route,
        }),
    );
  }

  /** An event from the real browser: the page's or its children's go to Playwright. */
  browserEvent(event: CdpEvent): void {
    const { method, params, sessionId } = event;
    if (this.connection) this.downloads?.browserEvent(event);
    if (!sessionId || !this.connection) {
      // A real session ended from the browser's side (the tab closed or crashed).
      if (method === "Target.detachedFromTarget") {
        const ended = (params as { sessionId?: string }).sessionId;
        for (const page of this.pages.values()) if (ended && page.realId === ended) this.releaseReal(page);
      }
      return;
    }
    for (const page of this.pages.values()) {
      const child = page.children.has(sessionId);
      if (!child && page.realId !== sessionId) continue;
      const childId = (params as { sessionId?: string } | undefined)?.sessionId;
      if (childId && method === "Target.attachedToTarget") page.children.add(childId);
      if (childId && method === "Target.detachedFromTarget") page.children.delete(childId);
      if (child) this.send({ method, params, sessionId });
      else for (const relaySession of page.sessions) this.send({ method, params, sessionId: relaySession });
      return;
    }
  }

  connected(connection: WebSocketConnection): void {
    this.connection = connection;
    this.downloads = new RelayDownloads(
      (method, params) => this.send({ method, params }),
      (tabId) => [...this.pages.values()].find((page) => page.tabId === tabId && page.sessions.size)?.targetId,
      (id) => this.desktop.downloadCommand(id, "cancel"),
    );
  }

  disconnected(): void {
    this.connection = null;
    this.downloads = null;
    this.autoAttach = false;
    for (const page of this.pages.values()) this.releaseReal(page);
    this.pages.clear();
    this.browserSessions.clear();
  }
}

interface ThreadBrowser {
  readonly relay: ThreadRelay;
  readonly endpoint: WebSocketEndpoint;
  readonly browser: Browser;
  readonly context: BrowserContext;
  idle: ReturnType<typeof setTimeout> | null;
  /** Tabs kept rendering while the connection lasts (Desktop.setTabAwake). */
  readonly awake: Set<number>;
}

/** Each thread's Playwright connection to its tabs. */
export class ThreadPages {
  private readonly cdp: BrowserCdp;
  private readonly desktop: Desktop;
  private readonly threads = new Map<string, Promise<ThreadBrowser>>();
  private readonly tabIds = new WeakMap<Page, number>();

  constructor(cdp: BrowserCdp, desktop: Desktop) {
    this.cdp = cdp;
    this.desktop = desktop;
    cdp.addEventListener((event) => {
      for (const pending of this.threads.values()) void pending.then((entry) => entry.relay.browserEvent(event), () => {});
    });
    desktop.changeListeners.add(() => {
      for (const pending of this.threads.values()) void pending.then((entry) => entry.relay.sync(), () => {});
    });
  }

  private connect(threadId: string): Promise<ThreadBrowser> {
    let pending = this.threads.get(threadId);
    if (pending) return pending;
    pending = (async () => {
      const relay = new ThreadRelay(threadId, this.cdp, this.desktop);
      const endpoint = await listenWebSocket({
        onConnection: (connection) => relay.connected(connection),
        onMessage: (text) => relay.receive(text),
        onClose: () => relay.disconnected(),
      });
      try {
        // Loaded on first use: the helper runs without it (npm ci in helper/).
        const { chromium } = await import("playwright-core").catch(() => {
          throw new Error("Page automation needs playwright-core: run npm ci in Plutonium's helper/ directory.");
        });
        const browser = await chromium.connectOverCDP(endpoint.url, { timeout: 15_000 });
        const context = browser.contexts()[0];
        if (!context) throw new Error("The relay showed Playwright no browser context.");
        // Leave dialogs to the user, and to answer_dialog: without a listener
        // Playwright dismisses every dialog the page opens.
        const keepDialogs = (page: Page) => page.on("dialog", () => {});
        context.pages().forEach(keepDialogs);
        context.on("page", keepDialogs);
        const awake = new Set<number>();
        browser.on("disconnected", () => {
          if (this.threads.get(threadId) === pending) this.threads.delete(threadId);
          endpoint.close();
          for (const tabId of awake) void this.desktop.setTabAwake(tabId, false).catch(() => {});
        });
        return { relay, endpoint, browser, context, idle: null, awake };
      } catch (error) {
        endpoint.close();
        throw error;
      }
    })();
    this.threads.set(threadId, pending);
    pending.catch(() => {
      if (this.threads.get(threadId) === pending) this.threads.delete(threadId);
    });
    return pending;
  }

  /** Tab `tabId`'s page, for thread `threadId` (which must own it). */
  async page(threadId: string, tabId: number): Promise<Page> {
    const thread = await this.connect(threadId);
    if (thread.idle) clearTimeout(thread.idle);
    thread.idle = setTimeout(() => {
      thread.idle = null;
      void thread.browser.close().catch(() => {});
    }, IDLE_MS);
    thread.idle.unref();
    const tab = this.desktop.tab(tabId);
    if (!tab) throw new Error(`No tab ${tabId}.`);
    // A tab no page shows draws a frame a second, and Playwright waits on
    // frames before it acts: keep it drawing while we drive it.
    if (!thread.awake.has(tabId)) {
      thread.awake.add(tabId);
      void this.desktop.setTabAwake(tabId, true).catch(() => thread.awake.delete(tabId));
    }
    // A page Playwright has; a tab that came just now may still be on its way.
    for (let attempt = 0; attempt < 20; attempt++) {
      for (const page of thread.context.pages()) {
        if ((await this.tabIdOf(thread.context, page)) === tabId) return page;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Tab ${tabId}'s page isn't ready.`);
  }

  private async tabIdOf(context: BrowserContext, page: Page): Promise<number | undefined> {
    const known = this.tabIds.get(page);
    if (known !== undefined) return known;
    // The page's own session tells its target id.
    const session = await context.newCDPSession(page);
    try {
      const { targetInfo } = (await session.send("Target.getTargetInfo")) as { targetInfo: { targetId: string } };
      const tab = this.desktop.tabs().find((entry) => entry.targetId === targetInfo.targetId);
      if (tab) this.tabIds.set(page, tab.id);
      return tab?.id;
    } finally {
      void session.detach().catch(() => {});
    }
  }

  closeAll(): void {
    for (const pending of this.threads.values()) void pending.then((entry) => entry.browser.close(), () => {});
    this.threads.clear();
  }
}
