// Plutonium shell library: everything a frontend needs beyond its own UI.
//
// Load it from the helper, in the shell page (the document Chromium names with
// --plutonium-shell-origin, the only one with navigator.windowBroker):
//
//   const { connect } = await import("http://127.0.0.1:3780/v1/shell.js");
//   const shell = connect({ onFocus: (window) => { openTabFor(window); return true; } });
//   shell.addEventListener("change", () => render(shell.windowsOf(currentThreadId)));
//
// It keeps the window list from the broker's events, finds each window's thread
// through the helper, and serves the helper's agent bridge requests (list,
// focus, close, snapshot) with the broker. The frontend only decides how
// windows are shown: `onFocus` is how an agent's "show this window" reaches
// its UI.
//
// Browser tabs work the same way, shown with
//   <embed type="application/x-chromium-surface-embed" data-content-id="…">
// (tabElement() makes one). `onFocusTab` is how an agent's "show this tab"
// reaches the UI.
//
// Server-driven tabs: a frontend's server can drive a tab this page shows for
// it (T3 Code drives its browser panel's tabs with Playwright). The page shows
// the tab and calls showServerTab(); the helper gives the server that one
// tab's DevTools. The agent's cursor arrives as "agentpointer" events.
//
// Tags: every window and tab carries a list of tags, and items with the same
// tag go together. The first is where the item came from: the thread that
// started a window's app, or the thread a tab was created for (tabs its page
// opens inherit its tags). A thread's id is its tag, namespaced by the shell
// ("t3:thread/<id>", "plain:thread/<id>"; a workspace manager might use
// "wm:workspace/2"). Adding a thread's tag to an item from elsewhere
// (tagWindow, tagTab) brings it into the thread, and gives the thread's agent
// access to it. setGroups() tells the browser and the other shells what this
// shell's tags are called; `groups` holds every shell's.

const HELPER = new URL(import.meta.url).origin;

/**
 * @typedef {{ id: number, appId: string, title: string, width: number, height: number,
 *   deviceScaleFactor: number, embedded: boolean, focused: boolean, pid: number,
 *   tag: string, tags: string[] }} NativeWindowEntry
 *   tag: the thread that started it ("" if none); tags: tag first, then the ones shells added.
 * @typedef {NativeWindowEntry & { threadId: string | null | undefined }} ShellWindow
 *   threadId: the thread that started it; null if none did; undefined until known.
 * @typedef {{ tag: string, label: string, shellId: string }} ItemGroup
 *   A tag a shell described; shellId is the shell that owns it.
 * @typedef {{ id: string, name: string, url: string, origin: string, enabled: boolean,
 *   running: boolean, visible: boolean }} ShellEntry
 *   One of the browser's shells (several live at once; one is visible).
 * @typedef {{ id: number, contentId: string, url: string, title: string, loading: boolean,
 *   canGoBack: boolean, canGoForward: boolean, embedded: boolean, focused: boolean, tag: string,
 *   openerId: number, openedBy: string, dialogType: string, dialogMessage: string,
 *   dialogDefaultPrompt: string, tags: string[] }} BrowserTab
 *   tag: the thread it was created for ("" if none); tags: tag first, then the ones shells added.
 *   dialogType: "alert", "confirm", "prompt" or "beforeunload" while the page waits on a
 *   dialog (answer it with answerTabDialog()), else "".
 * @typedef {{ id: string, name: string, genericName: string, comment: string,
 *   keywords: string[], categories: string[], hasIcon: boolean, terminal: boolean }} DesktopApp
 * @typedef {{ onFocus?: (window: ShellWindow) => boolean | Promise<boolean>,
 *   onFocusTab?: (tab: BrowserTab) => boolean | Promise<boolean>,
 *   onOpenTab?: (tab: BrowserTab) => string | null | undefined | Promise<string | null | undefined> }} ConnectOptions
 *   onOpenTab: a link this page opened in a new tab or window (Ctrl+click, target=_blank,
 *   window.open) arrived as a tab, untagged. Return the thread to put it in (it is then tagged
 *   and shown with onFocusTab), or nothing to leave it alone.
 */

/** The <embed> type that shows a browser tab. */
export const TAB_EMBED_TYPE = "application/x-chromium-surface-embed";

export class PlutoniumShell extends EventTarget {
  /** @param {ConnectOptions} options */
  constructor(options = {}) {
    super();
    /** @type {((window: ShellWindow) => boolean | Promise<boolean>) | undefined} */
    this.onFocus = options.onFocus;
    /** @type {((tab: BrowserTab) => boolean | Promise<boolean>) | undefined} */
    this.onFocusTab = options.onFocusTab;
    /** @type {ConnectOptions["onOpenTab"]} */
    this.onOpenTab = options.onOpenTab;
    /** Link tabs this page opened that were already handed to onOpenTab. */
    this._openedTabs = new Set();
    this.helper = HELPER;
    /** @type {any} */
    this.broker = navigator.windowBroker ?? null;
    /** Whether this page is the shell (has the window broker). */
    this.available = this.broker !== null;
    /** Whether this Chromium has browser tabs. */
    this.tabsAvailable = this.available && typeof this.broker.createTab === "function";
    /** Whether this Chromium has tags and groups (else a window's thread comes from the helper). */
    this.tagsAvailable = this.available && typeof this.broker.updateWindowTags === "function";
    /** This page's shell's id in the browser ("" outside shell mode); set once ready. */
    this.shellId = "";
    /** @type {Map<string, ItemGroup>} every shell's groups, by tag */
    this.groups = new Map();
    /** @type {ShellEntry[]} the browser's shells (empty outside shell mode) */
    this.shells = [];
    /** @type {Map<number, BrowserTab>} */
    this.tabs = new Map();
    /** @type {Map<number, ShellWindow>} */
    this.windows = new Map();
    /** @type {Map<number, string | null>} pid → thread (null: none) */
    this.threadByPid = new Map();
    /** @type {Map<number, Promise<string>>} */
    this.grants = new Map();
    this._pendingPids = new Set();
    /** Windows the browser couldn't find the thread of, to tag once the helper has. */
    this._tagFromHelper = new Set();
    this._resolveTimer = null;
    this._events = null;
    /** @type {Map<string, Promise<string | null>>} */
    this._appIcons = new Map();
    /** This page's id with the helper (its request stream's). */
    this._pageId = crypto.randomUUID();
    /** @type {Map<string, { threadId: string, tabId: string, browserTabId: number, targetId: string }>} */
    this._serverTabs = new Map();
    this.ready = this.available ? this._start() : Promise.resolve();
  }

  async _start() {
    // Subscribing replays the current windows as "windowadded" events.
    const onWindow = (event) => this._setWindow(event.entry);
    this.broker.addEventListener("windowadded", onWindow);
    this.broker.addEventListener("windowchanged", onWindow);
    this.broker.addEventListener("windowremoved", (event) => {
      this.grants.delete(event.windowId);
      if (this.windows.delete(event.windowId)) this._changed();
    });
    if (this.tabsAvailable) {
      // Replays the current tabs as "tabadded" events.
      const onTab = (event) => {
        if (!event.entry) return;
        const tab = plainTab(event.entry);
        this.tabs.set(event.tabId, tab);
        this._changed();
        this._maybeClaimOpenedTab(tab);
      };
      this.broker.addEventListener("tabadded", onTab);
      this.broker.addEventListener("tabchanged", onTab);
      this.broker.addEventListener("tabremoved", (event) => {
        for (const shown of [...this._serverTabs.values()]) {
          if (shown.browserTabId === event.tabId) void this.releaseServerTab(shown);
        }
        if (this.tabs.delete(event.tabId)) this._changed();
      });
    }
    if (this.tagsAvailable) {
      this.shellId = await this.broker.getShellId().catch(() => "");
      // Fired once on subscribing, then after every change.
      this.broker.addEventListener("groupschanged", async () => {
        const groups = await this.broker.getGroups().catch(() => null);
        if (!groups) return;
        this.groups = new Map(groups.map((group) => [group.tag, plainGroup(group)]));
        this._changed();
      });
      this.broker.addEventListener("shellschanged", async () => {
        const shells = await this.broker.getShells().catch(() => null);
        if (!shells) return;
        this.shells = shells.map(plainShell);
        // Shells added in the browser at runtime aren't on the helper's
        // command line: vouch for them (only a shell may).
        const origins = [...new Set(this.shells.filter((shell) => shell.enabled).map((shell) => shell.origin))];
        fetch(`${HELPER}/v1/shell/origins`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ origins }),
        }).catch(() => {});
        this._changed();
      });
    }
    // The browser's shells overlay asks this shell to show an item.
    this.broker.addEventListener("windowfocusrequest", async (event) => {
      const window = this.windows.get(event.windowId) ?? { ...plain(event.entry), threadId: event.entry.tag || null };
      if (!(this.onFocus && (await this.onFocus(window)))) this.broker.showOnDesktop(event.windowId);
    });
    if (this.tabsAvailable) {
      this.broker.addEventListener("tabfocusrequest", async (event) => {
        const tab = this.tabs.get(event.tabId) ?? plainTab(event.entry);
        if (this.onFocusTab) await this.onFocusTab(tab);
      });
    }
    this._serveBridge();
    const windows = await this.broker.getWindows();
    for (const entry of windows) this._setWindow(entry);
  }

  // A link this page opened in a new tab (the browser makes it a tab opened
  // by "shell:<id>", untagged): the frontend picks its thread.
  async _maybeClaimOpenedTab(tab) {
    if (!this.shellId || tab.openedBy !== `shell:${this.shellId}` || tab.tags.length > 0) return;
    if (this._openedTabs.has(tab.id)) return;
    this._openedTabs.add(tab.id);
    const thread = this.onOpenTab ? await this.onOpenTab(tab) : undefined;
    if (!thread) return;
    await this.tagTab(tab.id, [thread]).catch(() => {});
    const tagged = this.tabs.get(tab.id) ?? { ...tab, tags: [thread] };
    if (this.onFocusTab) await this.onFocusTab(tagged);
  }

  _setWindow(entry) {
    if (!entry) return;
    if (this.tagsAvailable && (entry.tag || entry.tags.length > 0 || entry.pid <= 0)) {
      // The browser read the thread from the app's environment.
      this.windows.set(entry.id, { ...plain(entry), threadId: entry.tag || entry.tags[0] || null });
      this._changed();
      return;
    }
    // Without tags, or when the browser couldn't read the app's environment
    // (e.g. Ash in a container with its own user namespace): ask the helper,
    // and name the window's origin with the answer so that everyone sees it.
    if (this.tagsAvailable) this._tagFromHelper.add(entry.id);
    const threadId = this.threadByPid.has(entry.pid)
      ? this.threadByPid.get(entry.pid)
      : entry.pid > 0
        ? undefined
        : null;
    this.windows.set(entry.id, { ...plain(entry), threadId });
    if (threadId === undefined) this._resolvePid(entry.pid);
    this._changed();
  }

  _changed() {
    this.dispatchEvent(new Event("change"));
  }

  // A client's environment is fixed at exec, so a pid resolves once.
  // Unresolved pids are retried on the window's next change.
  _resolvePid(pid) {
    this._pendingPids.add(pid);
    this._resolveTimer ??= setTimeout(async () => {
      this._resolveTimer = null;
      const pids = [...this._pendingPids];
      this._pendingPids.clear();
      let resolved;
      try {
        const response = await fetch(`${HELPER}/v1/window-threads?pids=${pids.join(",")}`);
        if (!response.ok) return;
        resolved = await response.json();
      } catch {
        return;
      }
      for (const pid of pids) this.threadByPid.set(pid, resolved[pid] ?? null);
      for (const [id, window] of this.windows) {
        if (window.threadId === undefined && this.threadByPid.has(window.pid)) {
          const threadId = this.threadByPid.get(window.pid);
          this.windows.set(id, { ...window, threadId, tags: window.tags.length || !threadId ? window.tags : [threadId] });
          if (threadId && this._tagFromHelper.delete(id)) {
            // Its origin, as the browser would have read it (once; another
            // shell may have named it already).
            this.broker.setWindowOriginTag(id, threadId).catch(() => {});
          }
        }
      }
      this._changed();
    }, 50);
  }

  /** The windows tagged `tag` (a thread's: those it started or was given), oldest first. */
  windowsOf(tag) {
    return [...this.windows.values()].filter((w) => windowTags(w).includes(tag)).sort((a, b) => a.id - b.id);
  }

  /** Windows with no tag at all, oldest first. */
  untaggedWindows() {
    return [...this.windows.values()]
      .filter((w) => w.threadId !== undefined && windowTags(w).length === 0)
      .sort((a, b) => a.id - b.id);
  }

  /** The browser tabs tagged `tag`, oldest first. */
  tabsOf(tag) {
    return [...this.tabs.values()].filter((t) => t.tags.includes(tag)).sort((a, b) => a.id - b.id);
  }

  /** Tabs with no tag at all, oldest first. */
  untaggedTabs() {
    return [...this.tabs.values()].filter((t) => t.tags.length === 0).sort((a, b) => a.id - b.id);
  }

  /**
   * Windows and tabs that carry none of `tags` (e.g. this shell's thread
   * tags): what other shells, workspaces or nothing at all show. Oldest first.
   * @returns {{ windows: ShellWindow[], tabs: BrowserTab[] }}
   */
  elsewhere(tags) {
    const mine = new Set(tags);
    const outside = (list) => !list.some((tag) => mine.has(tag));
    return {
      windows: [...this.windows.values()]
        .filter((w) => w.threadId !== undefined && outside(windowTags(w)))
        .sort((a, b) => a.id - b.id),
      tabs: [...this.tabs.values()].filter((t) => outside(t.tags)).sort((a, b) => a.id - b.id),
    };
  }

  /** What to call `tag`: its group's label, else the tag itself. */
  labelOf(tag) {
    return this.groups.get(tag)?.label || tag;
  }

  /**
   * Adds `add` to and takes `remove` out of window `windowId`'s tags (its
   * first, origin tag stays). Adding a thread's tag brings the window into it.
   */
  tagWindow(windowId, add, remove = []) {
    if (!this.tagsAvailable) return Promise.reject(new Error("this Chromium has no tags"));
    return this.broker.updateWindowTags(windowId, add, remove);
  }

  /** As tagWindow(), for tab `tabId`. */
  tagTab(tabId, add, remove = []) {
    if (!this.tagsAvailable) return Promise.reject(new Error("this Chromium has no tags"));
    return this.broker.updateTabTags(tabId, add, remove);
  }

  /**
   * Describes this shell's tags: `[{ tag, label }]`, replacing what it said
   * before. Other shells and the browser's overlay show the labels, and the
   * helper sends agent requests about a tag to the shell that owns it.
   */
  setGroups(groups) {
    if (!this.tagsAvailable) return;
    this.broker.setGroups(groups.map(({ tag, label }) => ({ tag, label: label ?? "" })));
  }

  /** Makes this page's shell the visible one (several shells; else nothing). */
  showShell() {
    this.broker?.showShell?.();
  }

  /**
   * Opens a browser tab at `url` (anything the omnibox would load) for
   * `threadId`. Resolves to the new tab; it also arrives as a change.
   * @returns {Promise<BrowserTab>}
   */
  async createTab(threadId, url) {
    if (!this.tabsAvailable) throw new Error("this Chromium has no browser tabs");
    const tab = plainTab(await this.broker.createTab(url, threadId ?? ""));
    this.tabs.set(tab.id, tab);
    this._changed();
    return tab;
  }

  /** Loads `url` in tab `tabId`, as typed in an address bar. */
  navigateTab(tabId, url) {
    if (!this.tabsAvailable) return Promise.reject(new Error("this Chromium has no browser tabs"));
    return this.broker.navigateTab(tabId, url);
  }

  /** "back", "forward", "reload", "stop" or "close". */
  tabCommand(tabId, command) {
    this.broker?.tabCommand?.(tabId, command);
  }

  /** Answers the tab's pending dialog: OK (`accept`) or Cancel, with `text` for a prompt. */
  answerTabDialog(tabId, accept, text = "") {
    this.broker?.answerTabDialog?.(tabId, accept, text);
  }

  /** @returns {Promise<Blob>} a PNG of what tab `tabId` shows. */
  snapshotTab(tabId) {
    if (!this.tabsAvailable) return Promise.reject(new Error("this Chromium has no browser tabs"));
    return this.broker.snapshotTab(tabId);
  }

  /**
   * Lets the frontend's server drive browser tab `browserTabId`, which this
   * page shows as the server's tab `{threadId, tabId}` (the server's names).
   * Resolves to the browser tab to show for it: another shell page may show
   * the server's tab already, and then every page shows that one.
   * @returns {Promise<number>}
   */
  async showServerTab(browserTabId, { threadId, tabId }) {
    if (!this.tabsAvailable) throw new Error("this Chromium has no browser tabs");
    const shown = { threadId, tabId, browserTabId, targetId: await this._targetId(browserTabId) };
    this._serverTabs.set(serverTabKey(shown), shown);
    // Otherwise the request stream announces it once it opens.
    if (this._events?.readyState !== EventSource.OPEN) return browserTabId;
    return this._announceServerTab(shown);
  }

  /** The server's tab `{threadId, tabId}` is no longer shown here. */
  async releaseServerTab({ threadId, tabId }) {
    const key = serverTabKey({ threadId, tabId });
    if (!this._serverTabs.delete(key)) return;
    await fetch(`${HELPER}/v1/shell/server-tabs/detach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page: this._pageId, threadId, tabId }),
    }).catch(() => {});
  }

  // A page's main frame id is its DevTools target id.
  async _targetId(browserTabId) {
    const tree = JSON.parse(await this.broker.sendTabDevToolsCommand(browserTabId, "Page.getFrameTree", "{}"));
    const targetId = tree?.frameTree?.frame?.id;
    if (typeof targetId !== "string") throw new Error(`tab ${browserTabId} has no page`);
    return targetId;
  }

  /** Tells the helper; resolves to the browser tab every page shows for it. */
  async _announceServerTab(shown) {
    const tab = this.tabs.get(shown.browserTabId);
    const response = await fetch(`${HELPER}/v1/shell/server-tabs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        page: this._pageId,
        threadId: shown.threadId,
        tabId: shown.tabId,
        browserTabId: shown.browserTabId,
        targetId: shown.targetId,
        url: tab?.url ?? "",
        title: tab?.title ?? "",
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `the helper refused the tab (${response.status})`);
    if (body.browserTabId !== shown.browserTabId && typeof body.browserTabId === "number") {
      // Another page's tab: show that one.
      shown.browserTabId = body.browserTabId;
      shown.targetId = await this._targetId(body.browserTabId).catch(() => shown.targetId);
    }
    return shown.browserTabId;
  }

  /** An <embed> that shows tab `tabId` (style it like any element). */
  tabElement(tabId) {
    const element = document.createElement("embed");
    element.type = TAB_EMBED_TYPE;
    const tab = this.tabs.get(tabId);
    if (tab) element.dataset.contentId = tab.contentId;
    element.dataset.tab = String(tabId);
    return element;
  }

  /** A grant to embed `windowId` in this document (one per window, reused). */
  grantFor(windowId) {
    if (!this.available) return Promise.reject(new Error("not the Plutonium shell"));
    let grant = this.grants.get(windowId);
    if (!grant) {
      grant = this.broker.requestGrant(windowId);
      grant.catch(() => this.grants.delete(windowId));
      this.grants.set(windowId, grant);
    }
    return grant;
  }

  /** Raises `windowId` on the desktop once no element shows it any more. */
  showOnDesktop(windowId) {
    this.broker?.showOnDesktop(windowId);
  }

  /** Asks the app to close `windowId`, as its close button would. */
  close(windowId) {
    this.broker?.close(windowId);
  }

  /** @returns {Promise<Blob>} a PNG of what `windowId` shows. */
  snapshot(windowId) {
    if (!this.available) return Promise.reject(new Error("not the Plutonium shell"));
    return this.broker.snapshot(windowId);
  }

  /**
   * Starts `argv` as one of `threadId`'s processes. With `waitMs`, resolves
   * once its window shows up (or the time is up).
   * @returns {Promise<{ pid: number, windows: object[] }>}
   */
  async launch(threadId, argv, { cwd, waitMs = 0 } = {}) {
    const response = await fetch(`${HELPER}/v1/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread: threadId, argv, cwd, waitMs }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `launch failed (${response.status})`);
    return body;
  }

  /**
   * Desktop apps the helper can launch (freedesktop.org desktop entries), by name.
   * @returns {Promise<DesktopApp[]>}
   */
  async apps() {
    const response = await fetch(`${HELPER}/v1/apps`);
    if (!response.ok) throw new Error(`could not list apps (${response.status})`);
    return response.json();
  }

  /**
   * An object URL for app `appId`'s icon, or null if it has none. Cached for
   * the page's lifetime. (Fetched, not linked: only the shell may read the helper.)
   * @returns {Promise<string | null>}
   */
  appIcon(appId) {
    let icon = this._appIcons.get(appId);
    if (!icon) {
      icon = fetch(`${HELPER}/v1/apps/${encodeURIComponent(appId)}/icon`)
        .then(async (response) => (response.ok ? URL.createObjectURL(await response.blob()) : null))
        .catch(() => null);
      this._appIcons.set(appId, icon);
    }
    return icon;
  }

  /**
   * Starts desktop app `appId` as one of `threadId`'s processes. With
   * `waitMs`, resolves once its window shows up (or the time is up).
   * @returns {Promise<{ pid: number, windows: object[] }>}
   */
  async launchApp(threadId, appId, { waitMs = 0 } = {}) {
    const response = await fetch(`${HELPER}/v1/apps/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread: threadId, id: appId, waitMs }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `launch failed (${response.status})`);
    return body;
  }

  /**
   * Key combinations the page handles itself, such as "Ctrl+KeyT" or
   * "Alt+Digit1" (Ctrl, Alt, Shift, Super, then a KeyboardEvent.code). While
   * an embedded window or a tab has keyboard focus, they reach this page as
   * ordinary key events instead. Replaces the previous list. Super+F is the
   * browser's (fullscreen) and can't be taken.
   */
  setShellShortcuts(shortcuts) {
    this.broker?.setShellShortcuts?.(shortcuts);
  }

  // The agent bridge: the helper sends requests over an EventSource and gets
  // each answer as a POST.
  _serveBridge() {
    // Several shells can run at once (the browser shows one): the helper
    // sends requests to the visible one, so tell it when this page is shown
    // or hidden. The id survives the EventSource's reconnects.
    const page = this._pageId;
    const visible = () => (document.visibilityState === "visible" ? "1" : "0");
    const shell = encodeURIComponent(this.shellId);
    const events = new EventSource(`${HELPER}/v1/shell/requests?page=${page}&shell=${shell}&visible=${visible()}`);
    this._events = events;
    // The helper knows a page's server tabs while its stream is open (and a
    // helper that restarted knows none).
    events.onopen = () => {
      for (const shown of this._serverTabs.values()) this._announceServerTab(shown).catch(() => {});
    };
    document.addEventListener("visibilitychange", () => {
      fetch(`${HELPER}/v1/shell/pages/${page}/visibility`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visible: visible() === "1" }),
      }).catch(() => {});
    });
    events.onmessage = async (message) => {
      const { id, op, args } = JSON.parse(message.data);
      if (id === undefined) {
        // A notice: nothing to answer.
        if (op === "pointer") this.dispatchEvent(new CustomEvent("agentpointer", { detail: args }));
        // The page that showed a server tab went away: this one takes over if it shows it.
        if (op === "server_tab_orphaned") {
          const shown = this._serverTabs.get(serverTabKey(args));
          if (shown) this._announceServerTab(shown).catch(() => {});
        }
        return;
      }
      let body;
      let type = "application/json";
      try {
        const value = await this._bridgeOp(op, args);
        if (value instanceof Blob) {
          body = value;
          type = "image/png";
        } else {
          body = JSON.stringify({ ok: true, value });
        }
      } catch (error) {
        body = JSON.stringify({ ok: false, error: String(error?.message ?? error) });
      }
      fetch(`${HELPER}/v1/shell/replies/${id}`, { method: "POST", headers: { "Content-Type": type }, body }).catch(
        () => {},
      );
    };
  }

  async _bridgeOp(op, args) {
    switch (op) {
      case "windows":
        return (await this.broker.getWindows()).map(plain);
      case "focus": {
        const window = this.windows.get(args.windowId);
        if (window && this.onFocus && (await this.onFocus(window))) {
          // This shell owns the window's thread but may be hidden.
          this.showShell();
          return { how: "shown in the shell" };
        }
        this.broker.showOnDesktop(args.windowId);
        return { how: "popped out to the desktop" };
      }
      case "close":
        this.broker.close(args.windowId);
        return {};
      case "snapshot":
        return this.broker.snapshot(args.windowId);
      case "tabs":
        return this.tabsAvailable ? (await this.broker.getTabs()).map(plainTab) : [];
      case "open_tab": {
        const tab = await this.createTab(args.threadId, args.url);
        return tab;
      }
      case "navigate_tab":
        await this.navigateTab(args.tabId, args.url);
        return {};
      case "tab_command":
        this.tabCommand(args.tabId, args.command);
        return {};
      case "answer_dialog":
        this.answerTabDialog(args.tabId, args.accept, args.text ?? "");
        return {};
      case "groups":
        if (!this.tagsAvailable) throw new Error("this Chromium has no groups");
        return (await this.broker.getGroups()).map(plainGroup);
      case "snapshot_tab":
        return this.snapshotTab(args.tabId);
      case "focus_tab": {
        // A tab opened just now (open_tab) may not have arrived as an event yet.
        const tab =
          this.tabs.get(args.tabId) ??
          (await this.broker.getTabs()).map(plainTab).find((entry) => entry.id === args.tabId);
        if (tab && this.onFocusTab && (await this.onFocusTab(tab))) {
          this.showShell();
          return { how: "shown in the shell" };
        }
        return { how: "not shown: the frontend can't show tabs" };
      }
      default:
        throw new Error(`unknown op ${op}`);
    }
  }
}

function serverTabKey({ threadId, tabId }) {
  return `${threadId}\u0000${tabId}`;
}

function plain(entry) {
  return {
    id: entry.id,
    appId: entry.appId,
    title: entry.title,
    width: entry.width,
    height: entry.height,
    deviceScaleFactor: entry.deviceScaleFactor,
    embedded: entry.embedded,
    focused: entry.focused,
    pid: entry.pid,
    tag: entry.tag ?? "",
    tags: [...(entry.tags ?? [])],
  };
}

// Without tags from the browser, a window's only tag is its thread.
function windowTags(window) {
  if (window.tags.length > 0) return window.tags;
  return window.threadId ? [window.threadId] : [];
}

function plainShell(shell) {
  return {
    id: shell.id,
    name: shell.name,
    url: shell.url,
    origin: shell.origin,
    enabled: shell.enabled,
    running: shell.running,
    visible: shell.visible,
  };
}

function plainGroup(group) {
  return { tag: group.tag, label: group.label, shellId: group.shellId ?? "" };
}

function plainTab(entry) {
  return {
    id: entry.id,
    contentId: entry.contentId,
    url: entry.url,
    title: entry.title,
    loading: entry.loading,
    canGoBack: entry.canGoBack,
    canGoForward: entry.canGoForward,
    embedded: entry.embedded,
    focused: entry.focused,
    tag: entry.tag,
    openerId: entry.openerId,
    openedBy: entry.openedBy,
    dialogType: entry.dialogType ?? "",
    dialogMessage: entry.dialogMessage ?? "",
    dialogDefaultPrompt: entry.dialogDefaultPrompt ?? "",
    tags: [...(entry.tags ?? (entry.tag ? [entry.tag] : []))],
  };
}

let shell = null;

/** The page's PlutoniumShell (one per document; later options replace `onFocus`). */
export function connect(options = {}) {
  if (!shell) shell = new PlutoniumShell(options);
  else {
    if (options.onFocus) shell.onFocus = options.onFocus;
    if (options.onFocusTab) shell.onFocusTab = options.onFocusTab;
    if (options.onOpenTab) shell.onOpenTab = options.onOpenTab;
  }
  return shell;
}
