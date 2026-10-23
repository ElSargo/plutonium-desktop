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
 * @typedef {{ id: number, width?: number, height?: number, userControl: boolean, busy: boolean }} AgentWindow
 *   width, height: the size an agent holds it at (absent once the user took control, or if
 *   it never held one); busy: an agent gave it input in the last few seconds.
 * @typedef {{ id: string, name: string, url: string, origin: string, enabled: boolean,
 *   running: boolean, visible: boolean }} ShellEntry
 *   One of the browser's shells (several live at once; one is visible).
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
 *   [feature: string]: any }} ConnectOptions
 *   onOpenTab: a link this page opened in a new tab or window (Ctrl+click, target=_blank,
 *   window.open) arrived as a tab, untagged. Return the thread to put it in (it is then tagged
 *   and shown with onFocusTab), or nothing to leave it alone.
 *   contextMenu: false leaves Chrome's context menus to Chrome. A function draws them itself:
 *   it returns true if it shows `request`, then answers with closeContextMenu(menuId, itemId).
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
    // Tab features' requests (TAB_FEATURES.md).
    if (typeof this.broker.answerTabRequest === "function") {
      this.broker.addEventListener("tabrequest", (event) => this._onTabRequest(event));
      this.broker.addEventListener("tabrequestend", (event) => {
        const controller = this._tabRequests.get(event.requestId);
        this._tabRequests.delete(event.requestId);
        controller?.abort();
      });
    }
    // Chrome's context menus, drawn in this page's style.
    if (typeof this.broker.closeContextMenu === "function") {
      this.broker.addEventListener("contextmenurequest", (event) => this._onContextMenuRequest(event));
    }
    this._serveBridge();
    const windows = await this.broker.getWindows();
    for (const entry of windows) this._setWindow(entry);
    this._live = true;
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
    }
  }

  /** The element in this page that shows tab `tabId` now, if any. */
  shownTabElement(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab?.contentId) return null;
    return document.querySelector(`embed[data-content-id="${CSS.escape(tab.contentId)}"]`);
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
        return { result: await this.tabCommand(args.tabId, args.command, args.args) };
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
 * after `title`. An existing file isn't overwritten: the name gets " (1)", " (2)", ...
 * @param {Blob} pdf
 * @returns {Promise<{ path: string }>}
 */
PlutoniumShell.prototype.savePdf = async function (pdf, { path = "", title = "" } = {}) {
  const query = new URLSearchParams();
  if (path) query.set("path", path);
  if (title) query.set("title", title);
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
    this._build();
    request.signal.addEventListener("abort", () => this.close());
    this._loadPrinters();
    this._render();
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
        <label class="field" data-for="pdf">Save to <input name="path" spellcheck="false"></label>
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
    this.form.path.value = `~/Downloads/${fileNameOf(this.title)}`;
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
    const box = this.shell.shownTabElement(this.request.tabId)?.getBoundingClientRect();
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
      if (defaultPdfPath && !this._pathEdited) this.form.path.value = defaultPdfPath;
      const select = this.form.destination;
      for (const printer of printers) {
        const option = document.createElement("option");
        option.value = printer.name;
        option.textContent = printer.description || printer.name;
        if (printer.state === "disabled") option.disabled = true;
        select.append(option);
      }
      const preferred = printers.find((printer) => printer.isDefault && printer.state !== "disabled");
      if (preferred) select.value = preferred.name;
      if (!available && error) console.info(`plutonium: no printers (${error})`);
      this._showDestination();
    } catch (error) {
      console.warn("plutonium: listing printers", error);
    }
  }

  _changed(target) {
    if (target === this.form.path) this._pathEdited = true;
    if (target === this.form.destination) return this._showDestination();
    if (target === this.form.pages) {
      this.form.querySelector('[data-for="custom"]').hidden = this.form.pages.value !== "custom";
    }
    if (["copies", "duplex", "color", "path"].includes(target.name)) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._render(), 300);
  }

  _showDestination() {
    const printing = !!this.form.destination.value;
    for (const field of this.form.querySelectorAll('[data-for="printer"]')) field.hidden = !printing;
    this.form.querySelector('[data-for="pdf"]').hidden = printing;
    this.form.go.textContent = printing ? "Print" : "Save";
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
    this.status.textContent = printer ? "Printing…" : "Saving…";
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
        const { path } = await this.shell.savePdf(pdf, { path: this.form.path.value.trim(), title: this.title });
        message = `Saved ${path}`;
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

  cancel() {
    if (this.closed) return;
    this.request.answer("cancel");
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
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
