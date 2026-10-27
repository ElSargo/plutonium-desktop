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
// New items: a window that appears once the page is connected is announced as
// a "windowopened" event, { window, show }, once its thread is known. `show`
// says the user started it (PLUTONIUM_SHOW in its environment: a terminal's or
// a launcher's process), so the frontend brings it to the front; else the
// frontend may just let the user know. A new tab is a "tabopened" event, { tab }.
//
// Server-driven tabs: a frontend's server can drive a tab this page shows for
// it (T3 Code drives its browser panel's tabs with Playwright). The page shows
// the tab and calls showServerTab(); the helper gives the server that one
// tab's DevTools. The agent's cursor arrives as "agentpointer" events.
//
// Windows agents work in: `agentWindows` holds, by window id, the size an
// agent holds a window at (launch_app's width and height, resize_window) and
// whether it's working in it right now. A page showing such a window keeps it
// at that size, scaled into its own box, until the user takes control
// (releaseWindow()); then the page sizes it again. Changes are
// "agentwindowschange" events.
//
// Context menus: Chrome's menu for this page or one of its tabs (editing,
// links, images, spelling; not Chrome's browser-window items) is drawn here,
// in the page's style, as a popover with the class "plutonium-menu". Its
// look comes from CSS custom properties the page sets (--plutonium-menu-bg,
// -fg, -border, -radius, -shadow, -backdrop, -font, -hover-bg, -hover-fg,
// -separator); see MENU_STYLE. connect({ contextMenu: false }) leaves the
// menus to Chrome; a function draws them itself (see ConnectOptions).
//
// Tab features (docs/features/TAB_FEATURES.md): what Chrome reaches through
// its browser window (find, zoom, printing, permission prompts, file
// pickers, downloads) is asked of the shell. A tab's page needing the user is
// a "tab request" of some kind ("permission", "fileChooser", ...): the
// library draws its default UI, unless connect() gets `<option>: false`
// (leave it to the browser's fallback) or a function (draw it yourself:
// return true if you took the request, then answer it with
// answerTabRequest(); `request.signal` aborts if it ends first). What a
// tab's features report (zoom, the requests it waits on as `pending`)
// arrives on the tab, with a "tabstatechange" event per changed field. The
// dialogs' look comes from --plutonium-dialog-bg, -fg, -border, -radius,
// -shadow, -font and -accent (DIALOG_STYLE).
//
// Find in page: Ctrl+F in a tab (or openFind()) opens the library's find
// bar over the tab's element ("findBar" in connect()); find() and stopFind()
// search and stop, and each result arrives as a "findresult" event and the
// tab's `find`.
//
// Downloads: every download from a tab (or this page) is in `downloads()`,
// with the thread it came from, and arrives as "downloadadded",
// "downloadchanged" and "downloadremoved" events ({ download, previous }).
// The library shows a toast when one starts and finishes and a list
// (showDownloads()), unless connect() gets `downloads: false`, or a function
// (download, type) => boolean that returns true for what it shows itself.
// Files go to ~/Downloads; `downloadFolder` (this shell's threads) and
// setDownloadFolder(thread, folder) choose "thread" (~/Downloads/<label>/)
// or a path instead, such as the thread's working directory's ".downloads".
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
//
// Several displays (docs/features/MULTI_MONITOR.md): each display has its own
// shell windows, a page per shell, and its own visible shell. `displays` lists
// them ("displayschange" events), `display` is this page's (pages on displays
// other than the first one also get "?display=<id>" in their URL:
// `displayParam`), and showOnDisplay() / showTabOnDisplay() ask another
// display's visible shell to show an item. A window is shown in one page at
// a time: a <native-window> that attaches it takes it from other pages, whose
// elements fire "windowtaken" (windowState "taken") and get it back when
// their shell is shown again or once no page shows it. To move a window or a
// tab between shells by drag and drop, drag it with startItemDrag() and read
// the drop with itemFromDrop() (WINDOW_DRAG_TYPE, TAB_DRAG_TYPE); showing it
// in the drop target takes it.

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
 * @typedef {{ id: number, width?: number, height?: number, userControl: boolean, busy: boolean }} AgentWindow
 *   width, height: the size an agent holds it at (absent once the user took control, or if
 *   it never held one); busy: an agent gave it input in the last few seconds.
 * @typedef {{ id: string, name: string, url: string, origin: string, enabled: boolean,
 *   running: boolean, visible: boolean, displays: string[], visibleOn: string[] }} ShellEntry
 *   One of the browser's shells (several live at once; one is visible on each display).
 *   visible: on the focused display; displays: where it has a page; visibleOn: where it's visible.
 * @typedef {{ id: string, index: number, label: string, x: number, y: number, width: number,
 *   height: number, scaleFactor: number, rotation: number, primary: boolean, internal: boolean,
 *   focused: boolean, current: boolean }} DisplayEntry
 *   A display. index: 1-based, left to right ("display 2"); x, y, width, height: DIPs on the
 *   desktop; focused: it has the keyboard; current: this page is on it.
 * @typedef {{ id: number, contentId: string, url: string, title: string, loading: boolean,
 *   canGoBack: boolean, canGoForward: boolean, embedded: boolean, focused: boolean, tag: string,
 *   openerId: number, openedBy: string, dialogType: string, dialogMessage: string,
 *   dialogDefaultPrompt: string, tags: string[], pending: Record<string, PendingTabRequest>,
 *   stateJson: string, [feature: string]: any }} BrowserTab
 *   tag: the thread it was created for ("" if none); tags: tag first, then the ones shells added.
 *   dialogType: "alert", "confirm", "prompt" or "beforeunload" while the page waits on a
 *   dialog (answer it with answerTabDialog()), else "".
 *   pending: the tab requests it waits on, by kind. Every other field a tab feature reports
 *   (such as `zoom`) is on the tab too, by its name.
 * @typedef {{ requestId: number, taken: boolean, detail: any }} PendingTabRequest
 *   taken: a shell shows it to the user.
 * @typedef {{ requestId: number, tabId: number, kind: string, detail: any, tab: BrowserTab | undefined,
 *   signal: AbortSignal, answer: (answer: any) => Promise<boolean> }} TabRequest
 *   A tab's page needs the user. answer() answers it (resolves to false if it is over, or the
 *   kind doesn't take that answer); signal aborts if it ends otherwise (an agent answered it,
 *   the browser cancelled it, or the tab closed).
 * @typedef {{ id: number, tabId: number, thread: string, url: string, filename: string, path: string,
 *   mime: string, receivedBytes: number, totalBytes: number,
 *   state: "in-progress" | "paused" | "complete" | "cancelled" | "interrupted",
 *   danger?: string, error?: string, canResume: boolean, startTime: number }} BrowserDownload
 *   thread: the origin tag of the tab that started it ("" for none); tabId: that tab (it may have
 *   closed since). totalBytes: 0 if unknown. danger: Chrome's danger type, while a dangerous file
 *   waits on downloadCommand(id, "keep" | "discard").
 * @typedef {{ id: string, name: string, genericName: string, comment: string,
 *   keywords: string[], categories: string[], hasIcon: boolean, terminal: boolean }} DesktopApp
 * @typedef {{ id: number, parentId: number, type: "command" | "checkbox" | "radio" | "separator" |
 *   "submenu" | "title", label: string, enabled: boolean, checked: boolean }} ContextMenuItem
 *   id: what closeContextMenu() takes (0 for separators and titles); parentId: its submenu's id, or 0.
 * @typedef {{ menuId: number, tabId: number, x: number, y: number, items: ContextMenuItem[],
 *   linkUrl: string, selectionText: string, editable: boolean, mediaType: string }} ContextMenuRequest
 *   tabId: the tab whose page asked (0: this page); x, y: where, in this page's CSS pixels.
 * @typedef {{ onFocus?: (window: ShellWindow) => boolean | Promise<boolean>,
 *   onFocusTab?: (tab: BrowserTab) => boolean | Promise<boolean>,
 *   onOpenTab?: (tab: BrowserTab) => string | null | undefined | Promise<string | null | undefined>,
 *   contextMenu?: false | ((request: ContextMenuRequest) => boolean),
 *   notificationPopups?: false | ((notification: any) => void),
 *   [feature: string]: any }} ConnectOptions
 *   onOpenTab: a link this page opened in a new tab or window (Ctrl+click, target=_blank,
 *   window.open) arrived as a tab, untagged. Return the thread to put it in (it is then tagged
 *   and shown with onFocusTab), or nothing to leave it alone.
 *   contextMenu: false leaves Chrome's context menus to Chrome. A function draws them itself:
 *   it returns true if it shows `request`, then answers with closeContextMenu(menuId, itemId).
 *   zoom: the page zoom toast ("110%" over the tab's element when its level changes). false
 *   shows none; a function (tab: BrowserTab) => boolean shows your own (return true, or false
 *   for the library's). A tab's level is `tab.zoom` (percent) and `tab.zoomDefault`.
 *   A tab feature's option (TAB_REQUEST_KINDS' `option`, or the feature's own, such as `zoom`):
 *   false leaves it to the browser; a function (request: TabRequest) => boolean draws it
 *   itself; left out, the library draws it.
 */

/**
 * The kinds of tab request the library knows, by kind: the connect() option that controls
 * it, and how the library draws it by default (`draw(shell, request)` returns true if it
 * took it; leave `draw` out to leave the kind to the browser's fallback by default).
 * A feature adds its kind with registerTabRequestKind().
 * @type {Map<string, { option: string, draw?: (shell: PlutoniumShell, request: TabRequest) => boolean }>}
 */
export const TAB_REQUEST_KINDS = new Map();

/** Adds (or replaces) a kind of tab request (see TAB_REQUEST_KINDS). */
export function registerTabRequestKind(kind, { option, draw }) {
  TAB_REQUEST_KINDS.set(kind, { option, draw });
}

/** The <embed> type that shows a browser tab. */
export const TAB_EMBED_TYPE = "application/x-chromium-surface-embed";

/** Drag and drop data types for a window and a tab (the item's id, as text). */
export const WINDOW_DRAG_TYPE = "application/x-plutonium-window";
export const TAB_DRAG_TYPE = "application/x-plutonium-tab";

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
    /** @type {ConnectOptions["contextMenu"]} */
    this.contextMenu = options.contextMenu;
    /** @type {ConnectOptions} every option connect() got (tab features read theirs here) */
    this.options = { ...options };
    /** @type {Map<number, AbortController>} tab requests this page took, by id */
    this._tabRequests = new Map();
    /** The context menu shown now. */
    this._menu = null;
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
    /** @type {DisplayEntry[]} the displays, by index (empty outside shell mode) */
    this.displays = [];
    /** @type {DisplayEntry | null} this page's display, once known */
    this.display = null;
    /** This page's display id from its URL ("" on the first display, or with an older browser). */
    this.displayParam = new URLSearchParams(location.search).get("display") ?? "";
    /** Whether this Chromium knows displays. */
    this.displaysAvailable = this.available && typeof this.broker.getDisplays === "function";
    /** @type {Map<number, BrowserTab>} */
    this.tabs = new Map();
    /** @type {Map<number, ShellWindow>} */
    this.windows = new Map();
    /** @type {Map<number, AgentWindow>} windows agents work in, by id */
    this.agentWindows = new Map();
    /** @type {Map<number, string | null>} pid → thread (null: none) */
    this.threadByPid = new Map();
    /** @type {Map<number, Promise<string>>} */
    this.grants = new Map();
    this._pendingPids = new Set();
    /** @type {Map<number, boolean>} pid → whether its start asked to show its windows */
    this.showByPid = new Map();
    this._pendingShowPids = new Set();
    this._showTimer = null;
    /** New windows not yet announced ("windowopened"): their thread or show isn't known yet. */
    this._unannounced = new Set();
    /** Set once the windows from before connecting are in: later ones are new. */
    this._live = false;
    /** Windows the browser couldn't find the thread of, to tag once the helper has. */
    this._tagFromHelper = new Set();
    this._resolveTimer = null;
    this._events = null;
    /** @type {Map<string, Promise<string | null>>} */
    this._appIcons = new Map();
    /** This page's id with the helper (its request stream's). */
    this._pageId = crypto.randomUUID();
    /**
     * Desktop services (DESKTOP_SERVICES.md): `shell.system.audio`, … each
     * with its `state`, a "change" event and `call(action, args)`.
     * @type {SystemServices & Record<string, SystemService>}
     */
    this.system = systemServices();
    /** An installed shell's native side ("native" in its shell.json): `call(name, args)`, and its events. */
    this.native = new ShellNativeSide();
    /** An installed shell's storage: JSON values by key, kept outside its folder. */
    this.storage = shellStorage;
    /** @type {Map<string, { threadId: string, tabId: string, browserTabId: number, targetId: string }>} */
    this._serverTabs = new Map();
    /** Whether this Chromium has the capture API (screenshots, streams, capture requests). */
    this.captureAvailable = this.available && typeof this.broker.captureCommand === "function";
    /** @type {Map<number, Capture>} the running captures, every consumer's, by id */
    this.captureList = new Map();
    /** @type {{ recording: boolean, screenshots: boolean }} the global switches */
    this.captureSettings = { recording: true, screenshots: true };
    /** @type {Map<number, AbortController>} capture requests this page took, by id */
    this._captureRequests = new Map();
    /** This page's own shortcuts (setShellShortcuts()), and the keys apps bound through the portal. */
    this._ownShortcuts = [];
    /** @type {{ session: string, id: string, combo: string }[]} */
    this.globalShortcuts = [];
    /** @type {Map<string, { session: string, id: string, code: string }>} bound keys held down, by combo */
    this._heldShortcuts = new Map();
    this._captureIndicator = null;
    this.ready = this.available ? this._start() : Promise.resolve();
  }

  async _start() {
    // Subscribing replays the current windows as "windowadded" events.
    const onWindow = (event) => this._setWindow(event.entry);
    this.broker.addEventListener("windowadded", onWindow);
    this.broker.addEventListener("windowchanged", onWindow);
    this.broker.addEventListener("windowremoved", (event) => {
      this.grants.delete(event.windowId);
      this._unannounced.delete(event.windowId);
      if (this.windows.delete(event.windowId)) this._changed();
    });
    // A grant the browser revoked can't attach again: forget it, so the
    // next grantFor() asks for a new one.
    this.broker.addEventListener("grantrevoked", async (event) => {
      const cached = this.grants.get(event.windowId);
      if (!cached || (await cached.catch(() => null)) !== event.grant) return;
      if (this.grants.get(event.windowId) === cached) this.grants.delete(event.windowId);
    });
    if (this.tabsAvailable) {
      // Replays the current tabs as "tabadded" events.
      const onTab = (event) => {
        if (!event.entry) return;
        const tab = plainTab(event.entry);
        const previous = this.tabs.get(event.tabId);
        const opened = this._live && !previous;
        this.tabs.set(event.tabId, tab);
        this._changed();
        if (opened) this.dispatchEvent(new CustomEvent("tabopened", { detail: { tab } }));
        if (previous) this._tabStateChanged(previous, tab);
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
          // And the whole list, in order, which the helper saves as the
          // session's shells.json.
          body: JSON.stringify({
            origins,
            shells: this.shells.map(({ name, url, enabled }) => ({ name, url, enabled })),
          }),
        }).catch(() => {});
        this._changed();
      });
    }
    if (this.displaysAvailable) {
      // Fired once on subscribing, then after every change.
      this.broker.addEventListener("displayschanged", () => this._refreshDisplays());
      await this._refreshDisplays();
    }
    // Touchpad swipes with three fingers or more (only the focused display's
    // visible shell gets them, and nothing else does): "touchpadswipe", its
    // detail {phase: "begin" | "update" | "end", fingers, dx, dy, x, y}, dx and
    // dy the fingers' movement since the last one. None on X11, or before
    // Chromium patch 0074.
    // Before patch 0076 the browser's swipe begin and end didn't arrive (only
    // updates), so until an end has come from it, a swipe begins at its first
    // update (or when the finger count changes) and ends once updates stop for
    // SWIPE_END_MS.
    let swipe = null;
    let browserEnds = false;
    const sendSwipe = (detail) => this.dispatchEvent(new CustomEvent("touchpadswipe", { detail }));
    const endSwipe = () => {
      if (!swipe) return;
      clearTimeout(swipe.timer);
      sendSwipe({ phase: "end", fingers: swipe.fingers, dx: 0, dy: 0, x: swipe.x, y: swipe.y });
      swipe = null;
    };
    this.broker.addEventListener("touchpadswipe", (event) => {
      const detail = event.detail ?? {};
      if (detail.phase === "end") {
        browserEnds = true;
        return endSwipe();
      }
      if (detail.phase === "begin") endSwipe();
      if (swipe && swipe.fingers !== detail.fingers) endSwipe();
      if (!swipe) {
        swipe = { fingers: detail.fingers, x: detail.x, y: detail.y, timer: 0 };
        sendSwipe({ ...detail, phase: "begin", dx: 0, dy: 0 });
      }
      if (detail.phase === "begin") return;
      swipe.x = detail.x;
      swipe.y = detail.y;
      clearTimeout(swipe.timer);
      if (!browserEnds) swipe.timer = setTimeout(endSwipe, SWIPE_END_MS);
      sendSwipe(detail);
    });
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
    // Zoom: a toast when a tab's level changes (TAB_FEATURES.md, "Zoom").
    this.addEventListener("tabstatechange", (event) => {
      const { tab, key, value, previous } = event.detail;
      if (key !== "zoom" || previous === undefined || value === undefined) return;
      const option = this.options.zoom;
      if (option === false) return;
      if (typeof option === "function" && option(tab)) return;
      this.showTabToast(tab.id, `${value}%`);
    });
    // Tab features' requests (TAB_FEATURES.md).
    if (typeof this.broker.answerTabRequest === "function") {
      this.broker.addEventListener("tabrequest", (event) => this._onTabRequest(event));
      this.broker.addEventListener("tabrequestend", (event) => {
        const controller = this._tabRequests.get(event.requestId);
        this._tabRequests.delete(event.requestId);
        controller?.abort();
      });
    }
    // Downloads (TAB_FEATURES.md, "Downloads").
    if (typeof this.broker.downloadCommand === "function") this._startDownloads();
    // Chrome's context menus, drawn in this page's style.
    if (typeof this.broker.closeContextMenu === "function") {
      this.broker.addEventListener("contextmenurequest", (event) => this._onContextMenuRequest(event));
    }
    // Captures (docs/features/CAPTURE.md).
    if (this.captureAvailable) this._startCaptures();
    this._startGlobalShortcuts();
    this._serveBridge();
    this._startNotifications();
    const windows = await this.broker.getWindows();
    for (const entry of windows) this._setWindow(entry);
    this._live = true;
  }

  async _refreshDisplays() {
    const displays = await this.broker.getDisplays().catch(() => null);
    if (!displays) return;
    this.displays = displays.map(plainDisplay);
    this.display = this.displays.find((display) => display.current) ?? null;
    this.dispatchEvent(new Event("displayschange"));
    this._changed();
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
    if (this._live && !this.windows.has(entry.id)) {
      this._unannounced.add(entry.id);
      if (entry.pid > 0 && !this.showByPid.has(entry.pid)) this._resolveShow(entry.pid);
    }
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
    const known = plain(entry);
    this.windows.set(entry.id, {
      ...known,
      threadId,
      tags: known.tags.length || !threadId ? known.tags : [threadId],
    });
    if (threadId === undefined) this._resolvePid(entry.pid);
    else if (threadId && this._tagFromHelper.delete(entry.id)) {
      // Another window of a client already resolved (an X app's satellite
      // has all of its thread's X windows): named as the first one was.
      this.broker.setWindowOriginTag(entry.id, threadId).catch(() => {});
    }
    this._changed();
  }

  _changed() {
    this.dispatchEvent(new Event("change"));
    this._announce();
  }

  // "windowopened" for new windows whose thread and show are known.
  _announce() {
    for (const id of this._unannounced) {
      const window = this.windows.get(id);
      const show = !window || window.pid <= 0 ? false : this.showByPid.get(window.pid);
      if (window && (window.threadId === undefined || show === undefined)) continue;
      this._unannounced.delete(id);
      if (window) this.dispatchEvent(new CustomEvent("windowopened", { detail: { window, show } }));
    }
  }

  // As _resolvePid, for PLUTONIUM_SHOW. A helper that can't say means no.
  _resolveShow(pid) {
    this._pendingShowPids.add(pid);
    this._showTimer ??= setTimeout(async () => {
      this._showTimer = null;
      const pids = [...this._pendingShowPids];
      this._pendingShowPids.clear();
      let shows = {};
      try {
        const response = await fetch(`${HELPER}/v1/window-shows?pids=${pids.join(",")}`);
        if (response.ok) shows = await response.json();
      } catch {
        // Not shown, then.
      }
      for (const pid of pids) this.showByPid.set(pid, shows[pid] === true);
      this._changed();
    }, 0);
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

  /** The display with id or index (1-based) `which`, or undefined. */
  displayOf(which) {
    return this.displays.find((display) => display.id === String(which) || display.index === which);
  }

  /**
   * Asks the visible shell on display `which` (id or index) to show window `windowId`, which
   * takes it from where it is shown now, and moves the keyboard there. Resolves to false if
   * there's no such display or window, or that shell doesn't take requests.
   */
  async showOnDisplay(windowId, which) {
    const display = this.displayOf(which);
    if (!display || !this.displaysAvailable) return false;
    return this.broker.showWindowOnDisplay(windowId, display.id);
  }

  /** As showOnDisplay(), for tab `tabId`. */
  async showTabOnDisplay(tabId, which) {
    const display = this.displayOf(which);
    if (!display || !this.displaysAvailable) return false;
    return this.broker.showTabOnDisplay(tabId, display.id);
  }

  /** Moves the keyboard to display `which` (id or index): its visible shell. */
  async focusDisplay(which) {
    const display = this.displayOf(which);
    if (!display || !this.displaysAvailable) return false;
    return this.broker.focusDisplay(display.id);
  }

  /**
   * Starts dragging a window (`{ windowId }`) or a tab (`{ tabId }`) from a "dragstart"
   * `event`, so that another shell (on any display) can take it: see itemFromDrop().
   */
  startItemDrag(event, { windowId, tabId }) {
    const data = event.dataTransfer;
    if (!data) return;
    if (windowId) data.setData(WINDOW_DRAG_TYPE, String(windowId));
    if (tabId) data.setData(TAB_DRAG_TYPE, String(tabId));
    data.effectAllowed = "move";
  }

  /**
   * The window or tab a drag carries (`{ windowId }` or `{ tabId }`), or null. On "dragover"
   * only the types are known: `{ windowId: 0 }` or `{ tabId: 0 }` say which (call
   * preventDefault() to accept). On "drop", show the item (an element with
   * grantFor(windowId), or tabElement(tabId)): that takes it from the shell it was in.
   */
  itemFromDrop(event) {
    const data = event.dataTransfer;
    if (!data) return null;
    const types = [...data.types];
    if (types.includes(WINDOW_DRAG_TYPE)) return { windowId: Number(data.getData(WINDOW_DRAG_TYPE)) || 0 };
    if (types.includes(TAB_DRAG_TYPE)) return { tabId: Number(data.getData(TAB_DRAG_TYPE)) || 0 };
    return null;
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

  /**
   * Runs `command` on tab `tabId`: "back", "forward", "reload", "stop", "close", or a tab
   * feature's ("zoom-in", "zoom-out", "zoom-reset", "find", "print", ...) with `args`.
   * Resolves with its result; rejects if there is no such tab or command.
   */
  async tabCommand(tabId, command, args = undefined) {
    if (typeof this.broker?.tabCommand !== "function") return null;
    const result = await this.broker.tabCommand(tabId, command, args === undefined ? "" : JSON.stringify(args));
    // Browsers from before tab features return nothing.
    return typeof result === "string" && result ? JSON.parse(result) : null;
  }

  /**
   * Sets tab `tabId`'s page zoom to `percent` (25 to 500), for its whole site, as Chrome's
   * zoom menu does. Resolves with the level it got. zoom-in, zoom-out and zoom-reset are
   * tabCommand()s.
   */
  setTabZoom(tabId, percent) {
    return this.tabCommand(tabId, "zoom-set", { percent });
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
  async showServerTab(browserTabId, { threadId, tabId }, { replace = false } = {}) {
    if (!this.tabsAvailable) throw new Error("this Chromium has no browser tabs");
    const shown = { threadId, tabId, browserTabId, targetId: await this._targetId(browserTabId), replace };
    this._serverTabs.set(serverTabKey(shown), shown);
    // Otherwise the request stream announces it once it opens.
    if (this._events?.readyState !== EventSource.OPEN) return browserTabId;
    return this._announceServerTab(shown);
  }

  /**
   * The user takes control of window `id`, which an agent held at a size:
   * the page sizes it from now on.
   */
  async releaseWindow(id) {
    const response = await fetch(`${HELPER}/v1/shell/windows/${id}/release`, { method: "POST" });
    if (!response.ok) throw new Error(`the helper refused (${response.status})`);
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
        replace: shown.replace === true,
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

  // Chrome would show its context menu: take it (preventDefault(), while the
  // event is dispatched) unless the frontend leaves menus to Chrome.
  _onContextMenuRequest(event) {
    if (this.contextMenu === false) return;
    /** @type {ContextMenuRequest} */
    const request = {
      menuId: event.menuId,
      tabId: event.tabId,
      x: event.x,
      y: event.y,
      items: event.items,
      linkUrl: event.linkUrl,
      selectionText: event.selectionText,
      editable: event.editable,
      mediaType: event.mediaType,
    };
    if (typeof this.contextMenu === "function") {
      if (this.contextMenu(request)) event.preventDefault();
      return;
    }
    event.preventDefault();
    this.showContextMenu(request);
  }

  // A tab's page needs the user: the connect() option for its kind decides
  // who draws it (see TAB_REQUEST_KINDS); preventDefault() takes it.
  _onTabRequest(event) {
    const kind = TAB_REQUEST_KINDS.get(event.kind);
    const option = kind ? this.options[kind.option] : undefined;
    if (option === false) return;
    const controller = new AbortController();
    /** @type {TabRequest} */
    const request = {
      requestId: event.requestId,
      tabId: event.tabId,
      kind: event.kind,
      detail: event.detail,
      tab: this.tabs.get(event.tabId),
      signal: controller.signal,
      answer: (answer) => this.answerTabRequest(event.requestId, answer),
    };
    let taken = false;
    try {
      if (typeof option === "function") taken = !!option(request);
      else if (kind?.draw) taken = !!kind.draw(this, request);
    } catch (error) {
      console.error(`plutonium: drawing the ${event.kind} request`, error);
    }
    if (!taken) return;
    event.preventDefault();
    this._tabRequests.set(event.requestId, controller);
  }

  /**
   * Answers tab request `requestId`, which this page took, with `answer` (its form depends
   * on the kind). Resolves to false if it is over, or the kind doesn't take that answer.
   */
  async answerTabRequest(requestId, answer) {
    if (typeof this.broker?.answerTabRequest !== "function") return false;
    const ok = await this.broker.answerTabRequest(requestId, JSON.stringify(answer ?? null)).catch(() => false);
    if (ok) this._tabRequests.delete(requestId);
    return ok;
  }

  // "tabstatechange" for each feature field of the tab that changed.
  _tabStateChanged(previous, tab) {
    const before = parseTabState(previous.stateJson);
    const after = parseTabState(tab.stateJson);
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
      this.dispatchEvent(
        new CustomEvent("tabstatechange", { detail: { tab, key, value: after[key], previous: before[key] } }),
      );
      // Find in page: each result as its own event too.
      if (key === "find" && after.find) {
        this.dispatchEvent(new CustomEvent("findresult", { detail: { tabId: tab.id, ...after.find } }));
      }
    }
  }

  /** The element in this page that shows tab `tabId` now, if any. */
  shownTabElement(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab?.contentId) return null;
    return document.querySelector(`embed[data-content-id="${CSS.escape(tab.contentId)}"]`);
  }

  /** The element in this page that shows native window `windowId` now, if any. */
  shownWindowElement(windowId) {
    if (windowId === undefined || windowId === null) return null;
    return document.querySelector(`native-window[window="${CSS.escape(String(windowId))}"]`);
  }

  // A native app asks for files (the helper's FileChooser portal): a request as a tab's
  // fileChooser one, with `source` ({appId, pid, windowId, name}) instead of a tab. It
  // resolves to the answer, {paths, filter?, choices?}, or null.
  _appFileChooser(args, option) {
    return this._appDialog(args, "fileChooser", option, (request) => (new FileChooser(this, request).open(), true));
  }

  // A native app's dialog (the helper's portals): a request as a tab's of `kind`, with
  // `source` ({appId, pid, windowId, name}) instead of a tab, drawn by `option` (a
  // function) or `draw`. It resolves to the answer, or null ("cancel" too).
  _appDialog(args, kind, option, draw) {
    return new Promise((resolve) => {
      const controller = new AbortController();
      this._appRequests ??= new Map();
      this._appRequests.set(args.handle, controller);
      const giveBack = this._takeKeyboard();
      let done = false;
      const end = (answer) => {
        if (done) return false;
        done = true;
        this._appRequests.delete(args.handle);
        giveBack();
        resolve(answer === "cancel" ? null : (answer ?? null));
        return true;
      };
      controller.signal.addEventListener("abort", () => end(null));
      const request = {
        requestId: args.handle,
        kind,
        detail: args.detail ?? {},
        source: args.source ?? {},
        thread: args.thread ?? null,
        signal: controller.signal,
        answer: async (answer) => end(answer),
      };
      let taken = false;
      try {
        taken = typeof option === "function" ? !!option(request) : draw(request);
      } catch (error) {
        console.error(`plutonium: drawing an app's ${kind} request`, error);
      }
      if (!taken) end(null);
    });
  }

  /**
   * A short message over tab `tabId`'s element (at its top centre), such as "110%"; a new
   * one for the same tab replaces it. Nothing if this page doesn't show the tab.
   */
  showTabToast(tabId, text, { duration = 1500 } = {}) {
    const element = this.shownTabElement(tabId);
    if (!element) return;
    ensureDialogStyle();
    this._toasts ??= new Map();
    this._toasts.get(tabId)?.remove();
    const toast = document.createElement("div");
    toast.className = "plutonium-toast";
    toast.popover = "manual";
    toast.textContent = text;
    document.body.append(toast);
    toast.showPopover();
    const box = element.getBoundingClientRect();
    toast.style.left = `${box.left + box.width / 2 - toast.offsetWidth / 2}px`;
    toast.style.top = `${box.top + 12}px`;
    this._toasts.set(tabId, toast);
    setTimeout(() => {
      toast.remove();
      if (this._toasts.get(tabId) === toast) this._toasts.delete(tabId);
    }, duration);
  }

  /**
   * Find in page (TAB_FEATURES.md): asks for the find bar on tab `tabId` (as Ctrl+F does),
   * with `text` in it or else the selection or the last search. The bar is a "find" tab
   * request, drawn by the library unless connect() got `findBar` (false or a function).
   */
  openFind(tabId, text = undefined) {
    return this.tabCommand(tabId, "find", text === undefined ? {} : { text });
  }

  /**
   * Searches tab `tabId` for `text`, or moves to the next (or previous: `forward` false)
   * match of the same text. `select` false only counts and highlights the matches, without
   * making one active; `scroll` false doesn't scroll to it. Resolves with the result, as
   * the tab's `find` state: {text, matchCase, matches, activeMatch, rect?, final}.
   */
  find(tabId, text, { forward = true, matchCase = false, select = true, scroll = true } = {}) {
    return this.tabCommand(tabId, "find-text", { text, forward, matchCase, select, scroll });
  }

  /**
   * Ends the search on tab `tabId`, and closes its find bar: "keep" leaves the active match
   * selected, "clear" doesn't, "activate" clicks it (a link).
   */
  stopFind(tabId, action = "clear") {
    return this.tabCommand(tabId, "stop-find", { action });
  }

  // Downloads: subscribing replays the current ones as "downloadadded".
  _startDownloads() {
    /** @type {Map<number, BrowserDownload>} */
    this._downloads = new Map();
    const onDownload = (event) => {
      const download = event.download;
      if (!download) return;
      const previous = this._downloads.get(event.downloadId);
      this._downloads.set(event.downloadId, download);
      const type = event.type;
      this.dispatchEvent(new CustomEvent(type, { detail: { download, previous } }));
      // Replayed ones (from before this page subscribed) aren't news.
      if (type === "downloadadded" && Date.now() - download.startTime > 10_000) return;
      this._drawDownload(download, previous);
    };
    this.broker.addEventListener("downloadadded", onDownload);
    this.broker.addEventListener("downloadchanged", onDownload);
    this.broker.addEventListener("downloadremoved", (event) => {
      const previous = this._downloads.get(event.downloadId);
      if (!this._downloads.delete(event.downloadId)) return;
      this.dispatchEvent(new CustomEvent("downloadremoved", { detail: { download: null, previous } }));
      this._downloadList?.render();
    });
    const folder = this.options.downloadFolder;
    if (typeof folder === "string") this.setDownloadFolder("", folder);
  }

  /** The downloads (this session's), oldest first; with `thread`, only that thread's. */
  downloads({ thread } = {}) {
    const all = [...(this._downloads?.values() ?? [])].sort((a, b) => a.id - b.id);
    return thread === undefined ? all : all.filter((download) => download.thread === thread);
  }

  /**
   * Runs `command` on download `id`: "pause", "resume", "cancel", "open", "show" (its folder),
   * "keep" or "discard" (a dangerous file), "remove" (from the list; the file stays).
   * Rejects with why it can't.
   */
  downloadCommand(id, command) {
    if (typeof this.broker?.downloadCommand !== "function") {
      return Promise.reject(new Error("This browser has no downloads API."));
    }
    return this.broker.downloadCommand(id, command);
  }

  /**
   * Where `thread`'s downloads go (or with thread "", every thread this shell owns that has
   * no folder of its own): "downloads" (~/Downloads, the default), "thread"
   * (~/Downloads/<thread label>/), an absolute path ("~/" is the home folder), or "" for the
   * default. Lasts until the browser restarts; set it again on connecting.
   */
  setDownloadFolder(thread, folder) {
    this.broker?.setDownloadFolder?.(thread, folder);
  }

  // The library's toasts for a download that started, finished, failed or needs the user.
  _drawDownload(download, previous) {
    const option = this.options.downloads;
    if (option === false) return;
    const type = previous ? "downloadchanged" : "downloadadded";
    if (typeof option === "function") {
      try {
        if (option(download, type)) return;
      } catch (error) {
        console.error("plutonium: drawing a download", error);
      }
    }
    this._downloadList?.render();
    const name = download.filename || download.url;
    if (!previous) {
      this._downloadToast(download, `Downloading ${name}`);
    } else if (download.state !== previous.state) {
      if (download.state === "complete") this._downloadToast(download, `Downloaded ${name}`);
      else if (download.state === "interrupted") this._downloadToast(download, `Download failed: ${name}`);
    }
    if (download.danger && !previous?.danger) this.showDownloads();
  }

  // A toast over the tab that downloaded, or (a tab that closed) at the top of the page.
  // Clicking it shows the list.
  _downloadToast(download, text) {
    ensureDialogStyle();
    ensureDownloadStyle();
    this._downloadToastElement?.remove();
    const toast = document.createElement("div");
    toast.className = "plutonium-toast plutonium-download-toast";
    toast.popover = "manual";
    toast.textContent = text;
    toast.addEventListener("click", () => {
      toast.remove();
      this.showDownloads();
    });
    document.body.append(toast);
    toast.showPopover();
    const box = this.shownTabElement(download.tabId)?.getBoundingClientRect() ?? {
      left: 0,
      top: 0,
      width: innerWidth,
    };
    toast.style.left = `${Math.max(8, box.left + box.width / 2 - toast.offsetWidth / 2)}px`;
    toast.style.top = `${box.top + 12}px`;
    this._downloadToastElement = toast;
    setTimeout(() => toast.remove(), 4000);
  }

  /**
   * Shows the library's download list (the newest first), with each one's actions; with
   * `thread`, only that thread's. `anchor` (an element) places it below that, else at the
   * top right. Called again from the same anchor while it's open, it closes it (a
   * Downloads button toggles the list).
   */
  showDownloads({ thread, anchor } = {}) {
    const open = this._downloadList;
    open?.close();
    if (open && anchor && open.anchor === anchor) return;
    this._downloadList = new DownloadList(this, thread, anchor);
  }

  /** Draws `request` (Chrome's context menu) here; the choice goes back to Chrome. */
  showContextMenu(request) {
    this._menu?.close(0);
    this._menu = new ContextMenu(this, request);
  }

  /** Closes context menu `menuId`, running item `itemId` unless it is 0. */
  closeContextMenu(menuId, itemId = 0) {
    this.broker?.closeContextMenu?.(menuId, itemId);
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
   * once its window shows up (or the time is up). With `show`, its windows
   * are announced as shown ("windowopened").
   * @returns {Promise<{ pid: number, windows: object[] }>}
   */
  async launch(threadId, argv, { cwd, waitMs = 0, show = false } = {}) {
    const response = await fetch(`${HELPER}/v1/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread: threadId, argv, cwd, waitMs, show }),
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
   * `waitMs`, resolves once its window shows up (or the time is up). Its
   * windows are announced as shown unless `show` is false.
   * @returns {Promise<{ pid: number, windows: object[] }>}
   */
  async launchApp(threadId, appId, { waitMs = 0, show = true } = {}) {
    const response = await fetch(`${HELPER}/v1/apps/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread: threadId, id: appId, waitMs, show }),
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
    this._ownShortcuts = [...shortcuts];
    this._applyShortcuts();
  }

  // This page's own shortcuts, and the keys apps bound (global shortcuts).
  _applyShortcuts() {
    this.broker?.setShellShortcuts?.([...this._ownShortcuts, ...this.globalShortcuts.map((shortcut) => shortcut.combo)]);
  }

  // Global shortcuts (docs/features/CAPTURE.md): keys apps bound through the
  // desktop portal. The page gets them whatever has the keyboard (they're in
  // its shell shortcuts); a press and the release go to the helper, which
  // tells the app. Bound keys are the app's: the page's own handlers don't
  // see them.
  _startGlobalShortcuts() {
    const comboOf = (event) =>
      `${event.ctrlKey ? "Ctrl+" : ""}${event.altKey ? "Alt+" : ""}${event.shiftKey ? "Shift+" : ""}${event.metaKey ? "Super+" : ""}${event.code}`;
    const send = (shortcut, phase) =>
      fetch(`${HELPER}/v1/shell/global-shortcut`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: shortcut.session, id: shortcut.id, phase }),
      }).catch(() => {});
    addEventListener(
      "keydown",
      (event) => {
        if (this._bindingShortcuts) return;
        const combo = comboOf(event);
        const bound = this.globalShortcuts.filter((shortcut) => shortcut.combo === combo);
        if (!bound.length) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.repeat || [...this._heldShortcuts.values()].some((held) => held.code === event.code)) return;
        for (const shortcut of bound) {
          this._heldShortcuts.set(`${combo} ${shortcut.session} ${shortcut.id}`, { ...shortcut, code: event.code });
          send(shortcut, "activated");
        }
      },
      true,
    );
    // The release: of the key, whatever the modifiers are by then.
    const release = (code) => {
      for (const [key, held] of [...this._heldShortcuts]) {
        if (code !== undefined && held.code !== code) continue;
        this._heldShortcuts.delete(key);
        send(held, "deactivated");
      }
    };
    addEventListener("keyup", (event) => release(event.code), true);
    addEventListener("blur", () => release(undefined));
  }

  // Captures (docs/features/CAPTURE.md). Every capture, whoever started it,
  // arrives as "capturestart", "capturechange" and "capturestop" ({ capture });
  // the switches as "capturesettingschange". While this is the focused shell,
  // a consumer that needs the user to choose (an app through the portal, a
  // tab's getDisplayMedia) asks here: the "capturePicker" option decides who
  // draws the picker, and the "captureIndicator" option who shows what's
  // captured (see CapturePicker and CaptureIndicator).
  _startCaptures() {
    const update = (event, type) => {
      const capture = event.detail;
      if (!capture) return;
      const previous = this.captureList.get(capture.id);
      if (type === "capturestop") this.captureList.delete(capture.id);
      else this.captureList.set(capture.id, capture);
      this.dispatchEvent(new CustomEvent(type, { detail: { capture, previous } }));
      this._showCaptures();
    };
    for (const type of ["capturestart", "capturechange", "capturestop"]) {
      this.broker.addEventListener(type, (event) => update(event, type));
    }
    this.broker.addEventListener("capturesettingschange", (event) => {
      if (!event.detail) return;
      this.captureSettings = event.detail;
      this.dispatchEvent(new CustomEvent("capturesettingschange", { detail: { settings: event.detail } }));
    });
    this.broker.addEventListener("capturerequest", (event) => this._onCaptureRequest(event));
    this.broker.addEventListener("capturerequestend", (event) => {
      const controller = this._captureRequests.get(event.id);
      this._captureRequests.delete(event.id);
      controller?.abort();
    });
  }

  // A consumer asks for a capture: take it (preventDefault()) unless the
  // frontend leaves it to Ash's picker.
  _onCaptureRequest(event) {
    const option = this.options.capturePicker;
    if (option === false || !event.detail) return;
    const controller = new AbortController();
    /** @type {CaptureRequest} */
    const request = {
      ...event.detail,
      signal: controller.signal,
      answer: (answer) => this.answerCapture(event.id, answer),
    };
    let taken = false;
    try {
      if (typeof option === "function") taken = !!option(request);
      else taken = !!new CapturePicker(this, request).open();
    } catch (error) {
      console.error("plutonium: drawing the capture picker", error);
    }
    if (!taken) return;
    event.preventDefault();
    this._captureRequests.set(event.id, controller);
  }

  // The indicator: the library's, the frontend's, or none (then Ash shows
  // its own once the captures go unacknowledged).
  _showCaptures() {
    const option = this.options.captureIndicator;
    const captures = this.captures();
    let shown = false;
    if (option === false) shown = false;
    else if (typeof option === "function") shown = !!option(captures);
    else {
      this._captureIndicator ??= new CaptureIndicator(this);
      this._captureIndicator.render(captures);
      shown = true;
    }
    if (!shown) return;
    for (const capture of captures) {
      if (!capture.acknowledged) this.acknowledgeCapture(capture.id).catch(() => {});
    }
  }

  // Apps' notifications (DESKTOP_SERVICES.md, "notifications"): the visible
  // shell pops up the new ones. The "notificationPopups" option: false for
  // none (the shell draws its own from shell.system.notifications), a
  // function to draw each new one itself; else the library's.
  _startNotifications() {
    const option = this.options.notificationPopups;
    if (option === false) return;
    const service = this.system.notifications;
    /** @type {Map<number, number> | null} id → time, of those already seen */
    let seen = null;
    service.addEventListener("change", (event) => {
      const { notifications = [], doNotDisturb = false } = event.detail ?? {};
      // A page that has just connected (a shell reloaded after its edit was rolled back) pops
      // up what came in the last moments: it may be the news about it.
      const fresh = seen
        ? notifications.filter((n) => seen.get(n.id) !== n.time)
        : notifications.filter((n) => Date.now() - n.time < RECENT_NOTIFICATION_MS);
      seen = new Map(notifications.map((n) => [n.id, n.time]));
      if (typeof option !== "function") {
        this._notificationPopups ??= new NotificationPopups(this);
        this._notificationPopups.keep(new Set(seen.keys()));
      }
      if (document.visibilityState !== "visible") return;
      for (const notification of fresh.reverse()) {
        if (doNotDisturb && notification.urgency !== "critical") continue;
        if (typeof option === "function") option(notification);
        else this._notificationPopups.show(notification);
      }
    });
  }

  /** @returns {Capture[]} the running captures, oldest first */
  captures() {
    return [...this.captureList.values()].sort((a, b) => a.startTime - b.startTime);
  }

  async _captureCommand(command, args = {}) {
    if (!this.captureAvailable) throw new Error("this Chromium has no capture API");
    return JSON.parse(await this.broker.captureCommand(command, JSON.stringify(args)));
  }

  /**
   * What can be captured: { outputs: [{ id, name, width, height, scaleFactor, primary }],
   * windows: [{ id, title, appId, width, height, tags }], tabs: [{ id, title, url, tags }] }.
   */
  captureSources() {
    return this._captureCommand("sources");
  }

  /**
   * The output this page is on, as a source ({ type: "output", id }). EXO-MULTIMON: with a
   * shell per display, this page's display.
   */
  async outputSource() {
    const { outputs } = await this.captureSources();
    const output = outputs.find((entry) => entry.primary) ?? outputs[0];
    if (!output) throw new Error("no output to capture");
    return { type: "output", id: output.id };
  }

  /**
   * A PNG of `source` ({ type: "output" | "window" | "tab", id }), cropped to `region`
   * ({ x, y, width, height } in the source's pixels). Rejects while screenshots are switched
   * off.
   * @returns {Promise<Blob>}
   */
  screenshot(source, { region } = {}) {
    if (!this.captureAvailable) return Promise.reject(new Error("this Chromium has no capture API"));
    return this.broker.screenshot(JSON.stringify(region ? { ...source, region } : source));
  }

  /** Saves a PNG into ~/Pictures/Screenshots (through the helper). Resolves to its path. */
  async saveScreenshot(blob) {
    const response = await fetch(`${HELPER}/v1/screenshots`, { method: "POST", headers: { "Content-Type": "image/png" }, body: blob });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `the helper refused the screenshot (${response.status})`);
    return body.path;
  }

  /**
   * A live MediaStream of `source`, with no picker (a shell may capture anything): for
   * MediaRecorder, live thumbnails in a <video>, or a region screenshot's preview. `region`
   * crops it ({ x, y, width, height }, the source's pixels); `size` ({ width, height }, DIPs)
   * holds a window at that size while the stream runs, letterboxed if the app picks another;
   * `frameRate` caps it. Every shell sees it as a capture; stopping its track ends it.
   * Rejects while recording is switched off.
   * @returns {Promise<MediaStream & { captureId: number }>}
   */
  async capture(source, { region = source.region, size, cursor, frameRate } = {}) {
    const { region: _, ...whole } = source;
    const { streamId, captureId } = await this._captureCommand("stream", { source: whole, size, cursor });
    /** @type {Record<string, any>} */
    const mandatory = { chromeMediaSource: "desktop", chromeMediaSourceId: streamId };
    if (size && source.type === "window") {
      const scale = this.windows.get(source.id)?.deviceScaleFactor ?? 1;
      const width = Math.round(size.width * scale);
      const height = Math.round(size.height * scale);
      Object.assign(mandatory, { minWidth: width, maxWidth: width, minHeight: height, maxHeight: height });
    } else {
      // The source's own size (the default caps it at 640x480).
      Object.assign(mandatory, { maxWidth: 8192, maxHeight: 8192 });
    }
    if (frameRate) mandatory.maxFrameRate = frameRate;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory } });
    const result = region ? new MediaStream([cropTrack(stream.getVideoTracks()[0], region)]) : stream;
    return Object.assign(result, { captureId });
  }

  /** Stops capture `id`, whoever started it. */
  stopCapture(id) {
    return this._captureCommand("stop", { id });
  }

  /** Holds capture `id`'s window at `size` ({ width, height }, DIPs), or lets it go (null). */
  setCaptureSize(id, size) {
    return this._captureCommand("setSize", { id, ...(size ?? {}) });
  }

  /** Says this page shows that capture `id` runs (else Ash shows its own indicator). */
  acknowledgeCapture(id) {
    return this._captureCommand("acknowledge", { id });
  }

  /**
   * Answers capture request `requestId`, which this page took: { sources: [source, ...],
   * size?, cursor?, persist? }, or null to refuse. Resolves to false if it is over, or the
   * answer doesn't fit the request.
   */
  async answerCapture(requestId, answer) {
    const ok = await this._captureCommand("answer", { requestId, answer: answer ?? null }).catch(() => false);
    if (ok) this._captureRequests.delete(requestId);
    return ok;
  }

  /** Turns the global switches on or off: { recording?, screenshots? }. */
  async setCaptureSettings(settings) {
    this.captureSettings = await this._captureCommand("setSettings", settings);
    return this.captureSettings;
  }

  /**
   * The screenshot UI (Print): freezes this page's output, then lets the user drag out a
   * region, click one of `targets` (CSS-pixel rects on this page, such as the windows it
   * shows: [{ source, rect }]), or press Enter or Space for the whole output. Escape
   * cancels. Resolves to { blob, source } (null if cancelled); `save` (default true) also
   * writes it to ~/Pictures/Screenshots, as `path`.
   */
  async takeScreenshot({ targets = [], save = true } = {}) {
    // One at a time: Print again while choosing does nothing.
    if (this._choosingArea) return null;
    this._choosingArea = true;
    // The keys (Escape, Enter) are the selector's while it's open.
    const giveBack = this._takeKeyboard();
    try {
      return await this._takeScreenshot(targets, save);
    } finally {
      this._choosingArea = false;
      giveBack();
    }
  }

  /**
   * The color picker (the desktop portal's PickColor): freezes this page's output, then
   * the user clicks a pixel. Resolves to [r, g, b] (0 to 255), or null on Escape.
   */
  async pickColor() {
    if (this._choosingArea) return null;
    this._choosingArea = true;
    const giveBack = this._takeKeyboard();
    try {
      const frozen = await this.screenshot(await this.outputSource());
      return await new ColorPicker(frozen).choose();
    } finally {
      this._choosingArea = false;
      giveBack();
    }
  }

  // An app window that has the keyboard gives it up (to this page's own UI);
  // the returned function gives it back.
  _takeKeyboard() {
    const blurred = [];
    for (const element of document.querySelectorAll("native-window")) {
      const id = Number(element.getAttribute("window"));
      if (element.windowFocused || this.windows.get(id)?.focused) {
        element.blurWindow();
        blurred.push(element);
      }
    }
    return () => {
      for (const element of blurred) if (element.isConnected) element.focusWindow();
    };
  }

  async _takeScreenshot(targets, save) {
    const output = await this.outputSource();
    const frozen = await this.screenshot(output);
    const choice = await new AreaSelector(frozen, targets).choose();
    if (!choice) return null;
    let blob;
    let source;
    if (choice.target) {
      source = choice.target.source;
      blob = await this.screenshot(source);
    } else {
      source = choice.region ? { ...output, region: choice.region } : output;
      blob = choice.region ? await cropPng(frozen, choice.region) : frozen;
    }
    const path = save ? await this.saveScreenshot(blob) : undefined;
    this.dispatchEvent(new CustomEvent("screenshot", { detail: { blob, source, path } }));
    return { blob, source, path };
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
    const display = encodeURIComponent(this.display?.id ?? "");
    const events = new EventSource(
      `${HELPER}/v1/shell/requests?page=${page}&shell=${shell}&visible=${visible()}&display=${display}`,
    );
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
        if (op === "system") this.system._changed(args.service, args.state);
        // A hardware key (volume, brightness, media) the helper acted on: for an on-screen level.
        if (op === "systemkey") {
          this.system._changed(args.service, args.state);
          this.dispatchEvent(new CustomEvent("systemkey", { detail: args }));
        }
        // An installed shell's change was rolled back, its page crashed or its server failed
        // ({ shell, title, kind, message }); the notifications service has it too.
        if (op === "shellnotice") this.dispatchEvent(new CustomEvent("shellnotice", { detail: args }));
        if (op === "native") this.native.dispatchEvent(new CustomEvent(args.event, { detail: args.detail }));
        if (op === "global_shortcuts") {
          this.globalShortcuts = args.shortcuts ?? [];
          this._applyShortcuts();
          return;
        }
        if (op === "file_chooser_cancel" || op === "print_cancel" || op === "system_request_cancel") {
          this._appRequests?.get(args.handle)?.abort();
        }
        if (op === "agent_windows") {
          this.agentWindows = new Map((args.windows ?? []).map((window) => [window.id, window]));
          this.dispatchEvent(new Event("agentwindowschange"));
        }
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
      case "displays":
        // With the shell each shows.
        return this.displays.map(({ id, index, label, width, height, scaleFactor, primary, focused }) => ({
          index,
          id,
          label,
          width,
          height,
          scaleFactor,
          primary,
          focused,
          shell: this.shells.find((shell) => shell.visibleOn.includes(id))?.name ?? "",
        }));
      case "focus": {
        if (args.display !== undefined) {
          // Another display's visible shell shows it (the browser asks it).
          const display = this.displayOf(args.display);
          if (!display) throw new Error(`there is no display ${args.display}`);
          if (await this.showOnDisplay(args.windowId, display.id)) {
            return { how: `shown on display ${display.index}` };
          }
          throw new Error(`display ${display.index}'s shell doesn't take requests`);
        }
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
        return { result: await this.tabCommand(args.tabId, args.command, args.args) };
      case "answer_dialog":
        this.answerTabDialog(args.tabId, args.accept, args.text ?? "");
        return {};
      // A frontend archived or deleted the thread (the helper's
      // POST /v1/threads/<thread>/permissions/forget). Null: no thread grants here.
      case "forget_thread_permissions":
        return this.forgetThreadPermissions(args.thread);
      case "groups":
        if (!this.tagsAvailable) throw new Error("this Chromium has no groups");
        return (await this.broker.getGroups()).map(plainGroup);
      case "snapshot_tab":
        return this.snapshotTab(args.tabId);
      case "bind_shortcuts": {
        // An app binds global shortcuts: this page asks the user (the
        // "shortcutBinder" option: false leaves it to the helper, which takes
        // the app's own keys).
        const option = this.options.shortcutBinder;
        if (option === false) throw new Error("this shell doesn't bind shortcuts");
        if (typeof option === "function") return option(args);
        return new ShortcutBinder(this, args).ask();
      }
      case "file_chooser": {
        // A native app's file picker (the FileChooser portal): the same picker as tabs'
        // (the "fileChooser" option: false leaves the app without one).
        const option = this.options.fileChooser;
        if (option === false) throw new Error("this shell doesn't pick files");
        return this._appFileChooser(args, option);
      }
      case "system_request": {
        // A desktop service needs the user (DESKTOP_SERVICES.md, "Asking the user"): a
        // Wi-Fi password, a Bluetooth PIN. A cancelable "systemrequest" event first (its
        // detail is the request: preventDefault() and answer it yourself), else the
        // library's prompt. The "systemRequest" option: a function draws them instead;
        // false leaves the services without them.
        const option = this.options.systemRequest;
        if (option === false) throw new Error("this shell doesn't answer system requests");
        return this._appDialog({ ...args, source: { service: args.service } }, args.kind, option, (request) => {
          const event = new CustomEvent("systemrequest", { detail: request, cancelable: true });
          if (this.dispatchEvent(event)) new SystemPrompt(this, request);
          return true;
        });
      }
      case "print_prepare": {
        // A native app prints (the Print portal): the same dialog as tabs', without a
        // preview (the "print" option: false leaves the app without one).
        const option = this.options.print;
        if (option === false) throw new Error("this shell doesn't print");
        return this._appDialog(args, "print", option, (request) => (new PrintDialog(this, request), true));
      }
      case "pick_color": {
        // An app asks for a color from the screen (the "colorPicker" option:
        // false leaves the helper without one).
        const option = this.options.colorPicker;
        if (option === false) throw new Error("this shell doesn't pick colors");
        const color = typeof option === "function" ? await option(args) : await this.pickColor();
        return { color };
      }
      case "focus_tab": {
        if (args.display !== undefined) {
          const display = this.displayOf(args.display);
          if (!display) throw new Error(`there is no display ${args.display}`);
          if (await this.showTabOnDisplay(args.tabId, display.id)) {
            return { how: `shown on display ${display.index}` };
          }
          throw new Error(`display ${display.index}'s shell doesn't take requests`);
        }
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

// The context menu's look. Pages set the custom properties (or style the
// classes: these rules are in a layer, so the page's win).
const MENU_STYLE = `@layer plutonium {
  .plutonium-menu {
    position: fixed; inset: auto; margin: 0; box-sizing: border-box;
    min-width: 200px; max-width: min(380px, calc(100vw - 8px)); max-height: calc(100vh - 8px); overflow-y: auto;
    padding: var(--plutonium-menu-padding, 4px);
    background: var(--plutonium-menu-bg, Canvas); color: var(--plutonium-menu-fg, CanvasText);
    border: var(--plutonium-menu-border, 1px solid color-mix(in srgb, currentColor 18%, transparent));
    border-radius: var(--plutonium-menu-radius, 8px);
    box-shadow: var(--plutonium-menu-shadow, 0 8px 28px #0006);
    backdrop-filter: var(--plutonium-menu-backdrop, none);
    font: var(--plutonium-menu-font, 13px/1.3 system-ui, sans-serif);
    user-select: none; outline: none; cursor: default;
  }
  .plutonium-menu-item {
    display: flex; align-items: center; gap: 8px; white-space: nowrap;
    padding: var(--plutonium-menu-item-padding, 6px 10px); border-radius: var(--plutonium-menu-item-radius, 5px);
  }
  .plutonium-menu-item > .check { flex: none; width: 1em; text-align: center; }
  .plutonium-menu-item > .label { flex: 1; overflow: hidden; text-overflow: ellipsis; }
  .plutonium-menu-item > .more { flex: none; opacity: .6; }
  .plutonium-menu-item.active { background: var(--plutonium-menu-hover-bg, Highlight); color: var(--plutonium-menu-hover-fg, HighlightText); }
  .plutonium-menu-item[aria-disabled="true"] { opacity: .45; }
  .plutonium-menu-title { padding: 4px 10px; font-size: .85em; opacity: .65; }
  .plutonium-menu-separator {
    height: 1px; margin: 4px 6px;
    background: var(--plutonium-menu-separator, color-mix(in srgb, currentColor 15%, transparent));
  }
}`;

let menuStyle = null;

// Tab features' dialogs, toasts and bars. Pages set the custom properties
// (or style the classes; these rules are in the same layer as the menu's).
const DIALOG_STYLE = `@layer plutonium {
  .plutonium-dialog, .plutonium-toast {
    position: fixed; inset: auto; margin: 0; box-sizing: border-box;
    background: var(--plutonium-dialog-bg, var(--plutonium-menu-bg, Canvas));
    color: var(--plutonium-dialog-fg, var(--plutonium-menu-fg, CanvasText));
    border: var(--plutonium-dialog-border, var(--plutonium-menu-border, 1px solid color-mix(in srgb, currentColor 18%, transparent)));
    border-radius: var(--plutonium-dialog-radius, var(--plutonium-menu-radius, 8px));
    box-shadow: var(--plutonium-dialog-shadow, var(--plutonium-menu-shadow, 0 8px 28px #0006));
    font: var(--plutonium-dialog-font, var(--plutonium-menu-font, 13px/1.3 system-ui, sans-serif));
  }
  .plutonium-dialog { padding: 12px 14px; max-width: min(420px, calc(100vw - 16px)); }
  .plutonium-dialog button.default { background: var(--plutonium-dialog-accent, AccentColor); color: AccentColorText; }
  .plutonium-toast { padding: 6px 12px; pointer-events: none; user-select: none; font-variant-numeric: tabular-nums; }
}`;

let dialogStyle = null;

/** Adds DIALOG_STYLE to the document, once. */
export function ensureDialogStyle() {
  if (dialogStyle) return;
  dialogStyle = document.createElement("style");
  dialogStyle.textContent = DIALOG_STYLE;
  document.head.append(dialogStyle);
}

// Find in page (TAB_FEATURES.md): the library's find bar, a popover at the
// top right of the tab's element. It is the "find" tab request ("findBar"
// in connect()): it stays open while the bar does, and is answered with
// {action} as the bar closes. The count comes from the tab's `find` state.
const FIND_STYLE = `@layer plutonium {
  .plutonium-find-bar { display: flex; align-items: center; gap: 4px; padding: 6px 6px 6px 10px; }
  .plutonium-find-bar input {
    width: 16em; min-width: 0; border: none; outline: none; background: transparent;
    color: inherit; font: inherit;
  }
  .plutonium-find-bar .count { min-width: 4em; text-align: end; opacity: 0.7; font-variant-numeric: tabular-nums; }
  .plutonium-find-bar .count.none { color: var(--plutonium-find-none, #d33); opacity: 1; }
  .plutonium-find-bar button {
    border: none; border-radius: 4px; background: transparent; color: inherit; font: inherit;
    min-width: 24px; height: 24px; padding: 0 4px; cursor: default;
  }
  .plutonium-find-bar button:hover { background: color-mix(in srgb, currentColor 12%, transparent); }
  .plutonium-find-bar button[aria-pressed="true"] {
    background: var(--plutonium-dialog-accent, AccentColor); color: AccentColorText;
  }
}`;

let findStyle = null;

/** The library's find bar for `request` (a "find" tab request); false if the page doesn't show the tab. */
function drawFindBar(shell, request) {
  const { tabId, detail } = request;
  if (!shell.shownTabElement(tabId)) return false;
  ensureDialogStyle();
  if (!findStyle) {
    findStyle = document.createElement("style");
    findStyle.textContent = FIND_STYLE;
    document.head.append(findStyle);
  }
  shell._findBars ??= new Map();
  shell._findBars.get(tabId)?.dispose();

  const bar = document.createElement("div");
  bar.className = "plutonium-dialog plutonium-find-bar";
  bar.popover = "manual";
  bar.setAttribute("role", "search");
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Find in page";
  input.setAttribute("aria-label", "Find in page");
  input.value = detail?.initialText ?? "";
  const count = document.createElement("span");
  count.className = "count";
  count.setAttribute("aria-live", "polite");
  const button = (text, title, onClick) => {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = text;
    element.title = title;
    element.setAttribute("aria-label", title);
    // Keep the focus in the field.
    element.addEventListener("mousedown", (event) => event.preventDefault());
    element.addEventListener("click", onClick);
    return element;
  };
  let matchCase = !!detail?.matchCase;
  const caseButton = button("Aa", "Match case", () => {
    matchCase = !matchCase;
    caseButton.setAttribute("aria-pressed", String(matchCase));
    search({ select: true });
  });
  caseButton.setAttribute("aria-pressed", String(matchCase));
  const previous = button("↑", "Previous match (Shift+Enter)", () => search({ forward: false }));
  const next = button("↓", "Next match (Enter)", () => search({ forward: true }));
  const close = button("×", "Close (Escape)", () => end("keep"));
  bar.append(input, count, caseButton, previous, next, close);
  document.body.append(bar);

  const showCount = (result) => {
    if (!input.value) {
      count.textContent = "";
      count.classList.remove("none");
      return;
    }
    if (!result || result.text !== input.value) return;
    count.textContent = `${result.activeMatch}/${result.matches}`;
    count.classList.toggle("none", result.final && result.matches === 0);
  };
  const search = ({ forward = true, select = true, scroll = true } = {}) => {
    const text = input.value;
    if (!text) showCount(null);
    shell.find(tabId, text, { forward, matchCase, select, scroll }).then(showCount, () => {});
  };
  const onResult = (event) => {
    if (event.detail.tabId === tabId) showCount(event.detail);
  };
  shell.addEventListener("findresult", onResult);

  // Follows the tab's element; hidden while this page doesn't show the tab.
  let frame = 0;
  const place = () => {
    frame = requestAnimationFrame(place);
    const element = shell.shownTabElement(tabId);
    const box = element?.getBoundingClientRect();
    if (!box || box.width === 0) {
      bar.style.visibility = "hidden";
      return;
    }
    bar.style.visibility = "";
    bar.style.left = `${Math.max(box.left + 8, box.right - bar.offsetWidth - 12)}px`;
    bar.style.top = `${box.top + 8}px`;
  };

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    shell.removeEventListener("findresult", onResult);
    bar.remove();
    if (shell._findBars.get(tabId)?.dispose === dispose) shell._findBars.delete(tabId);
  };
  // The bar closes: the search stops (`action`), and the tab gets the keys back.
  const end = (action) => {
    const hadFocus = bar.contains(document.activeElement);
    dispose();
    request.answer({ action });
    if (hadFocus) shell.shownTabElement(tabId)?.focus();
  };
  request.signal.addEventListener("abort", dispose);
  shell._findBars.set(tabId, { dispose });

  input.addEventListener("input", () => search());
  input.addEventListener("keydown", (event) => {
    const key = event.key;
    const ctrl = event.ctrlKey || event.metaKey;
    if (key === "Escape") end("keep");
    else if (key === "Enter" && ctrl) end("activate");
    else if (key === "Enter" || key === "F3" || (ctrl && key.toLowerCase() === "g")) {
      search({ forward: !event.shiftKey });
    } else if (ctrl && key.toLowerCase() === "f") input.select();
    else return;
    event.preventDefault();
    event.stopPropagation();
  });

  bar.showPopover();
  place();
  input.focus();
  input.select();
  // As Chrome's bar: the text it opens with is counted and highlighted, and the
  // selection (already on screen) is the active match, without scrolling.
  if (input.value) search({ select: !!detail?.fromSelection, scroll: false });
  showCount(request.tab?.find);
  return true;
}

registerTabRequestKind("find", { option: "findBar", draw: drawFindBar });

// EXO-TAB-FEATURES: printing (TAB_FEATURES.md, "Printing"). Ctrl+P,
// tabCommand(id, "print") and a page's window.print() come as a "print" tab
// request ({title, url, thread, hasSelection, scripted, pdf}). The library's
// dialog previews the tab as a PDF ("print-to-pdf"), and prints it on one of
// the host's printers or saves it, through the helper; then it answers
// "done" (or "cancel"), and the page's window.print() returns.
// connect({ print: false }) leaves it to Chrome's preview; print: (request) =>
// true draws it yourself, with the methods below.

/** Paper sizes by name, in inches (as the "print-to-pdf" command takes them). */
export const PAPER_SIZES = {
  letter: [8.5, 11],
  legal: [8.5, 14],
  tabloid: [11, 17],
  a3: [11.69, 16.54],
  a4: [8.27, 11.69],
  a5: [5.83, 8.27],
};
const PRINT_MARGINS = { default: undefined, none: 0, minimum: 0.25 };

/**
 * @typedef {{ paper?: keyof PAPER_SIZES, landscape?: boolean, scale?: number,
 *   margins?: "default" | "none" | "minimum", background?: boolean, headerFooter?: boolean,
 *   pageRanges?: string }} PdfOptions
 *   scale: 1 is 100% (0.1 to 2); pageRanges: "1-3, 5", all if left out.
 * @typedef {{ name: string, description: string, state: string, isDefault: boolean }} Printer
 */

/**
 * Tab `tabId` as a PDF, laid out for printing with `options`. While the tab waits on a
 * print request, this is the frame that asked (window.print() in a frame).
 * @param {number} tabId
 * @param {PdfOptions} options
 * @returns {Promise<Blob>}
 */
PlutoniumShell.prototype.printToPdf = async function (tabId, options = {}) {
  const args = {};
  if (options.paper) {
    const size = PAPER_SIZES[options.paper];
    if (!size) throw new Error(`unknown paper ${options.paper}`);
    [args.paperWidth, args.paperHeight] = size;
  }
  if (options.landscape !== undefined) args.landscape = options.landscape;
  if (options.scale !== undefined) args.scale = options.scale;
  const margin = PRINT_MARGINS[options.margins ?? "default"];
  if (margin !== undefined) args.marginTop = args.marginBottom = args.marginLeft = args.marginRight = margin;
  if (options.background !== undefined) args.printBackground = options.background;
  if (options.headerFooter !== undefined) args.displayHeaderFooter = options.headerFooter;
  if (options.pageRanges) args.pageRanges = options.pageRanges;
  const result = await this.tabCommand(tabId, "print-to-pdf", args);
  if (typeof result?.data !== "string") throw new Error("this browser can't print tabs to PDF");
  const bytes = Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: "application/pdf" });
};

/**
 * The host's printers (CUPS, through the helper). `available` is false without a CUPS
 * client or server; `defaultPdfPath` is where "Save as PDF" puts a page called `title`.
 * @returns {Promise<{ available: boolean, printers: Printer[], error?: string, defaultPdfPath: string }>}
 */
PlutoniumShell.prototype.printers = async function (title = "") {
  const response = await fetch(`${HELPER}/v1/printers?title=${encodeURIComponent(title)}`);
  if (!response.ok) throw new Error(await errorOf(response));
  return response.json();
};

/**
 * Prints `pdf` on the host's printer `printer` (its default one if left out).
 * @param {Blob} pdf
 * @param {{ printer?: string, copies?: number, duplex?: "none" | "long-edge" | "short-edge",
 *   color?: boolean, title?: string }} options
 * @returns {Promise<{ job: string }>}
 */
PlutoniumShell.prototype.printPdf = async function (pdf, options = {}) {
  const query = new URLSearchParams();
  if (options.printer) query.set("printer", options.printer);
  if (options.copies !== undefined) query.set("copies", String(options.copies));
  if (options.duplex) query.set("duplex", options.duplex);
  if (options.color !== undefined) query.set("color", options.color ? "1" : "0");
  if (options.title) query.set("title", options.title);
  const response = await fetch(`${HELPER}/v1/print?${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/pdf" },
    body: pdf,
  });
  if (!response.ok) throw new Error(await errorOf(response));
  return response.json();
};

/**
 * Saves `pdf` on the host: at `path` (absolute or "~/..."), else in ~/Downloads, named
 * after `title`. An existing file isn't overwritten unless `overwrite` (the dialog's
 * file picker asked): the name gets " (1)", " (2)", ...
 * @param {Blob} pdf
 * @returns {Promise<{ path: string }>}
 */
PlutoniumShell.prototype.savePdf = async function (pdf, { path = "", title = "", overwrite = false } = {}) {
  const query = new URLSearchParams();
  if (path) query.set("path", path);
  if (title) query.set("title", title);
  if (overwrite) query.set("overwrite", "1");
  const response = await fetch(`${HELPER}/v1/print/save?${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/pdf" },
    body: pdf,
  });
  if (!response.ok) throw new Error(await errorOf(response));
  return response.json();
};

async function errorOf(response) {
  try {
    return (await response.json()).error ?? `${response.status}`;
  } catch {
    return `${response.status}`;
  }
}

const PRINT_STYLE = `@layer plutonium {
  .plutonium-dialog.plutonium-print {
    max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); padding: 0;
    display: grid; grid-template-columns: minmax(0, 1fr) 260px; width: min(900px, calc(100vw - 16px));
    height: min(640px, calc(100vh - 16px)); overflow: hidden;
  }
  .plutonium-dialog.plutonium-print.app { grid-template-columns: minmax(0, 1fr); width: min(340px, calc(100vw - 16px)); height: auto; }
  .plutonium-print.app .preview { display: none; }
  .plutonium-print .preview { background: color-mix(in srgb, currentColor 12%, transparent); position: relative; }
  .plutonium-print .preview iframe { border: 0; width: 100%; height: 100%; display: block; }
  .plutonium-print .preview .note { position: absolute; inset: 0; display: grid; place-items: center; opacity: .7; }
  .plutonium-print form { display: flex; flex-direction: column; gap: 8px; padding: 14px; overflow: auto; }
  .plutonium-print h2 { font-size: 1.15em; margin: 0 0 2px; }
  .plutonium-print .pages { opacity: .7; min-height: 1.3em; }
  .plutonium-print label.field { display: grid; grid-template-columns: 90px minmax(0, 1fr); align-items: center; gap: 6px; }
  .plutonium-print label.check { display: flex; align-items: center; gap: 6px; }
  .plutonium-print input, .plutonium-print select, .plutonium-print button { font: inherit; min-width: 0; }
  .plutonium-print [hidden] { display: none !important; }
  .plutonium-print .error { color: var(--plutonium-dialog-error, #d33); }
  .plutonium-print .buttons { margin-top: auto; display: flex; justify-content: flex-end; gap: 8px; padding-top: 8px; }
}`;

let printStyle = null;

// The library's print dialog for one request.
class PrintDialog {
  /** @param {PlutoniumShell} shell @param {TabRequest} request */
  constructor(shell, request) {
    ensureDialogStyle();
    if (!printStyle) {
      printStyle = document.createElement("style");
      printStyle.textContent = PRINT_STYLE;
      document.head.append(printStyle);
    }
    this.shell = shell;
    this.request = request;
    this.title = request.detail?.title || request.tab?.title || "";
    this.closed = false;
    this.pdf = null;
    this.pdfKey = "";
    this.url = "";
    this.rendering = null;
    this.opener = document.activeElement;
    /** An app's (the Print portal): no preview; the answer is the settings, which the app prints with. */
    this.app = request.tabId === undefined;
    this._build();
    request.signal.addEventListener("abort", () => this.close());
    this._loadPrinters();
    if (!this.app) this._render();
  }

  _build() {
    const us = /^(en-(US|CA|PH)|es-(MX|US)|fr-CA)\b/.test(navigator.language);
    const element = document.createElement("div");
    element.className = "plutonium-dialog plutonium-print";
    element.popover = "manual";
    element.setAttribute("role", "dialog");
    element.setAttribute("aria-label", "Print");
    element.innerHTML = `
      <div class="preview"><iframe title="Preview"></iframe><div class="note">Preparing preview…</div></div>
      <form>
        <h2>Print</h2>
        <div class="pages"></div>
        <label class="field">Destination <select name="destination"><option value="">Save as PDF</option></select></label>
        <label class="field">Pages <select name="pages"><option value="all">All</option><option value="custom">Custom</option></select></label>
        <label class="field" hidden data-for="custom">Ranges <input name="ranges" placeholder="1-3, 5" spellcheck="false"></label>
        <label class="field" data-for="printer">Copies <input name="copies" type="number" min="1" max="999" value="1"></label>
        <label class="field">Layout <select name="layout"><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label>
        <label class="field">Paper <select name="paper">${Object.keys(PAPER_SIZES)
          .map((name) => `<option value="${name}">${name[0].toUpperCase()}${name.slice(1)}</option>`)
          .join("")}</select></label>
        <label class="field">Margins <select name="margins"><option value="default">Default</option><option value="minimum">Minimum</option><option value="none">None</option></select></label>
        <label class="field">Scale <input name="scale" type="number" min="10" max="200" value="100"></label>
        <label class="field" data-for="printer">Two-sided <select name="duplex"><option value="none">Off</option><option value="long-edge">Long edge</option><option value="short-edge">Short edge</option></select></label>
        <label class="field" data-for="printer">Colour <select name="color"><option value="1">Colour</option><option value="0">Black and white</option></select></label>
        <label class="check"><input name="headerFooter" type="checkbox"> Headers and footers</label>
        <label class="check"><input name="background" type="checkbox"> Background graphics</label>
        <div class="status" role="status"></div>
        <div class="buttons"><button type="button" name="cancel">Cancel</button><button type="submit" class="default" name="go">Save</button></div>
      </form>`;
    this.element = element;
    this.form = element.querySelector("form");
    this.iframe = element.querySelector("iframe");
    this.note = element.querySelector(".note");
    this.status = element.querySelector(".status");
    this.form.paper.value = us ? "letter" : "a4";
    this.defaultPdfPath = `~/Downloads/${fileNameOf(this.title)}`;
    if (this.app) {
      // The app lays out its pages: only what it asks of the printer, and its paper.
      element.classList.add("app");
      for (const name of ["scale", "margins", "headerFooter", "background"]) this.form[name].closest("label").hidden = true;
      element.querySelector(".pages").textContent = this.request.source?.name ?? "";
      const detail = this.request.detail ?? {};
      if (detail.copies) this.form.copies.value = String(detail.copies);
      if (detail.landscape !== undefined) this.form.layout.value = detail.landscape ? "landscape" : "portrait";
      if (detail.paper && PAPER_SIZES[detail.paper]) this.form.paper.value = detail.paper;
    }
    this.form.addEventListener("input", (event) => this._changed(event.target));
    this.form.addEventListener("change", (event) => this._changed(event.target));
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      this._go();
    });
    this.form.cancel.addEventListener("click", () => this.cancel());
    element.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.cancel();
      }
    });
    document.body.append(element);
    element.showPopover();
    this._place();
    this._onResize = () => this._place();
    window.addEventListener("resize", this._onResize);
    this._showDestination();
    this.form.destination.focus({ preventScroll: true });
  }

  // Over the tab's element if this page shows it, else in the middle.
  _place() {
    const box = (
      this.shell.shownTabElement(this.request.tabId) ?? this.shell.shownWindowElement(this.request.source?.windowId)
    )?.getBoundingClientRect();
    const width = this.element.offsetWidth;
    const height = this.element.offsetHeight;
    const centreX = box && box.width ? box.left + box.width / 2 : innerWidth / 2;
    const centreY = box && box.height ? box.top + box.height / 2 : innerHeight / 2;
    this.element.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, centreX - width / 2))}px`;
    this.element.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, centreY - height / 2))}px`;
  }

  async _loadPrinters() {
    try {
      const { available, printers, error, defaultPdfPath } = await this.shell.printers(this.title);
      if (this.closed) return;
      if (defaultPdfPath) this.defaultPdfPath = defaultPdfPath;
      const select = this.form.destination;
      for (const printer of printers) {
        const option = document.createElement("option");
        option.value = printer.name;
        option.textContent = printer.description || printer.name;
        if (printer.state === "disabled") option.disabled = true;
        select.append(option);
      }
      const asked = this.app && printers.find((printer) => printer.name === this.request.detail?.printer);
      const preferred = asked || printers.find((printer) => printer.isDefault && printer.state !== "disabled");
      if (preferred) select.value = preferred.name;
      if (!available && error) console.info(`plutonium: no printers (${error})`);
      this._showDestination();
    } catch (error) {
      console.warn("plutonium: listing printers", error);
    }
  }

  _changed(target) {
    if (target === this.form.destination) return this._showDestination();
    if (target === this.form.pages) {
      this.form.querySelector('[data-for="custom"]').hidden = this.form.pages.value !== "custom";
    }
    if (["copies", "duplex", "color"].includes(target.name) || this.app) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._render(), 300);
  }

  _showDestination() {
    const printing = !!this.form.destination.value;
    for (const field of this.form.querySelectorAll('[data-for="printer"]')) field.hidden = !printing;
    this.form.go.textContent = printing ? "Print" : "Save…";
  }

  /** @returns {PdfOptions} */
  _pdfOptions() {
    const form = this.form;
    const scale = Number(form.scale.value);
    return {
      paper: form.paper.value,
      landscape: form.layout.value === "landscape",
      scale: Number.isFinite(scale) && scale > 0 ? Math.min(2, Math.max(0.1, scale / 100)) : 1,
      margins: form.margins.value,
      background: form.background.checked,
      headerFooter: form.headerFooter.checked,
      pageRanges: form.pages.value === "custom" ? form.ranges.value.trim() : "",
    };
  }

  // The PDF for the current settings (made once per settings).
  async _pdfNow() {
    const options = this._pdfOptions();
    const key = JSON.stringify(options);
    if (this.pdf && this.pdfKey === key) return this.pdf;
    if (this.rendering?.key === key) return this.rendering.promise;
    const promise = this.shell.printToPdf(this.request.tabId, options);
    this.rendering = { key, promise };
    try {
      const pdf = await promise;
      if (this.rendering?.key === key) {
        this.pdf = pdf;
        this.pdfKey = key;
      }
      return pdf;
    } finally {
      if (this.rendering?.key === key) this.rendering = null;
    }
  }

  async _render() {
    try {
      const pdf = await this._pdfNow();
      if (this.closed || pdf !== this.pdf) return;
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = URL.createObjectURL(pdf);
      this.iframe.src = `${this.url}#toolbar=0&navpanes=0`;
      this.note.hidden = true;
      const pages = countPdfPages(new Uint8Array(await pdf.arrayBuffer()));
      if (!this.closed) {
        this.element.querySelector(".pages").textContent = pages ? `${pages} page${pages === 1 ? "" : "s"}` : "";
      }
      this._error("");
    } catch (error) {
      if (this.closed) return;
      this.note.hidden = false;
      this.note.textContent = "No preview";
      this._error(this.form.pages.value === "custom" ? "Check the page ranges." : error.message);
    }
  }

  _error(text) {
    this.status.textContent = text;
    this.status.className = text ? "status error" : "status";
  }

  async _go() {
    if (this.busy) return;
    this.busy = true;
    this.form.go.disabled = true;
    const printer = this.form.destination.value;
    this._error("");
    // Save as PDF: where, from the file picker first.
    const path = printer ? "" : await this._choosePdfPath();
    if (this.closed) return;
    if (!printer && !path) {
      this.busy = false;
      this.form.go.disabled = false;
      this.form.go.focus({ preventScroll: true });
      return;
    }
    this.status.textContent = printer ? "Printing…" : "Saving…";
    if (this.app) return this._answerApp(printer, path);
    try {
      const pdf = await this._pdfNow();
      let message;
      if (printer) {
        const copies = Math.floor(Number(this.form.copies.value));
        await this.shell.printPdf(pdf, {
          printer,
          copies: copies >= 1 ? copies : 1,
          duplex: this.form.duplex.value,
          color: this.form.color.value === "1",
          title: this.title,
        });
        message = `Sent to ${this.form.destination.selectedOptions[0]?.textContent ?? printer}`;
      } else {
        // The picker asked before replacing a file.
        const saved = await this.shell.savePdf(pdf, { path, title: this.title, overwrite: true });
        message = `Saved ${saved.path}`;
      }
      const tabId = this.request.tabId;
      await this.request.answer("done");
      this.close();
      this.shell.showTabToast(tabId, message, { duration: 3000 });
    } catch (error) {
      if (this.closed) return;
      this._error(error.message);
      this.busy = false;
      this.form.go.disabled = false;
    }
  }

  // An app's dialog answers the settings; the app then sends the document, which the
  // helper prints or saves.
  async _answerApp(printer, path) {
    const form = this.form;
    const ranges = form.pages.value === "custom" ? form.ranges.value.trim() : "";
    if (ranges && !/^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*$/.test(ranges)) {
      this._error("Check the page ranges.");
      this.busy = false;
      form.go.disabled = false;
      return;
    }
    const copies = Math.floor(Number(form.copies.value));
    await this.request.answer({
      printer,
      path: printer ? undefined : path,
      copies: copies >= 1 ? copies : 1,
      duplex: form.duplex.value,
      color: form.color.value === "1",
      paper: form.paper.value,
      landscape: form.layout.value === "landscape",
      pageRanges: ranges,
    });
    this.close();
  }

  // Save as PDF's file: the library's file picker in save mode, over the tab (or app)
  // as this dialog is, starting where the last PDF went (else ~/Downloads) with the
  // page's title. Resolves to the path, or "" if cancelled.
  _choosePdfPath() {
    const fallback = this.defaultPdfPath;
    const slash = fallback.lastIndexOf("/");
    return new Promise((resolve) => {
      const controller = new AbortController();
      const picker = new FileChooser(this.shell, {
        kind: "fileChooser",
        tabId: this.request.tabId,
        tab: this.request.tab,
        source: this.request.source,
        detail: {
          mode: "save",
          title: "Save as PDF",
          origin: this.title,
          currentName: fallback.slice(slash + 1),
          currentFolder: this.shell._lastPdfFolder || fallback.slice(0, slash),
          filters: [{ name: "PDF", patterns: ["*.pdf"], mimeTypes: ["application/pdf"] }],
        },
        signal: controller.signal,
        answer: async (answer) => {
          const chosen = answer?.paths?.[0] ?? "";
          if (chosen) this.shell._lastPdfFolder = chosen.slice(0, chosen.lastIndexOf("/")) || "/";
          this._picker = null;
          resolve(chosen);
          return true;
        },
      });
      this._picker = { controller, resolve };
      picker.open();
    });
  }

  cancel() {
    if (this.closed) return;
    this.request.answer("cancel");
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this._picker) {
      this._picker.controller.abort();
      this._picker.resolve("");
      this._picker = null;
    }
    clearTimeout(this._timer);
    window.removeEventListener("resize", this._onResize);
    this.element.remove();
    if (this.url) URL.revokeObjectURL(this.url);
    if (this.opener?.isConnected && document.activeElement !== this.opener) {
      this.opener.focus?.({ preventScroll: true });
    }
  }
}

function fileNameOf(title) {
  const name = title.replace(/[/\\\0:*?"<>|\n\r\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return `${name || "page"}.pdf`;
}

// Pages in a PDF from Chrome (Skia writes each page as a "/Type /Page"
// object, uncompressed); 0 if it can't tell.
function countPdfPages(bytes) {
  const text = new TextDecoder("latin1").decode(bytes);
  return (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
}

registerTabRequestKind("print", {
  option: "print",
  draw: (shell, request) => {
    new PrintDialog(shell, request);
    return true;
  },
});

// File pickers (TAB_FEATURES.md, "File pickers"): a tab's <input type=file>,
// File System Access picker or Save As asks the shell ("fileChooser"
// requests). The library's picker lists the host's files through the helper
// (it runs as the user), over the tab's element. connect({ fileChooser: false })
// leaves it to the browser's fallback (the Files app's picker); a function
// draws it yourself, answering {paths, filter?} or null. `filePlaces`, an
// array or (request) => array of {name, path}, adds the shell's own places
// (a thread's project folder, say) to the picker's.
//
// request.detail: {mode: "open" | "open-multiple" | "folder" | "save", upload,
// title, origin, filters: [{name, patterns}], currentFilter, currentName,
// currentFolder, defaultExtension}.
registerTabRequestKind("fileChooser", {
  option: "fileChooser",
  draw: (shell, request) => {
    new FileChooser(shell, request).open();
    return true;
  },
});

const FILE_CHOOSER_STYLE = `@layer plutonium {
  .plutonium-file-chooser { display: grid; grid-template: auto auto 1fr auto / 150px 1fr; gap: 8px 10px;
    width: min(720px, calc(100vw - 16px)); height: min(480px, calc(100vh - 16px)); max-width: none; }
  .plutonium-file-chooser:not(:popover-open) { display: none; }
  .plutonium-file-chooser header { grid-column: 1 / -1; display: flex; gap: 8px; align-items: baseline; }
  .plutonium-file-chooser header b { font-size: 1.1em; }
  .plutonium-file-chooser header span { opacity: .65; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .plutonium-file-chooser nav { grid-row: 2 / 4; overflow: auto; display: flex; flex-direction: column; gap: 1px; }
  .plutonium-file-chooser nav button, .plutonium-file-chooser li { all: unset; box-sizing: border-box; display: block;
    padding: 4px 8px; border-radius: 4px; cursor: default; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .plutonium-file-chooser nav button:hover, .plutonium-file-chooser li:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
  .plutonium-file-chooser nav button.current, .plutonium-file-chooser li[aria-selected="true"] {
    background: var(--plutonium-dialog-accent, AccentColor); color: AccentColorText; }
  .plutonium-file-chooser nav hr { border: 0; border-top: 1px solid color-mix(in srgb, currentColor 15%, transparent); width: 100%; }
  .plutonium-file-chooser .path { display: flex; gap: 6px; }
  .plutonium-file-chooser .path input { flex: 1; min-width: 0; }
  .plutonium-file-chooser ul { margin: 0; padding: 0; overflow: auto; list-style: none; outline: none;
    border: 1px solid color-mix(in srgb, currentColor 15%, transparent); border-radius: 4px; }
  .plutonium-file-chooser li { display: grid; grid-template-columns: 1fr 80px 130px; gap: 8px; }
  .plutonium-file-chooser li .size, .plutonium-file-chooser li .date { opacity: .7; text-align: right; font-variant-numeric: tabular-nums; }
  .plutonium-file-chooser li.dir .name::before { content: "▸ "; opacity: .6; }
  .plutonium-file-chooser li.disabled { opacity: .45; }
  .plutonium-file-chooser .empty { padding: 12px; opacity: .6; }
  .plutonium-file-chooser footer { grid-column: 1 / -1; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .plutonium-file-chooser footer .name { flex: 1; min-width: 120px; }
  .plutonium-file-chooser footer .message { flex-basis: 100%; color: var(--plutonium-dialog-accent, AccentColor); }
  .plutonium-file-chooser footer .spacer { flex: 1; }
}`;

let fileChooserStyle = null;

/** A filter's name: its own, else its patterns ("All files" for *). */
function fileFilterName(filter) {
  if (filter.name) return filter.name;
  if (filter.patterns.includes("*")) return "All files";
  return filter.patterns.join(", ");
}

function fileMatches(filter, name) {
  if (!filter || filter.patterns.includes("*")) return true;
  const lower = name.toLowerCase();
  return filter.patterns.some((pattern) => lower.endsWith(pattern.replace(/^\*/, "").toLowerCase()));
}

function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function joinPath(dir, name) {
  return name.startsWith("/") ? name : `${dir.replace(/\/$/, "")}/${name}`;
}

// Desktop services (DESKTOP_SERVICES.md). `shell.system.audio` is the audio
// service: `await service.ready` (or `refresh()`) for its first state, then
// its "change" events keep `state` current; `call(action, args)` runs an
// action. A shell gets the services its shell.json names in "uses";
// `shell.system.available()` lists them.

class SystemService extends EventTarget {
  constructor(name) {
    super();
    this.name = name;
    /** The service's state (null until the first answer). */
    this.state = null;
    /** Why it isn't available (not in "uses", not on this computer), once asked. */
    this.error = null;
    /** Its first state (or the error). */
    this.ready = this.refresh();
  }

  async refresh() {
    try {
      this._set(await helperFiles(`/v1/shell/system/${this.name}`));
      this.error = null;
    } catch (error) {
      this.error = String(error?.message ?? error);
      throw error;
    }
    return this.state;
  }

  async call(action, args = {}) {
    const { value } = await helperFiles(`/v1/shell/system/${this.name}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    return value;
  }

  _set(state) {
    this.state = state;
    this.dispatchEvent(new CustomEvent("change", { detail: state }));
  }
}

/** @typedef {{ available(): Promise<{ name: string, allowed: boolean }[]>, get(name: string): SystemService, _changed(name: string, state: unknown): void }} SystemServices */

/** @returns {SystemServices & Record<string, SystemService>} */
function systemServices() {
  /** @type {Map<string, SystemService>} */
  const services = new Map();
  const get = (name) => {
    let service = services.get(name);
    if (!service) {
      service = new SystemService(name);
      service.ready.catch(() => {});
      services.set(name, service);
    }
    return service;
  };
  const methods = {
    async available() {
      return (await helperFiles("/v1/shell/system")).services;
    },
    get,
    _changed(name, state) {
      services.get(name)?._set(state);
    },
  };
  return /** @type {any} */ (
    new Proxy(methods, {
      get: (target, key) => (typeof key !== "string" || key in target ? target[key] : get(key)),
    })
  );
}

// An installed shell's own side (DESKTOP_SERVICES.md, "A native side and
// storage"). `shell.native.call("listNotes", { folder })` runs the function
// its native module exports; what the module emits arrives as events on
// `shell.native` (addEventListener(name, (event) => event.detail)).
class ShellNativeSide extends EventTarget {
  async call(name, args = {}) {
    const { value } = await helperFiles(`/v1/shell/native/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    return value;
  }
}

const storagePath = (key) => `/v1/shell/storage/${encodeURIComponent(key)}`;

const shellStorage = {
  /** The value at `key` (undefined: none). */
  async get(key) {
    const response = await fetch(`${HELPER}${storagePath(key)}`);
    if (response.status === 404) return undefined;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `${response.status}`);
    return body.value;
  },
  async set(key, value) {
    await helperFiles(storagePath(key), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
  },
  async delete(key) {
    await helperFiles(storagePath(key), { method: "DELETE" });
  },
  async keys() {
    return (await helperFiles("/v1/shell/storage")).keys;
  },
};

async function helperFiles(path, init) {
  const response = await fetch(`${HELPER}${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `${response.status}`);
  return body;
}

// The library's file picker: places on the left, a folder's files on the
// right, the path above and the name, filter and buttons below.
class FileChooser {
  constructor(shell, request) {
    this.shell = shell;
    this.request = request;
    const detail = request.detail ?? {};
    this.mode = detail.mode ?? "open";
    this.filters = Array.isArray(detail.filters) ? detail.filters : [];
    this.filter = this.filters.length ? Math.min(Math.max(detail.currentFilter ?? 0, 0), this.filters.length - 1) : -1;
    this.dir = "";
    this.entries = [];
    this.selected = new Set();
    this.anchor = -1;
    this.hidden = false;
    this.confirmReplace = "";
    /** The folder a folder upload asked "Upload N files?" about; accepting again sends it. */
    this.confirmUpload = "";
  }

  get isFolder() {
    return this.mode === "folder";
  }

  get isSave() {
    return this.mode === "save";
  }

  open() {
    ensureDialogStyle();
    if (!fileChooserStyle) {
      fileChooserStyle = document.createElement("style");
      fileChooserStyle.textContent = FILE_CHOOSER_STYLE;
      document.head.append(fileChooserStyle);
    }
    const detail = this.request.detail ?? {};
    const titles = {
      open: "Open file",
      "open-multiple": "Open files",
      folder: detail.upload ? "Upload folder" : "Select folder",
      save: "Save as",
    };
    const accept = { open: "Open", "open-multiple": "Open", folder: detail.upload ? "Upload" : "Select", save: "Save" };

    const element = document.createElement("div");
    element.className = "plutonium-dialog plutonium-file-chooser";
    element.popover = "manual";
    element.tabIndex = -1;
    element.setAttribute("role", "dialog");
    element.innerHTML = `
      <header><b></b><span class="origin"></span></header>
      <nav></nav>
      <div class="path"><button class="up" title="Up">↑</button><input class="dir" spellcheck="false"></div>
      <ul role="listbox" tabindex="0"></ul>
      <footer>
        <input class="name" spellcheck="false" placeholder="Name">
        <select class="filter"></select>
        <label><input type="checkbox" class="hidden"> Hidden files</label>
        <span class="spacer"></span>
        <button class="new-folder">New folder</button>
        <button class="cancel">Cancel</button>
        <button class="accept default"></button>
        <span class="message" hidden></span>
      </footer>`;
    const $ = (selector) => element.querySelector(selector);
    this.element = element;
    this.list = $("ul");
    this.dirInput = $(".dir");
    this.nameInput = $(".name");
    this.acceptButton = $(".accept");
    this.message = $(".message");
    $("header b").textContent = detail.title || titles[this.mode] || titles.open;
    $(".origin").textContent = detail.origin ?? this.request.tab?.url ?? this.request.source?.name ?? "";
    this.acceptButton.textContent = detail.acceptLabel || (accept[this.mode] ?? "Open");
    this.addChoices($(".spacer"));
    this.list.setAttribute("aria-multiselectable", String(this.mode === "open-multiple"));
    if (!this.isSave) this.nameInput.hidden = true;
    else this.nameInput.value = detail.currentName ?? "";
    if (!this.isSave && !this.isFolder) $(".new-folder").hidden = true;
    const filterSelect = $(".filter");
    if (this.filters.length === 0 || this.isFolder) filterSelect.hidden = true;
    for (const [index, filter] of this.filters.entries()) {
      filterSelect.append(new Option(fileFilterName(filter), String(index), false, index === this.filter));
    }

    filterSelect.addEventListener("change", () => {
      this.filter = Number(filterSelect.value);
      this.render();
    });
    $(".hidden").addEventListener("change", (event) => {
      this.hidden = event.target.checked;
      this.load(this.dir);
    });
    $(".up").addEventListener("click", () => this.dir !== "/" && this.load(this.dir.replace(/\/[^/]*\/?$/, "") || "/"));
    $(".cancel").addEventListener("click", () => this.finish(null));
    $(".new-folder").addEventListener("click", () => this.newFolder());
    this.acceptButton.addEventListener("click", () => this.accept());
    this.dirInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      this.goTo(this.dirInput.value.trim());
    });
    this.nameInput.addEventListener("input", () => this.setMessage(""));
    this.list.addEventListener("click", (event) => this.onClick(event));
    this.list.addEventListener("dblclick", (event) => this.onDoubleClick(event));
    element.addEventListener("keydown", (event) => this.onKey(event));
    this.request.signal.addEventListener("abort", () => this.close());

    document.body.append(element);
    element.showPopover();
    this.place();
    this.onResize = () => this.place();
    window.addEventListener("resize", this.onResize);
    if (this.isSave) {
      this.nameInput.focus({ preventScroll: true });
      // The name, without its extension, ready to type over.
      this.nameInput.setSelectionRange(0, this.nameInput.value.replace(/\.[^.]*$/, "").length || undefined);
    } else {
      this.list.focus({ preventScroll: true });
    }
    this.start(detail.currentFolder);
  }

  // An app's extra choices (the portal's, such as an encoding): a select each, or a
  // checkbox for one without options; answered as {id: value}.
  addChoices(before) {
    this.choices = {};
    for (const choice of this.request.detail?.choices ?? []) {
      this.choices[choice.id] = choice.value;
      const label = document.createElement("label");
      if (choice.options.length === 0) {
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = choice.value === "true";
        box.addEventListener("change", () => (this.choices[choice.id] = String(box.checked)));
        label.append(box, ` ${choice.label}`);
      } else {
        const select = document.createElement("select");
        for (const option of choice.options) {
          select.append(new Option(option.label, option.id, false, option.id === choice.value));
        }
        select.addEventListener("change", () => (this.choices[choice.id] = select.value));
        label.append(`${choice.label} `, select);
      }
      before.before(label);
    }
  }

  // Over the tab's (or the app window's) element, else in the middle of the page.
  place() {
    const element =
      this.shell.shownTabElement(this.request.tabId) ?? this.shell.shownWindowElement(this.request.source?.windowId);
    const box = element?.getBoundingClientRect() ?? {
      left: 0,
      top: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    };
    const { offsetWidth: width, offsetHeight: height } = this.element;
    const left = Math.min(Math.max(box.left + (box.width - width) / 2, 8), window.innerWidth - width - 8);
    const top = Math.min(Math.max(box.top + (box.height - height) / 2, 8), window.innerHeight - height - 8);
    this.element.style.left = `${Math.max(left, 0)}px`;
    this.element.style.top = `${Math.max(top, 0)}px`;
  }

  async loadPlaces() {
    const nav = this.element.querySelector("nav");
    let found = { places: [], recent: [] };
    try {
      found = await helperFiles("/v1/files/places");
    } catch (error) {
      console.error("plutonium: the file picker's places", error);
    }
    this.home = found.places.find((place) => place.kind === "home")?.path ?? "/";
    this.recent = found.recent ?? [];
    const own = this.shell.options.filePlaces;
    let extra = [];
    try {
      extra = (typeof own === "function" ? own(this.request) : own) ?? [];
    } catch (error) {
      console.error("plutonium: filePlaces", error);
    }
    const button = (name, title, onClick) => {
      const element = document.createElement("button");
      element.textContent = name;
      element.title = title;
      element.addEventListener("click", onClick);
      nav.append(element);
      return element;
    };
    for (const place of extra) button(place.name, place.path, () => this.load(place.path)).dataset.path = place.path;
    if (extra.length) nav.append(document.createElement("hr"));
    if (this.recent.length && !this.isFolder) button("Recent", "Recently opened files", () => this.showRecent());
    for (const place of found.places) button(place.name, place.path, () => this.load(place.path)).dataset.path = place.path;
    this.markPlace();
  }

  markPlace() {
    for (const button of this.element.querySelectorAll("nav button")) {
      button.classList.toggle("current", button.dataset.path === this.dir || (!this.dir && button.textContent === "Recent"));
    }
  }

  // The folder the page suggests, else the last one used here, else home.
  async start(folder) {
    const places = this.loadPlaces();
    for (const dir of [folder, this.shell._lastFileFolder]) {
      if (dir && (await this.load(dir, { quiet: true }))) return;
    }
    await places;
    if (!this.closed && !this.dir) this.load(this.home);
  }

  // Typed in the path field: a folder opens; a file (open modes) is chosen.
  async goTo(path) {
    if (!path) return;
    if (!path.startsWith("/")) path = joinPath(this.dir || "/", path);
    if (path.startsWith("~")) path = path.replace(/^~/, this.home ?? "");
    if (await this.load(path, { quiet: true })) return;
    const parent = path.replace(/\/[^/]*$/, "") || "/";
    const name = path.slice(parent.length).replace(/^\//, "");
    if (!(await this.load(parent, { quiet: true }))) {
      this.setMessage(`${path} can't be opened.`);
      return;
    }
    const entry = this.entries.find((candidate) => candidate.name === name);
    if (this.isSave) {
      this.nameInput.value = name;
      this.accept();
    } else if (entry && entry.kind === "file" && !this.isFolder) {
      this.finish([entry.path]);
    } else {
      this.setMessage(`${path} doesn't exist.`);
    }
  }

  async load(dir, { quiet = false } = {}) {
    try {
      const listing = await helperFiles(`/v1/files?dir=${encodeURIComponent(dir)}${this.hidden ? "&hidden=1" : ""}`);
      this.dir = listing.dir;
      this.entries = listing.entries;
      this.recentShown = false;
    } catch (error) {
      if (!quiet) this.setMessage(error.message);
      return false;
    }
    this.selected.clear();
    this.anchor = -1;
    this.dirInput.value = this.dir;
    this.setMessage("");
    this.markPlace();
    this.render();
    return true;
  }

  showRecent() {
    this.dir = "";
    this.entries = this.recent;
    this.recentShown = true;
    this.selected.clear();
    this.anchor = -1;
    this.dirInput.value = "";
    this.markPlace();
    this.render();
  }

  // What the list shows: folders, and the files the filter lets through
  // (none in folder mode: they show, but can't be chosen).
  visible() {
    const filter = this.filters[this.filter];
    return this.entries.filter((entry) => entry.kind === "dir" || this.isFolder || fileMatches(filter, entry.name));
  }

  selectable(entry) {
    return this.isFolder ? entry.kind === "dir" : true;
  }

  render() {
    this.shown = this.visible();
    this.list.replaceChildren();
    if (this.shown.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = this.recentShown ? "No recent files" : "This folder is empty";
      this.list.append(empty);
    }
    const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
    for (const [index, entry] of this.shown.entries()) {
      const item = document.createElement("li");
      item.role = "option";
      item.dataset.index = String(index);
      item.className = entry.kind;
      if (this.isFolder && entry.kind === "file") item.classList.add("disabled");
      item.setAttribute("aria-selected", String(this.selected.has(entry.path)));
      item.title = entry.path;
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = entry.name;
      const size = document.createElement("span");
      size.className = "size";
      size.textContent = entry.kind === "file" ? fileSize(entry.size) : "";
      const date = document.createElement("span");
      date.className = "date";
      date.textContent = entry.modified ? dateFormat.format(entry.modified) : "";
      item.append(name, size, date);
      this.list.append(item);
    }
  }

  select(index, { extend = false, toggle = false } = {}) {
    const entry = this.shown[index];
    if (!entry) return;
    const multiple = this.mode === "open-multiple";
    if (multiple && extend && this.anchor >= 0) {
      this.selected.clear();
      const [from, to] = [Math.min(this.anchor, index), Math.max(this.anchor, index)];
      for (let i = from; i <= to; i++) if (this.shown[i].kind === "file") this.selected.add(this.shown[i].path);
    } else if (multiple && toggle) {
      if (this.selected.has(entry.path)) this.selected.delete(entry.path);
      else this.selected.add(entry.path);
      this.anchor = index;
    } else {
      this.selected = new Set([entry.path]);
      this.anchor = index;
    }
    if (this.isSave && entry.kind === "file") this.nameInput.value = entry.name;
    this.confirmReplace = "";
    this.setMessage("");
    for (const item of this.list.querySelectorAll("li")) {
      item.setAttribute("aria-selected", String(this.selected.has(this.shown[Number(item.dataset.index)].path)));
    }
    this.list.querySelector(`li[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }

  onClick(event) {
    const item = event.target.closest("li");
    if (!item) return;
    this.select(Number(item.dataset.index), { extend: event.shiftKey, toggle: event.ctrlKey || event.metaKey });
  }

  onDoubleClick(event) {
    const item = event.target.closest("li");
    const entry = item && this.shown[Number(item.dataset.index)];
    if (!entry) return;
    if (entry.kind === "dir") this.load(entry.path);
    else if (!this.isFolder) {
      if (this.isSave) this.nameInput.value = entry.name;
      this.accept([entry]);
    }
  }

  onKey(event) {
    const inField = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement;
    if (event.key === "Escape") {
      event.preventDefault();
      this.finish(null);
    } else if (event.key === "Enter" && event.target !== this.dirInput && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      const entries = this.selectedEntries();
      if (!this.isSave && entries.length === 1 && entries[0].kind === "dir" && !this.isFolder) this.load(entries[0].path);
      else this.accept();
    } else if (!inField && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = Math.min(Math.max(this.anchor + step, 0), this.shown.length - 1);
      this.select(next, { extend: event.shiftKey });
    } else if (!inField && event.key === "Backspace") {
      event.preventDefault();
      if (this.dir && this.dir !== "/") this.load(this.dir.replace(/\/[^/]*\/?$/, "") || "/");
    } else if (!inField && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Type to jump to a name.
      const key = event.key.toLowerCase();
      const start = this.anchor + 1;
      const order = [...this.shown.keys()].map((i) => (i + start) % this.shown.length);
      const index = order.find((i) => this.shown[i].name.toLowerCase().startsWith(key));
      if (index !== undefined) this.select(index);
    }
  }

  selectedEntries() {
    return this.shown?.filter((entry) => this.selected.has(entry.path)) ?? [];
  }

  async newFolder() {
    if (!this.dir) return;
    const name = this.isSave && this.nameInput.value.trim() && !this.nameInput.value.includes(".")
      ? this.nameInput.value.trim()
      : "New folder";
    let path = joinPath(this.dir, name);
    for (let n = 2; this.entries.some((entry) => entry.path === path); n++) path = joinPath(this.dir, `${name} ${n}`);
    try {
      await helperFiles("/v1/files/folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
    } catch (error) {
      this.setMessage(error.message);
      return;
    }
    await this.load(path);
  }

  accept(entries = this.selectedEntries()) {
    if (this.isFolder) {
      const chosen = entries.find((entry) => entry.kind === "dir")?.path ?? this.dir;
      if (!chosen) return;
      // A folder upload sends every file in it, so ask first, as Chrome does. The browser
      // then skips its own dialog for this folder.
      if (this.request.detail?.upload && this.confirmUpload !== chosen) {
        this.confirmFolderUpload(chosen);
        return;
      }
      this.finish([chosen]);
      return;
    }
    if (this.isSave) {
      const name = this.nameInput.value.trim();
      if (!name) {
        this.setMessage("Type a name.");
        this.nameInput.focus();
        return;
      }
      if (!this.dir && !name.startsWith("/")) {
        this.setMessage("Choose a folder.");
        return;
      }
      const path = joinPath(this.dir, name);
      const existing = this.entries.find((entry) => entry.path === path);
      if (existing?.kind === "dir") {
        this.load(path);
        return;
      }
      if (existing && this.confirmReplace !== path) {
        this.confirmReplace = path;
        this.setMessage(`${name} already exists. Save again to replace it.`);
        this.acceptButton.textContent = "Replace";
        return;
      }
      this.finish([path]);
      return;
    }
    const files = entries.filter((entry) => entry.kind === "file");
    const dirs = entries.filter((entry) => entry.kind === "dir");
    if (files.length === 0) {
      if (dirs.length === 1) this.load(dirs[0].path);
      else this.setMessage("Choose a file.");
      return;
    }
    this.finish(files.map((entry) => entry.path));
  }

  async confirmFolderUpload(folder) {
    let count;
    try {
      count = await helperFiles(`/v1/files/count?dir=${encodeURIComponent(folder)}`);
    } catch (error) {
      this.setMessage(error.message);
      return;
    }
    if (this.closed) return;
    const files = `${count.files.toLocaleString()}${count.more ? "+" : ""} file${count.files === 1 ? "" : "s"}`;
    const site = this.request.detail?.origin || "this site";
    const name = folder.replace(/\/+$/, "").split("/").pop() || folder;
    this.setMessage(`Upload ${files} from “${name}” to ${site}? Only do this if you trust the site.`);
    this.confirmUpload = folder;
    this.acceptButton.textContent = `Upload ${files}`;
  }

  setMessage(text) {
    if (!this.message) return;
    this.message.textContent = text;
    this.message.hidden = !text;
    if (!text && this.isSave) this.acceptButton.textContent = "Save";
    if (!text && this.confirmUpload) {
      this.confirmUpload = "";
      this.acceptButton.textContent = "Upload";
    }
  }

  async finish(paths) {
    if (this.closed) return;
    if (paths && this.dir) this.shell._lastFileFolder = this.dir;
    const answer = paths ? { paths, ...(this.filter >= 0 && !this.isFolder ? { filter: this.filter } : {}) } : null;
    if (answer && this.request.detail?.choices?.length) answer.choices = this.choices;
    const ok = await this.request.answer(answer);
    if (!ok && paths) {
      this.setMessage("The page didn't take that.");
      return;
    }
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    window.removeEventListener("resize", this.onResize);
    this.element?.remove();
  }
}

// The download list's look, on top of DIALOG_STYLE.
const DOWNLOAD_STYLE = `@layer plutonium {
  .plutonium-download-toast { pointer-events: auto; cursor: pointer; }
  .plutonium-downloads { width: min(420px, calc(100vw - 16px)); max-height: min(480px, calc(100vh - 16px)); overflow-y: auto; }
  .plutonium-downloads h2 { margin: 0 0 8px; font-size: 1em; display: flex; align-items: center; }
  .plutonium-downloads h2 span { flex: 1; }
  .plutonium-downloads h2 button { all: unset; cursor: default; padding: 0 6px; border-radius: 4px; opacity: .7; }
  .plutonium-downloads h2 button:hover { opacity: 1; background: color-mix(in srgb, currentColor 10%, transparent); }
  .plutonium-downloads .empty { opacity: .65; }
  .plutonium-download { display: grid; gap: 4px; padding: 8px 0; border-top: 1px solid color-mix(in srgb, currentColor 15%, transparent); }
  .plutonium-download .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .plutonium-download .status { font-size: .9em; opacity: .75; font-variant-numeric: tabular-nums; }
  .plutonium-download .danger { color: var(--plutonium-dialog-danger, #d33); font-size: .9em; }
  .plutonium-download progress { width: 100%; height: 4px; }
  .plutonium-download .actions { display: flex; gap: 6px; flex-wrap: wrap; }
}`;

let downloadStyle = null;

function ensureDownloadStyle() {
  if (downloadStyle) return;
  downloadStyle = document.createElement("style");
  downloadStyle.textContent = DOWNLOAD_STYLE;
  document.head.append(downloadStyle);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

// The library's download list: a popover with each download's progress and actions. It
// redraws as downloads change, until it closes: ×, Escape, a click outside it (not on its
// anchor, which toggles it), or the keyboard going to an app or a tab. Not the popover's
// own light dismiss: a click into a tab or an app never reaches this page.
class DownloadList {
  constructor(shell, thread, anchor) {
    ensureDialogStyle();
    ensureDownloadStyle();
    this.shell = shell;
    this.thread = thread;
    this.anchor = anchor ?? null;
    this.element = document.createElement("div");
    this.element.className = "plutonium-dialog plutonium-downloads";
    this.element.popover = "manual";
    this._listeners = [];
    const on = (target, type, handler, options) => {
      target.addEventListener(type, handler, options);
      this._listeners.push(() => target.removeEventListener(type, handler, options));
    };
    on(window, "pointerdown", (event) => {
      if (!this.element.contains(event.target) && !this.anchor?.contains(event.target)) this.close();
    }, true);
    on(window, "keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      this.close();
    }, true);
    on(window, "blur", () => this.close());
    // What has the keyboard now; the list closes when another app or tab gets it, not on
    // every change to the one that has it (a download's own tab, say).
    const focused = new Set();
    for (const [kind, map] of [["tab", shell.tabs], ["window", shell.windows]]) {
      for (const [id, entry] of map) if (entry?.focused) focused.add(`${kind}:${id}`);
    }
    const onFocused = (kind) => (event) => {
      const entry = event.entry;
      if (!entry) return;
      const key = `${kind}:${entry.id}`;
      if (!entry.focused) focused.delete(key);
      else if (!focused.has(key)) this.close();
    };
    if (shell.broker) {
      on(shell.broker, "windowchanged", onFocused("window"));
      on(shell.broker, "tabchanged", onFocused("tab"));
    }
    document.body.append(this.element);
    this.render();
    this.element.showPopover();
    const box = anchor?.getBoundingClientRect();
    if (box) {
      this.element.style.left = `${Math.max(8, Math.min(box.left, innerWidth - this.element.offsetWidth - 8))}px`;
      this.element.style.top = `${box.bottom + 4}px`;
    } else {
      this.element.style.right = "12px";
      this.element.style.top = "12px";
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const remove of this._listeners) remove();
    if (this.shell._downloadList === this) this.shell._downloadList = null;
    this.element.remove();
  }

  render() {
    const downloads = this.shell.downloads({ thread: this.thread }).reverse();
    const title = document.createElement("h2");
    const label = document.createElement("span");
    label.textContent = "Downloads";
    const close = document.createElement("button");
    close.textContent = "×";
    close.title = "Close (Escape)";
    close.addEventListener("click", () => this.close());
    title.append(label, close);
    const rows = downloads.map((download) => this._row(download));
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No downloads yet.";
      rows.push(empty);
    }
    this.element.replaceChildren(title, ...rows);
  }

  _row(download) {
    const row = document.createElement("div");
    row.className = "plutonium-download";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = download.filename || download.url;
    name.title = download.path || download.url;
    const status = document.createElement("div");
    status.className = "status";
    const size = download.totalBytes ? formatBytes(download.totalBytes) : "";
    status.textContent =
      download.state === "in-progress"
        ? `${formatBytes(download.receivedBytes)}${size ? ` of ${size}` : ""}`
        : download.state === "complete"
          ? `${size || formatBytes(download.receivedBytes)}${download.thread ? ` · ${this.shell.labelOf(download.thread) || download.thread}` : ""}`
          : download.state === "interrupted"
            ? `Failed${download.error ? ` (${download.error})` : ""}`
            : download.state === "paused"
              ? `Paused, ${formatBytes(download.receivedBytes)}${size ? ` of ${size}` : ""}`
              : "Cancelled";
    row.append(name, status);
    if (download.state === "in-progress" || download.state === "paused") {
      const progress = document.createElement("progress");
      if (download.totalBytes) {
        progress.max = download.totalBytes;
        progress.value = download.receivedBytes;
      }
      row.append(progress);
    }
    if (download.danger) {
      const danger = document.createElement("div");
      danger.className = "danger";
      danger.textContent = "This file may be dangerous. Keep it?";
      row.append(danger);
    }
    const actions = document.createElement("div");
    actions.className = "actions";
    const button = (label, command, isDefault = false) => {
      const element = document.createElement("button");
      element.textContent = label;
      if (isDefault) element.className = "default";
      element.addEventListener("click", () => {
        this.shell.downloadCommand(download.id, command).catch((error) => {
          this.shell._downloadToast(download, error.message);
        });
      });
      actions.append(element);
    };
    if (download.danger) {
      button("Discard", "discard", true);
      button("Keep", "keep");
    } else if (download.state === "in-progress") {
      button("Pause", "pause");
      button("Cancel", "cancel");
    } else if (download.state === "paused") {
      button("Resume", "resume", true);
      button("Cancel", "cancel");
    } else if (download.state === "complete") {
      button("Open", "open", true);
      button("Show in folder", "show");
    } else if (download.state === "interrupted" && download.canResume) {
      button("Retry", "resume", true);
    }
    if (!download.danger && download.state !== "in-progress" && download.state !== "paused") {
      button("Remove", "remove");
    }
    row.append(actions);
    return row;
  }
}

// Chrome's context menu, drawn by the page: a popover (in the top layer, so
// over fullscreen elements too) per open (sub)menu. The choice goes back to
// Chrome with closeContextMenu(); so does dismissing it.
class ContextMenu {
  constructor(shell, request) {
    if (!menuStyle) {
      menuStyle = document.createElement("style");
      menuStyle.textContent = MENU_STYLE;
      document.head.append(menuStyle);
    }
    this.shell = shell;
    this.request = request;
    /** @type {Map<number, ContextMenuItem[]>} items by the submenu they're in */
    this.children = new Map();
    for (const item of request.items) {
      if (!this.children.has(item.parentId)) this.children.set(item.parentId, []);
      this.children.get(item.parentId).push(item);
    }
    /** Where focus was (a tab's <embed>, an input): it goes back there. */
    this.opener = document.activeElement;
    /** @type {{ element: HTMLElement, rows: { item: ContextMenuItem, row: HTMLElement }[], active: number }[]} */
    this.panels = [];
    this.closed = false;
    this.opened = { x: request.x, y: request.y };
    this._listeners = [];
    const on = (target, type, handler, options) => {
      target.addEventListener(type, handler, options);
      this._listeners.push(() => target.removeEventListener(type, handler, options));
    };
    on(window, "pointerdown", (event) => {
      if (!this._inMenu(event.target)) this.close(0);
    }, true);
    on(window, "keydown", (event) => this._onKey(event), true);
    on(window, "resize", () => this.close(0));
    on(window, "blur", () => this.close(0));
    on(document, "visibilitychange", () => this.close(0));
    // A click into an app or a tab gives it the keyboard: the menu is done.
    const onFocused = (event) => {
      if (event.entry?.focused) this.close(0);
    };
    on(shell.broker, "windowchanged", onFocused);
    on(shell.broker, "tabchanged", onFocused);
    const top = this._panel(0);
    if (!top) {
      this.close(0);
      return;
    }
    this._place(top.element, { left: request.x, right: request.x, top: request.y, bottom: request.y });
    top.element.focus({ preventScroll: true });
  }

  close(itemId) {
    if (this.closed) return;
    this.closed = true;
    for (const remove of this._listeners) remove();
    for (const panel of this.panels) panel.element.remove();
    this.panels = [];
    if (this.opener?.isConnected && document.activeElement !== this.opener) {
      this.opener.focus?.({ preventScroll: true });
    }
    if (this.shell._menu === this) this.shell._menu = null;
    this.shell.closeContextMenu(this.request.menuId, itemId);
  }

  _inMenu(node) {
    return this.panels.some((panel) => panel.element.contains(node));
  }

  // A panel for the items in submenu `parentId` (0: the menu itself).
  _panel(parentId) {
    const items = this.children.get(parentId) ?? [];
    if (!items.length) return null;
    const element = document.createElement("div");
    element.className = "plutonium-menu";
    element.popover = "manual";
    element.tabIndex = -1;
    element.setAttribute("role", "menu");
    const checks = items.some((item) => item.type === "checkbox" || item.type === "radio");
    const panel = { element, rows: [], active: -1, parentId };
    const depth = this.panels.length;
    for (const item of items) {
      if (item.type === "separator") {
        const line = document.createElement("div");
        line.className = "plutonium-menu-separator";
        line.setAttribute("role", "separator");
        element.append(line);
        continue;
      }
      if (item.type === "title") {
        const title = document.createElement("div");
        title.className = "plutonium-menu-title";
        title.textContent = item.label;
        element.append(title);
        continue;
      }
      const row = document.createElement("div");
      row.className = "plutonium-menu-item";
      row.setAttribute(
        "role",
        item.type === "checkbox" ? "menuitemcheckbox" : item.type === "radio" ? "menuitemradio" : "menuitem",
      );
      if (!item.enabled) row.setAttribute("aria-disabled", "true");
      if (checks) {
        const check = document.createElement("span");
        check.className = "check";
        check.textContent = item.checked ? (item.type === "radio" ? "•" : "✓") : "";
        if (item.type !== "command") row.setAttribute("aria-checked", String(item.checked));
        row.append(check);
      }
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = item.label;
      row.append(label);
      if (item.type === "submenu") {
        row.setAttribute("aria-haspopup", "menu");
        const more = document.createElement("span");
        more.className = "more";
        more.textContent = "›";
        row.append(more);
      }
      element.append(row);
      const index = panel.rows.length;
      panel.rows.push({ item, row });
      row.addEventListener("pointermove", () => {
        if (panel.active !== index) this._setActive(depth, index, { open: true });
      });
      row.addEventListener("click", (event) => {
        if (event.button === 0) this._activate(depth, index);
      });
      // Press, drag onto an item, release: as in a native menu, but not the
      // release of the press that opened the menu.
      row.addEventListener("pointerup", (event) => {
        if (event.button === 2 && Math.hypot(event.clientX - this.opened.x, event.clientY - this.opened.y) > 5) {
          this._activate(depth, index);
        }
      });
    }
    element.addEventListener("contextmenu", (event) => event.preventDefault());
    document.body.append(element);
    element.showPopover();
    this.panels.push(panel);
    return panel;
  }

  // Puts `element` at `anchor` (a point, or a submenu item's row), inside the
  // viewport: below and right of it, else above or left.
  _place(element, anchor, submenu = false) {
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const pad = 4;
    let left = anchor.right;
    if (left + width > innerWidth - pad) left = submenu ? anchor.left - width : innerWidth - pad - width;
    let top = submenu ? anchor.top - parseFloat(getComputedStyle(element).paddingTop) : anchor.top;
    if (top + height > innerHeight - pad) top = submenu ? innerHeight - pad - height : anchor.top - height;
    element.style.left = `${Math.max(pad, left)}px`;
    element.style.top = `${Math.max(pad, top)}px`;
  }

  _setActive(depth, index, { open = false } = {}) {
    const panel = this.panels[depth];
    if (!panel) return;
    // Deeper submenus belong to another item now.
    while (this.panels.length > depth + 1) this.panels.pop().element.remove();
    panel.rows[panel.active]?.row.classList.remove("active");
    panel.active = index;
    const entry = panel.rows[index];
    if (!entry) return;
    entry.row.classList.add("active");
    entry.row.scrollIntoView({ block: "nearest" });
    if (open && entry.item.type === "submenu" && entry.item.enabled) this._openSubmenu(depth);
  }

  _openSubmenu(depth) {
    const panel = this.panels[depth];
    const entry = panel?.rows[panel.active];
    if (!entry || entry.item.type !== "submenu" || this.panels.length > depth + 1) return null;
    const sub = this._panel(entry.item.id);
    if (sub) this._place(sub.element, entry.row.getBoundingClientRect(), true);
    return sub;
  }

  _activate(depth, index) {
    const entry = this.panels[depth]?.rows[index];
    if (!entry || !entry.item.enabled) return;
    if (entry.item.type === "submenu") {
      this._setActive(depth, index);
      const sub = this._openSubmenu(depth);
      if (sub) this._move(depth + 1, 1);
      return;
    }
    this.close(entry.item.id);
  }

  // Moves the selection in panel `depth` by `step` (skipping disabled items).
  _move(depth, step, from) {
    const panel = this.panels[depth];
    if (!panel || !panel.rows.length) return;
    const count = panel.rows.length;
    let index = from ?? panel.active;
    for (let i = 0; i < count; i++) {
      index = index < 0 ? (step > 0 ? 0 : count - 1) : (index + step + count) % count;
      if (panel.rows[index].item.enabled) break;
    }
    this._setActive(depth, index);
    panel.element.focus({ preventScroll: true });
  }

  _onKey(event) {
    if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
    const depth = this.panels.length - 1;
    const panel = this.panels[depth];
    let handled = true;
    switch (event.key) {
      case "ArrowDown":
        this._move(depth, 1);
        break;
      case "ArrowUp":
        this._move(depth, -1);
        break;
      case "Home":
        this._move(depth, 1, -1);
        break;
      case "End":
        this._move(depth, -1, -1);
        break;
      case "ArrowRight":
        if (this._openSubmenu(depth)) this._move(depth + 1, 1);
        break;
      case "ArrowLeft":
        if (depth > 0) {
          this.panels.pop().element.remove();
          this.panels[depth - 1].element.focus({ preventScroll: true });
        }
        break;
      case "Escape":
        this.close(0);
        break;
      case "Enter":
      case " ":
        if (panel && panel.active >= 0) this._activate(depth, panel.active);
        break;
      default:
        // Any other key is for the page: the menu is done.
        handled = false;
        this.close(0);
    }
    if (handled) {
      event.preventDefault();
      event.stopImmediatePropagation();
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
    displays: [...(shell.displays ?? [])],
    visibleOn: [...(shell.visibleOn ?? [])],
  };
}

function plainDisplay(display) {
  return {
    id: display.id,
    index: display.index,
    label: display.label,
    x: display.x,
    y: display.y,
    width: display.width,
    height: display.height,
    scaleFactor: display.scaleFactor,
    rotation: display.rotation,
    primary: display.primary,
    internal: display.internal,
    focused: display.focused,
    current: display.current,
  };
}

function plainGroup(group) {
  return { tag: group.tag, label: group.label, shellId: group.shellId ?? "" };
}

function parseTabState(json) {
  try {
    const state = JSON.parse(json || "{}");
    return state && typeof state === "object" && !Array.isArray(state) ? state : {};
  } catch {
    return {};
  }
}

function plainTab(entry) {
  // Fields features report come first, so they can't hide the tab's own.
  const state = parseTabState(entry.stateJson);
  return {
    ...state,
    pending: state.pending ?? {},
    stateJson: entry.stateJson ?? "{}",
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
    if (options.contextMenu !== undefined) shell.contextMenu = options.contextMenu;
    Object.assign(shell.options, options);
  }
  return shell;
}

// Permission prompts (TAB_FEATURES.md, "Permission prompts"): a tab's page
// asks for the camera, notifications, ... as a tab request of kind
// "permission", with `detail` {origin, embeddingOrigin, thread, types,
// scopes, by?, files?}. The library draws a prompt over the tab's element
// (once this page shows the tab). connect({ permissions: false }) leaves
// the requests to the browser, which dismisses them and records them in the
// tab's `blocked`; a function draws them itself. Answer with
// shell.answerPermission(requestId, "allow" | "deny" | "dismiss", { scope }).

/** What a page may ask for, as the prompt says it ("<site> wants to …"). */
export const PERMISSION_LABELS = {
  camera: "Use your camera",
  microphone: "Use your microphone",
  "camera-pan-tilt-zoom": "Move your camera",
  geolocation: "Know your location",
  "geolocation-with-options": "Know your location",
  notifications: "Show notifications",
  "clipboard-read": "See text and images you copy",
  "midi-sysex": "Control and reprogram your MIDI devices",
  "storage-access": "Use cookies and site data",
  "top-level-storage-access": "Use cookies and site data",
  "automatic-downloads": "Download several files",
  "window-management": "Manage windows on all your displays",
  "local-fonts": "Use the fonts on your computer",
  "idle-detection": "Know when you're actively using this device",
  "keyboard-lock": "Take over your keyboard",
  "pointer-lock": "Take over your mouse pointer",
  "file-write": "Edit files",
  "file-read": "View files",
  sensors: "Use your motion sensors",
  "protected-media-identifier": "Play protected content",
  "local-network": "Reach devices on your local network",
  "loopback-network": "Reach apps on this device",
};

/** How long a fresh prompt ignores clicks, so a click meant for the page doesn't answer it. */
const PERMISSION_INPUT_DELAY_MS = 400;

const PERMISSION_STYLE = `@layer plutonium {
  .plutonium-permission { width: 340px; }
  .plutonium-permission .title { font-weight: 600; margin: 0 22px 6px 0; overflow-wrap: anywhere; }
  .plutonium-permission .by { font-size: .9em; opacity: .75; margin-bottom: 6px; }
  .plutonium-permission ul { margin: 0 0 8px; padding-left: 1.2em; }
  .plutonium-permission .files { font-size: .9em; opacity: .8; margin: -4px 0 8px; overflow-wrap: anywhere; }
  .plutonium-permission fieldset { border: 0; margin: 0 0 10px; padding: 0; display: grid; gap: 3px; }
  .plutonium-permission .buttons { display: flex; justify-content: flex-end; gap: 8px; }
  .plutonium-permission .close {
    position: absolute; top: 6px; right: 6px; border: 0; background: none; color: inherit;
    font: inherit; font-size: 16px; line-height: 1; opacity: .6; cursor: default;
  }
}`;

let permissionStyle = null;

/** The prompt's label for permission `type`. */
export function permissionLabel(type) {
  return PERMISSION_LABELS[type] ?? `Use ${type.replaceAll("-", " ")}`;
}

function originHost(origin) {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin || "This page";
  }
}

/**
 * Answers permission request `requestId` (a TabRequest of kind "permission" this page took).
 * `scope` is one of the request's `detail.scopes` ("once", "thread", "everywhere"); left out,
 * the browser stores the least it can.
 */
PlutoniumShell.prototype.answerPermission = function (requestId, answer, { scope } = {}) {
  return this.answerTabRequest(requestId, scope ? { answer, scope } : { answer });
};

/**
 * Asks the user (the same prompt a page's request gets) to allow `permissions` (names as in
 * PERMISSION_LABELS) for `origin` (default: the tab's page) in tab `tabId`'s thread or
 * everywhere: the way to ask again after a request was `blocked`. Resolves once answered, with
 * {answer, scope?}, or {answer: "dismiss", fallback} if no shell took it, or {answer: "allow",
 * scope: "thread", asked: false} if the thread allows them already.
 */
PlutoniumShell.prototype.requestPermission = function (tabId, permissions, { origin } = {}) {
  return this.tabCommand(tabId, "permission-request", origin ? { permissions, origin } : { permissions });
};

/**
 * The decisions that apply in tab `tabId`: {thread, decisions: [{origin, permission,
 * decision: "allow" | "block", scope: "thread" | "everywhere"}]}, its thread's and the
 * browser's own for its page's origin.
 */
PlutoniumShell.prototype.tabPermissions = function (tabId) {
  return this.tabCommand(tabId, "permissions");
};

/**
 * Takes back a decision for tab `tabId`: its thread's (scope "thread", the default; `origin`
 * and `permission` left out match any), or the browser's own (scope "everywhere", for
 * `permission` and `origin`, default the page's). Resolves with {revoked}.
 */
PlutoniumShell.prototype.revokePermission = function (tabId, { origin, permission, scope = "thread" } = {}) {
  return this.tabCommand(tabId, "permission-revoke", { scope, ...(origin ? { origin } : {}), ...(permission ? { permission } : {}) });
};

async function permissionCommand(shell, command, args) {
  if (typeof shell.broker?.permissionCommand !== "function") return null;
  return JSON.parse(await shell.broker.permissionCommand(command, JSON.stringify(args)));
}

/**
 * Every thread's decisions (`thread`, `origin` filter them): [{thread, origin, permission,
 * decision, scope: "thread"}]. Null if this browser has no thread grants.
 */
PlutoniumShell.prototype.threadPermissions = function ({ thread, origin } = {}) {
  return permissionCommand(this, "list", { ...(thread ? { thread } : {}), ...(origin ? { origin } : {}) });
};

/**
 * Takes back thread `thread`'s decisions for `origin` and `permission` (left out: all of them).
 * A shell calls forgetThreadPermissions(thread) when it archives or deletes a thread (a settled
 * thread keeps them). Resolves with {revoked}.
 */
PlutoniumShell.prototype.revokeThreadPermissions = function (thread, { origin, permission } = {}) {
  return permissionCommand(this, "revoke", { thread, ...(origin ? { origin } : {}), ...(permission ? { permission } : {}) });
};

PlutoniumShell.prototype.forgetThreadPermissions = function (thread) {
  return this.revokeThreadPermissions(thread);
};

// The library's prompt: a popover at the top left of the tab's element, as
// Chrome's bubble sits under its address bar. It waits while this page
// doesn't show the tab, and goes away if the request ends some other way.
class PermissionPrompt {
  constructor(shell, request) {
    if (!permissionStyle) {
      ensureDialogStyle();
      permissionStyle = document.createElement("style");
      permissionStyle.textContent = PERMISSION_STYLE;
      document.head.append(permissionStyle);
    }
    this.shell = shell;
    this.request = request;
    this.element = null;
    this.shownAt = 0;
    this.place = () => this._place();
    shell.addEventListener("change", this.place);
    window.addEventListener("resize", this.place);
    request.signal.addEventListener("abort", () => this.close());
    this._place();
  }

  _build() {
    const { detail } = this.request;
    const scopes = detail.scopes ?? [];
    const element = document.createElement("div");
    element.className = "plutonium-dialog plutonium-permission";
    element.popover = "manual";
    element.setAttribute("role", "alertdialog");

    const title = document.createElement("div");
    title.className = "title";
    const host = originHost(detail.origin);
    const embedder = detail.embeddingOrigin && detail.embeddingOrigin !== detail.origin
      ? ` (on ${originHost(detail.embeddingOrigin)})` : "";
    title.textContent = `${host}${embedder} wants to`;
    element.append(title);
    if (detail.by === "agent") {
      const by = document.createElement("div");
      by.className = "by";
      by.textContent = "Asked by this thread's agent";
      element.append(by);
    }
    const list = document.createElement("ul");
    for (const type of detail.types ?? []) {
      const item = document.createElement("li");
      item.textContent = permissionLabel(type);
      list.append(item);
    }
    element.append(list);
    if (detail.files?.length) {
      const files = document.createElement("div");
      files.className = "files";
      files.textContent = detail.files.join(", ");
      element.append(files);
    }

    // The scopes, "this thread" first when there is one (TAB_FEATURES.md, Decisions 1).
    this.scope = scopes.includes("thread") ? "thread" : scopes[0];
    if (scopes.length > 1) {
      const fieldset = document.createElement("fieldset");
      const name = `plutonium-permission-${this.request.requestId}`;
      const thread = this.shell.groups.get(detail.thread)?.label;
      const labels = {
        once: "Only this time",
        thread: thread ? `In this thread (${thread})` : "In this thread",
        everywhere: "Everywhere",
      };
      for (const scope of ["thread", "once", "everywhere"].filter((scope) => scopes.includes(scope))) {
        const label = document.createElement("label");
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = name;
        radio.value = scope;
        radio.checked = scope === this.scope;
        radio.addEventListener("change", () => (this.scope = scope));
        label.append(radio, ` ${labels[scope] ?? scope}`);
        fieldset.append(label);
      }
      element.append(fieldset);
    }

    const buttons = document.createElement("div");
    buttons.className = "buttons";
    const button = (text, onClick, className = "") => {
      const node = document.createElement("button");
      node.type = "button";
      node.textContent = text;
      if (className) node.className = className;
      node.addEventListener("click", (event) => {
        if (performance.now() - this.shownAt < PERMISSION_INPUT_DELAY_MS) return;
        event.stopPropagation();
        onClick();
      });
      return node;
    };
    buttons.append(
      button("Block", () => this.answer("deny")),
      button("Allow", () => this.answer("allow"), "default"),
    );
    element.append(buttons);
    const close = button("×", () => this.answer("dismiss"), "close");
    close.title = "Not now";
    close.setAttribute("aria-label", "Not now");
    element.append(close);
    element.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.answer("dismiss");
      }
    });
    document.body.append(element);
    return element;
  }

  // Shows it over the tab's element, or hides it while this page doesn't show the tab.
  _place() {
    if (this.closed) return;
    const target = this.shell.shownTabElement(this.request.tabId);
    if (!target) {
      if (this.element?.matches(":popover-open")) this.element.hidePopover();
      return;
    }
    this.element ??= this._build();
    if (!this.element.matches(":popover-open")) {
      this.element.showPopover();
      this.shownAt = performance.now();
    }
    const box = target.getBoundingClientRect();
    const width = this.element.offsetWidth;
    const height = this.element.offsetHeight;
    const left = Math.max(8, Math.min(box.left + 12, innerWidth - width - 8));
    const top = Math.max(8, Math.min(box.top + 12, innerHeight - height - 8));
    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;
  }

  async answer(answer) {
    if (this.closed) return;
    const scope = answer === "dismiss" ? undefined : this.scope;
    const ok = await this.shell.answerPermission(this.request.requestId, answer, { scope });
    if (ok || this.request.signal.aborted) this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.shell.removeEventListener("change", this.place);
    window.removeEventListener("resize", this.place);
    this.element?.remove();
  }
}

registerTabRequestKind("permission", {
  option: "permissions",
  draw: (shell, request) => {
    new PermissionPrompt(shell, request);
    return true;
  },
});

// Captures (docs/features/CAPTURE.md).
//
// A source is { type: "output" | "window" | "tab", id, region? } (an output's
// id is a string: display ids don't fit in a JSON number; region { x, y,
// width, height } in the source's pixels).
/**
 * @typedef {{ type: "output" | "window" | "tab", id: number | string,
 *   region?: { x: number, y: number, width: number, height: number } }} CaptureSource
 * @typedef {{ id: number, kind: "stream" | "pipewire" | "display", source: CaptureSource,
 *   label: string, consumer: { kind: "shell" | "app" | "tab" | "agent", name: string,
 *   appId?: string, pid?: number, thread?: string, tabId?: number, shellId?: string },
 *   size?: { width: number, height: number }, cursor: string, nodeId?: number,
 *   startTime: number, acknowledged: boolean }} Capture
 *   kind: a shell's MediaStream, an app's through the portal (PipeWire), or a tab's
 *   getDisplayMedia. size: a window held at a capture size. acknowledged: the focused shell
 *   shows it (else Ash's own indicator does).
 * @typedef {{ requestId: number, kind: "screencast" | "screenshot", consumer: Capture["consumer"],
 *   types: string[], multiple: boolean, cursorModes?: string[], signal: AbortSignal,
 *   answer: (answer: { sources: CaptureSource[], size?: object, cursor?: string,
 *   persist?: boolean } | null) => Promise<boolean> }} CaptureRequest
 *   A consumer asks the user to choose what to capture. answer(null) refuses; signal aborts if
 *   the consumer went away first.
 *
 * connect() options:
 *   capturePicker: false leaves requests to Ash's picker; a function (request: CaptureRequest)
 *   => boolean draws its own (return true, then answer); left out, the library's picker.
 *   captureIndicator: false shows nothing (Ash shows its own indicator); a function
 *   (captures: Capture[]) => boolean shows its own (return true and the library
 *   acknowledges them); left out, the library's indicator at the top right.
 * Their look comes from the dialog properties (DIALOG_STYLE) and CAPTURE_STYLE's classes.
 */

const CAPTURE_STYLE = `@layer plutonium {
  .plutonium-capture-picker { width: min(560px, calc(100vw - 32px)); max-width: none; max-height: calc(100vh - 32px);
    display: flex; flex-direction: column; gap: 8px; }
  .plutonium-capture-picker[open], .plutonium-capture-picker:popover-open { display: flex; }
  .plutonium-capture-picker .title { font-weight: 600; }
  .plutonium-capture-picker .hint { opacity: .75; font-size: .9em; }
  .plutonium-capture-picker .sources { overflow-y: auto; display: grid; gap: 10px; }
  .plutonium-capture-picker h3 { margin: 4px 0 0; font-size: .85em; opacity: .7; text-transform: uppercase; letter-spacing: .04em; }
  .plutonium-capture-picker .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
  .plutonium-capture-picker .source { all: unset; display: grid; gap: 4px; padding: 6px; border-radius: 6px; cursor: default;
    border: 2px solid transparent; }
  .plutonium-capture-picker .source:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
  .plutonium-capture-picker .source[aria-pressed="true"] { border-color: var(--plutonium-dialog-accent, AccentColor); }
  .plutonium-capture-picker .source img, .plutonium-capture-picker .source .blank { width: 100%; aspect-ratio: 16 / 10;
    object-fit: contain; background: color-mix(in srgb, currentColor 10%, transparent); border-radius: 4px; }
  .plutonium-capture-picker .source span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .9em; }
  .plutonium-capture-picker .buttons { display: flex; justify-content: flex-end; gap: 8px; }
  .plutonium-shortcut-binder { width: min(440px, calc(100vw - 32px)); max-width: none; display: grid; gap: 8px; }
  .plutonium-shortcut-binder .title { font-weight: 600; }
  .plutonium-shortcut-binder .hint { opacity: .75; font-size: .9em; }
  .plutonium-shortcut-binder .row { display: flex; align-items: center; gap: 8px; }
  .plutonium-shortcut-binder .row span { flex: 1; }
  .plutonium-shortcut-binder .key { font: inherit; font-variant-numeric: tabular-nums; min-width: 8em; }
  .plutonium-shortcut-binder .buttons { display: flex; justify-content: flex-end; gap: 8px; }
  .plutonium-capture-indicator { top: 8px; right: 8px; padding: 6px 8px; display: grid; gap: 4px; }
  .plutonium-capture-indicator .row { display: flex; align-items: center; gap: 8px; }
  .plutonium-capture-indicator .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--plutonium-capture-dot, #e5484d); }
  .plutonium-capture-indicator button { font: inherit; }
  .plutonium-area-selector { position: fixed; inset: 0; z-index: 2147483647; cursor: crosshair; user-select: none;
    width: 100vw; height: 100vh; max-width: none; max-height: none; margin: 0; padding: 0; border: 0;
    background: transparent no-repeat 0 0 / 100% 100%; outline: none; overflow: hidden; }
  .plutonium-area-selector .shade { position: absolute; inset: 0; background: #0006; pointer-events: none; }
  .plutonium-area-selector .target { position: absolute; outline: 2px solid var(--plutonium-dialog-accent, AccentColor);
    background: color-mix(in srgb, var(--plutonium-dialog-accent, AccentColor) 15%, transparent); pointer-events: none; }
  .plutonium-area-selector .region { position: absolute; box-shadow: 0 0 0 100vmax #0006;
    outline: 1px solid #fff; pointer-events: none; }
  .plutonium-color-picker .swatch { position: absolute; display: flex; align-items: center; gap: 6px; padding: 4px 8px 4px 4px;
    border-radius: 6px; background: #000c; color: #fff; font: 12px ui-monospace, monospace; pointer-events: none; }
  .plutonium-color-picker .swatch i { width: 20px; height: 20px; border-radius: 4px; outline: 1px solid #fff8; }
  .plutonium-area-selector .help { position: absolute; left: 50%; bottom: 24px; transform: translateX(-50%);
    padding: 6px 12px; border-radius: 6px; background: #000c; color: #fff; font: 13px system-ui, sans-serif; pointer-events: none; }
}`;

let captureStyle = null;

function ensureCaptureStyle() {
  if (captureStyle) return;
  ensureDialogStyle();
  captureStyle = document.createElement("style");
  captureStyle.textContent = CAPTURE_STYLE;
  document.head.append(captureStyle);
}

/** `track` cropped to `region` (its pixels), as a new track; stopping it stops `track`. */
function cropTrack(track, region) {
  const processor = new MediaStreamTrackProcessor({ track });
  const generator = new MediaStreamTrackGenerator({ kind: "video" });
  // Even, for the chroma planes.
  const even = (value) => Math.max(0, Math.floor(value / 2) * 2);
  processor.readable
    .pipeThrough(
      new TransformStream({
        transform(frame, controller) {
          const x = Math.min(even(region.x), frame.codedWidth - 2);
          const y = Math.min(even(region.y), frame.codedHeight - 2);
          const width = Math.max(2, Math.min(even(region.width), even(frame.codedWidth - x)));
          const height = Math.max(2, Math.min(even(region.height), even(frame.codedHeight - y)));
          try {
            controller.enqueue(new VideoFrame(frame, { visibleRect: { x, y, width, height } }));
          } finally {
            frame.close();
          }
        },
      }),
    )
    .pipeTo(generator.writable)
    .catch(() => {});
  const stop = generator.stop.bind(generator);
  generator.stop = () => {
    stop();
    track.stop();
  };
  track.addEventListener("ended", () => stop());
  return generator;
}

/** `png` cropped to `region` (its pixels), as a PNG. */
async function cropPng(png, region) {
  const bitmap = await createImageBitmap(png, region.x, region.y, region.width, region.height);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas.convertToBlob({ type: "image/png" });
}

// The library's picker: a dialog in the middle of the page with every
// source the consumer asked for, by type, with thumbnails. Share answers,
// Cancel and Escape refuse.
class CapturePicker {
  constructor(shell, request) {
    ensureCaptureStyle();
    this.shell = shell;
    this.request = request;
    this.selected = [];
    this.urls = [];
    this.element = null;
    this.onKey = (event) => {
      if (event.key === "Escape") this.finish(null);
      if (event.key === "Enter" && this.selected.length) this.finish(this.answer());
    };
  }

  open() {
    const { request } = this;
    const element = document.createElement("div");
    element.className = "plutonium-dialog plutonium-capture-picker";
    element.popover = "manual";
    element.setAttribute("role", "dialog");
    element.style.left = "50%";
    element.style.top = "50%";
    element.style.transform = "translate(-50%, -50%)";
    const who = request.consumer?.name || "An app";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = request.kind === "screenshot" ? `${who} wants a screenshot` : `${who} wants to share your screen`;
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = request.multiple ? "Choose what to share (one or more)." : "Choose what to share.";
    this.list = document.createElement("div");
    this.list.className = "sources";
    const buttons = document.createElement("div");
    buttons.className = "buttons";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.onclick = () => this.finish(null);
    this.share = document.createElement("button");
    this.share.className = "default";
    this.share.textContent = request.kind === "screenshot" ? "Take" : "Share";
    this.share.disabled = true;
    this.share.onclick = () => this.finish(this.answer());
    buttons.append(cancel, this.share);
    element.append(title, hint, this.list, buttons);
    document.body.append(element);
    element.showPopover();
    element.addEventListener("keydown", this.onKey);
    this.element = element;
    request.signal.addEventListener("abort", () => this.close());
    this.fill().catch((error) => console.error("plutonium: listing capture sources", error));
    // The page is the shell: bring it to the front for the user to answer.
    this.shell.showShell();
    this.share.focus();
    return true;
  }

  async fill() {
    const sources = await this.shell.captureSources();
    const types = this.request.types?.length ? this.request.types : ["output", "window", "tab"];
    const sections = [
      ["output", "Screens", sources.outputs, (entry) => entry.name],
      ["window", "Windows", sources.windows, (entry) => entry.title || entry.appId],
      ["tab", "Tabs", sources.tabs, (entry) => entry.title || entry.url],
    ];
    for (const [type, heading, entries, label] of sections) {
      if (!types.includes(type) || !entries?.length) continue;
      const header = document.createElement("h3");
      header.textContent = heading;
      const grid = document.createElement("div");
      grid.className = "grid";
      for (const entry of entries) grid.append(this.item({ type, id: entry.id }, label(entry) || "(untitled)"));
      this.list.append(header, grid);
    }
    if (!this.list.childElementCount) this.list.textContent = "There's nothing to share.";
  }

  item(source, label) {
    const button = document.createElement("button");
    button.className = "source";
    button.setAttribute("aria-pressed", "false");
    const blank = document.createElement("div");
    blank.className = "blank";
    const text = document.createElement("span");
    text.textContent = label;
    text.title = label;
    button.append(blank, text);
    button.onclick = () => this.toggle(source, button);
    button.ondblclick = () => {
      if (!this.request.multiple) this.finish(this.answer());
    };
    // A thumbnail, if screenshots are on.
    this.shell
      .screenshot(source)
      .then((png) => {
        if (!this.element) return;
        const image = document.createElement("img");
        const url = URL.createObjectURL(png);
        this.urls.push(url);
        image.src = url;
        image.alt = "";
        blank.replaceWith(image);
      })
      .catch(() => {});
    return button;
  }

  toggle(source, button) {
    const key = (entry) => `${entry.source.type}:${entry.source.id}`;
    const index = this.selected.findIndex((entry) => key(entry) === key({ source }));
    if (!this.request.multiple) {
      for (const entry of this.selected) entry.button.setAttribute("aria-pressed", "false");
      this.selected = [];
    }
    if (index >= 0 && this.request.multiple) this.selected.splice(index, 1);
    else this.selected.push({ source, button });
    for (const entry of this.selected) entry.button.setAttribute("aria-pressed", "true");
    if (index >= 0 && this.request.multiple) button.setAttribute("aria-pressed", "false");
    this.share.disabled = this.selected.length === 0;
  }

  answer() {
    return { sources: this.selected.map((entry) => entry.source) };
  }

  async finish(answer) {
    const ok = await this.request.answer(answer);
    if (!ok && answer) return;
    this.close();
  }

  close() {
    if (!this.element) return;
    this.element.remove();
    this.element = null;
    for (const url of this.urls) URL.revokeObjectURL(url);
  }
}

// The library's indicator: a strip at the top right of the page, a line per
// capture with a Stop button, while anything is captured.
class CaptureIndicator {
  constructor(shell) {
    ensureCaptureStyle();
    this.shell = shell;
    this.element = null;
  }

  render(captures) {
    if (!captures.length) {
      this.element?.remove();
      this.element = null;
      return;
    }
    if (!this.element) {
      this.element = document.createElement("div");
      this.element.className = "plutonium-dialog plutonium-capture-indicator";
      this.element.popover = "manual";
      this.element.setAttribute("role", "status");
      document.body.append(this.element);
      this.element.showPopover();
    }
    this.element.replaceChildren(
      ...captures.map((capture) => {
        const row = document.createElement("div");
        row.className = "row";
        const dot = document.createElement("span");
        dot.className = "dot";
        const text = document.createElement("span");
        const who = capture.consumer?.name || "An app";
        text.textContent = `${who} is capturing ${capture.label}`;
        const stop = document.createElement("button");
        stop.textContent = "Stop";
        stop.onclick = () => this.shell.stopCapture(capture.id).catch(() => {});
        row.append(dot, text, stop);
        return row;
      }),
    );
  }
}

// The library's notification popups: a stack in the top right corner. A
// popup goes after a few seconds (a critical one stays) but the notification
// stays in shell.system.notifications until dismissed; × dismisses it,
// clicking it runs its default action.
/** How old a notification a page that has just connected still pops up. */
const RECENT_NOTIFICATION_MS = 30_000;
/** A touchpad swipe has ended once no update has come for this long (when the browser doesn't say). */
const SWIPE_END_MS = 150;

class NotificationPopups {
  constructor(shell) {
    ensureNotificationStyle();
    this.shell = shell;
    /** @type {Map<number, HTMLElement>} */
    this.popups = new Map();
    this.element = document.createElement("div");
    this.element.className = "plutonium-notifications";
    this.element.popover = "manual";
    this.element.setAttribute("role", "log");
    this.element.setAttribute("aria-live", "polite");
    document.body.append(this.element);
  }

  /** Removes the popups of notifications that are gone. */
  keep(ids) {
    for (const id of [...this.popups.keys()]) if (!ids.has(id)) this.hide(id);
  }

  show(notification) {
    const service = this.shell.system.notifications;
    const card = document.createElement("div");
    card.className = `plutonium-dialog card ${notification.urgency}`;
    const head = document.createElement("div");
    head.className = "head";
    const app = document.createElement("span");
    app.className = "app";
    app.textContent = notification.app;
    const close = document.createElement("button");
    close.className = "close";
    close.textContent = "×";
    close.title = "Dismiss";
    close.onclick = (event) => {
      event.stopPropagation();
      service.call("dismiss", { id: notification.id }).catch(() => {});
    };
    // A tab's web notification brings its picture (a data URL); apps' icons are theme names.
    if (notification.icon?.startsWith("data:image/")) {
      const icon = document.createElement("img");
      icon.className = "icon";
      icon.alt = "";
      icon.src = notification.icon;
      head.append(icon);
    }
    head.append(app, close);
    const summary = document.createElement("div");
    summary.className = "summary";
    summary.textContent = notification.summary;
    const body = document.createElement("div");
    body.className = "body";
    body.textContent = notification.body;
    card.append(head, summary);
    if (notification.body) card.append(body);
    const buttons = notification.actions.filter((action) => action.key !== "default");
    if (buttons.length) {
      const row = document.createElement("div");
      row.className = "actions";
      for (const action of buttons) {
        const button = document.createElement("button");
        button.textContent = action.label;
        button.onclick = (event) => {
          event.stopPropagation();
          service.call("invoke", { id: notification.id, action: action.key }).catch(() => {});
        };
        row.append(button);
      }
      card.append(row);
    }
    const clickable = notification.actions.some((action) => action.key === "default");
    card.onclick = () => {
      if (clickable) service.call("invoke", { id: notification.id, action: "default" }).catch(() => {});
      else this.hide(notification.id);
    };
    this.hide(notification.id);
    this.popups.set(notification.id, card);
    this.element.prepend(card);
    if (!this.element.matches(":popover-open")) this.element.showPopover();
    if (notification.urgency !== "critical") {
      let timer = setTimeout(() => this.hide(notification.id, card), 6000);
      // Not while the pointer is on it.
      card.onpointerenter = () => clearTimeout(timer);
      card.onpointerleave = () => (timer = setTimeout(() => this.hide(notification.id, card), 3000));
    }
  }

  hide(id, card = this.popups.get(id)) {
    if (!card || this.popups.get(id) !== card) return;
    this.popups.delete(id);
    card.remove();
    if (!this.popups.size && this.element.matches(":popover-open")) this.element.hidePopover();
  }
}

const NOTIFICATION_STYLE = `@layer plutonium {
  .plutonium-notifications { inset: 8px 8px auto auto; margin: 0; padding: 0; border: 0; background: none; overflow: visible;
    display: grid; gap: 8px; width: min(360px, calc(100vw - 16px)); }
  .plutonium-notifications .card { position: static; margin: 0; padding: 8px 10px; display: grid; gap: 2px; cursor: default; }
  .plutonium-notifications .card.critical { border-left: 3px solid var(--plutonium-notification-critical, #e5484d); }
  .plutonium-notifications .head { display: flex; align-items: center; gap: 8px; font-size: .8em; opacity: .7; }
  .plutonium-notifications .icon { width: 16px; height: 16px; object-fit: contain; border-radius: 3px; }
  .plutonium-notifications .app { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .plutonium-notifications .close { all: unset; padding: 0 4px; font-size: 1.2em; line-height: 1; opacity: .8; }
  .plutonium-notifications .summary { font-weight: 600; overflow-wrap: anywhere; }
  .plutonium-notifications .body { opacity: .85; white-space: pre-line; overflow-wrap: anywhere; max-height: 6lh; overflow: hidden; }
  .plutonium-notifications .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
  .plutonium-notifications .actions button { font: inherit; }
}`;

let notificationStyle = null;
function ensureNotificationStyle() {
  if (notificationStyle) return;
  ensureDialogStyle();
  notificationStyle = document.createElement("style");
  notificationStyle.textContent = NOTIFICATION_STYLE;
  document.head.append(notificationStyle);
}

// The library's prompt for a desktop service's request ("system_request"):
// a dialog in the middle of the screen, from the request's detail (title,
// message, a code to compare or type, fields, acceptLabel). It answers with
// the fields' values ({} for a yes), or null; the service can take it back.
class SystemPrompt {
  constructor(shell, request) {
    ensureDialogStyle();
    if (!systemPromptStyle) {
      systemPromptStyle = document.createElement("style");
      systemPromptStyle.textContent = SYSTEM_PROMPT_STYLE;
      document.head.append(systemPromptStyle);
    }
    const { detail } = request;
    const element = document.createElement("form");
    element.className = "plutonium-dialog plutonium-system-prompt";
    element.popover = "manual";
    element.setAttribute("role", "dialog");
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = detail.title ?? "";
    element.append(title);
    if (detail.message) {
      const message = document.createElement("div");
      message.className = "message";
      message.textContent = detail.message;
      element.append(message);
    }
    if (detail.code) {
      const code = document.createElement("div");
      code.className = "code";
      code.textContent = detail.code;
      element.append(code);
    }
    const inputs = [];
    for (const field of detail.fields ?? []) {
      const label = document.createElement("label");
      const text = document.createElement("span");
      text.textContent = field.label ?? field.name;
      const input = document.createElement("input");
      input.name = field.name;
      input.type = field.type === "password" ? "password" : "text";
      if (field.type === "number") input.inputMode = "numeric";
      input.value = field.value ?? "";
      input.autocomplete = "off";
      label.append(text, input);
      element.append(label);
      inputs.push(input);
    }
    const buttons = document.createElement("div");
    buttons.className = "buttons";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    buttons.append(cancel);
    // A code shown to type on the device has nothing to accept: it goes when the pairing ends.
    if (request.kind !== "display") {
      const accept = document.createElement("button");
      accept.className = "default";
      accept.textContent = detail.acceptLabel ?? "OK";
      buttons.append(accept);
    }
    element.append(buttons);
    const close = (answer) => {
      element.remove();
      request.answer(answer);
    };
    cancel.onclick = () => close(null);
    element.onsubmit = (event) => {
      event.preventDefault();
      if (request.kind === "display") return;
      close(Object.fromEntries(inputs.map((input) => [input.name, input.value])));
    };
    element.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close(null);
    });
    request.signal.addEventListener("abort", () => element.remove());
    document.body.append(element);
    element.showPopover();
    (inputs[0] ?? buttons.lastElementChild)?.focus();
  }
}

const SYSTEM_PROMPT_STYLE = `@layer plutonium {
  .plutonium-system-prompt { inset: 50% auto auto 50%; transform: translate(-50%, -50%); width: min(360px, calc(100vw - 16px));
    display: grid; gap: 10px; }
  .plutonium-system-prompt .title { font-weight: 600; font-size: 1.1em; overflow-wrap: anywhere; }
  .plutonium-system-prompt .message { opacity: .8; }
  .plutonium-system-prompt .code { font-size: 2em; letter-spacing: .15em; text-align: center; font-variant-numeric: tabular-nums; }
  .plutonium-system-prompt label { display: grid; gap: 4px; }
  .plutonium-system-prompt input { font: inherit; padding: 5px 7px; }
  .plutonium-system-prompt .buttons { display: flex; justify-content: flex-end; gap: 8px; }
  .plutonium-system-prompt button { font: inherit; }
}`;

let systemPromptStyle = null;

// The screenshot UI: the frozen output under a shade; dragging selects a
// region, a click picks the target under the pointer, Enter or Space the
// whole output, Escape cancels.
class AreaSelector {
  constructor(png, targets) {
    ensureCaptureStyle();
    this.png = png;
    this.targets = targets;
  }

  choose() {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(this.png);
      const element = document.createElement("div");
      element.className = "plutonium-area-selector";
      element.tabIndex = -1;
      element.style.backgroundImage = `url("${url}")`;
      const shade = document.createElement("div");
      shade.className = "shade";
      const highlight = document.createElement("div");
      highlight.className = "target";
      highlight.hidden = true;
      const region = document.createElement("div");
      region.className = "region";
      region.hidden = true;
      const help = document.createElement("div");
      help.className = "help";
      help.textContent = "Drag to select · click a window · Enter for the whole screen · Esc to cancel";
      element.append(shade, highlight, region, help);
      // Above everything the page has, popovers included.
      element.popover = "manual";
      document.body.append(element);
      element.showPopover();
      element.focus();

      const scale = window.devicePixelRatio || 1;
      let start = null;
      const done = (choice) => {
        element.remove();
        URL.revokeObjectURL(url);
        resolve(choice);
      };
      const targetAt = (x, y) =>
        [...this.targets].reverse().find(({ rect }) => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom);
      const place = (box, rect) => {
        Object.assign(box.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
        box.hidden = false;
      };
      element.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        element.setPointerCapture(event.pointerId);
        start = { x: event.clientX, y: event.clientY };
      });
      element.addEventListener("pointermove", (event) => {
        if (!start) {
          const target = targetAt(event.clientX, event.clientY);
          shade.hidden = false;
          if (target) place(highlight, target.rect);
          else highlight.hidden = true;
          return;
        }
        const left = Math.min(start.x, event.clientX);
        const top = Math.min(start.y, event.clientY);
        highlight.hidden = true;
        shade.hidden = true;
        place(region, { left, top, width: Math.abs(event.clientX - start.x), height: Math.abs(event.clientY - start.y) });
      });
      element.addEventListener("pointerup", (event) => {
        if (!start) return;
        const width = Math.abs(event.clientX - start.x);
        const height = Math.abs(event.clientY - start.y);
        if (width < 4 && height < 4) {
          // A click: the target under it, else nothing.
          const target = targetAt(event.clientX, event.clientY);
          start = null;
          region.hidden = true;
          shade.hidden = false;
          if (target) done({ target });
          return;
        }
        const left = Math.min(start.x, event.clientX);
        const top = Math.min(start.y, event.clientY);
        done({
          region: {
            x: Math.round(left * scale),
            y: Math.round(top * scale),
            width: Math.max(1, Math.round(width * scale)),
            height: Math.max(1, Math.round(height * scale)),
          },
        });
      });
      element.addEventListener("keydown", (event) => {
        event.preventDefault();
        if (event.key === "Escape") done(null);
        if (event.key === "Enter" || event.key === " ") done({});
      });
    });
  }
}

// The color picker: the frozen output, a swatch with the color under the
// pointer, a click to take it.
class ColorPicker {
  constructor(png) {
    ensureCaptureStyle();
    this.png = png;
  }

  async choose() {
    const bitmap = await createImageBitmap(this.png);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return new Promise((resolve) => {
      const url = URL.createObjectURL(this.png);
      const element = document.createElement("div");
      element.className = "plutonium-area-selector plutonium-color-picker";
      element.tabIndex = -1;
      element.style.backgroundImage = `url("${url}")`;
      const swatch = document.createElement("div");
      swatch.className = "swatch";
      swatch.hidden = true;
      const chip = document.createElement("i");
      const label = document.createElement("span");
      swatch.append(chip, label);
      const help = document.createElement("div");
      help.className = "help";
      help.textContent = "Click to pick a color · Esc to cancel";
      element.append(swatch, help);
      element.popover = "manual";
      document.body.append(element);
      element.showPopover();
      element.focus();

      // The screenshot is in pixels, the page in CSS pixels.
      const colorAt = (x, y) => {
        const px = Math.min(canvas.width - 1, Math.max(0, Math.floor((x * canvas.width) / window.innerWidth)));
        const py = Math.min(canvas.height - 1, Math.max(0, Math.floor((y * canvas.height) / window.innerHeight)));
        const [r, g, b] = context.getImageData(px, py, 1, 1).data;
        return [r, g, b];
      };
      const done = (color) => {
        element.remove();
        URL.revokeObjectURL(url);
        resolve(color);
      };
      element.addEventListener("pointermove", (event) => {
        const color = colorAt(event.clientX, event.clientY);
        const hex = `#${color.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
        chip.style.background = hex;
        label.textContent = hex;
        swatch.hidden = false;
        // Beside the pointer, kept on the screen.
        const left = Math.min(event.clientX + 16, window.innerWidth - swatch.offsetWidth - 4);
        const top = Math.min(event.clientY + 16, window.innerHeight - swatch.offsetHeight - 4);
        Object.assign(swatch.style, { left: `${left}px`, top: `${top}px` });
      });
      element.addEventListener("pointerdown", (event) => {
        if (event.button === 0) done(colorAt(event.clientX, event.clientY));
      });
      element.addEventListener("keydown", (event) => {
        event.preventDefault();
        if (event.key === "Escape") done(null);
      });
    });
  }
}

// The library's binding dialog for global shortcuts: what the app wants each
// key for, the key it proposes (or none), a button to press another, then
// Allow (the keys as shown) or Don't allow.
class ShortcutBinder {
  constructor(shell, request) {
    ensureCaptureStyle();
    this.shell = shell;
    this.request = request;
    this.shortcuts = (request.shortcuts ?? []).map((shortcut) => ({ ...shortcut }));
  }

  ask() {
    return new Promise((resolve) => {
      const element = document.createElement("div");
      element.className = "plutonium-dialog plutonium-shortcut-binder";
      element.popover = "manual";
      element.setAttribute("role", "dialog");
      element.style.left = "50%";
      element.style.top = "50%";
      element.style.transform = "translate(-50%, -50%)";
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = `${this.request.appName || "An app"} wants keyboard shortcuts`;
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = "They work whatever has the keyboard. Click a key to change it.";
      const list = document.createElement("div");
      list.className = "shortcuts";
      let capturing = null;
      const giveBack = this.shell._takeKeyboard();
      const label = (shortcut) => (shortcut.combo ? describeCombo(shortcut.combo) : "None");
      for (const shortcut of this.shortcuts) {
        const row = document.createElement("div");
        row.className = "row";
        const text = document.createElement("span");
        text.textContent = shortcut.description;
        const key = document.createElement("button");
        key.className = "key";
        key.textContent = label(shortcut);
        key.onclick = () => {
          capturing?.button && (capturing.button.textContent = label(capturing.shortcut));
          capturing = { shortcut, button: key };
          key.textContent = "Press a key…";
          element.focus();
        };
        row.append(text, key);
        list.append(row);
      }
      const buttons = document.createElement("div");
      buttons.className = "buttons";
      const refuse = document.createElement("button");
      refuse.textContent = "Don't allow";
      const allow = document.createElement("button");
      allow.className = "default";
      allow.textContent = "Allow";
      buttons.append(refuse, allow);
      element.tabIndex = -1;
      element.append(title, hint, list, buttons);
      const onKey = (event) => {
        if (!capturing) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return;
        if (event.key === "Escape") {
          capturing.button.textContent = label(capturing.shortcut);
          capturing = null;
          return;
        }
        capturing.shortcut.combo =
          `${event.ctrlKey ? "Ctrl+" : ""}${event.altKey ? "Alt+" : ""}${event.shiftKey ? "Shift+" : ""}${event.metaKey ? "Super+" : ""}${event.code}`;
        capturing.button.textContent = label(capturing.shortcut);
        capturing = null;
      };
      // Before the page's own keys and the bound ones.
      this.shell._bindingShortcuts = true;
      addEventListener("keydown", onKey, true);
      const finish = (answer) => {
        removeEventListener("keydown", onKey, true);
        this.shell._bindingShortcuts = false;
        element.remove();
        giveBack();
        resolve(answer);
      };
      refuse.onclick = () => finish(null);
      allow.onclick = () => finish({ shortcuts: this.shortcuts.map(({ id, combo }) => ({ id, combo })) });
      document.body.append(element);
      element.showPopover();
      this.shell.showShell();
      allow.focus();
    });
  }
}

/** How a combo reads: "Ctrl+Alt+P". */
function describeCombo(combo) {
  const parts = combo.split("+");
  const code = parts.pop() ?? "";
  const key = /^Key([A-Z])$/.exec(code)?.[1] ?? /^Digit([0-9])$/.exec(code)?.[1] ?? code;
  return [...parts, key].join("+");
}
