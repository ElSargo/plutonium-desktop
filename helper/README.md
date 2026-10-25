# Plutonium helper (`plutoniumd`)

The frontend-neutral part of a Plutonium shell. A frontend (T3 Code, the plain shell in `shells/plain/`, anything else) only adds UI on top of it. Node 24+, no dependencies; run the `.ts` files directly.

What it does:
- **Thread environment.** Gives each thread's processes the variables that bind their windows to it: `PLUTONIUM_THREAD_ID`, Exo's `WAYLAND_DISPLAY`, toolkit backends, `PLUTONIUM_HELPER` (this socket), and `DISPLAY` for a per-thread rootless Xwayland (xwayland-satellite, started on the first X client). The X servers outlive the helper: a restarted helper takes them over (the map is in `<socket dir>/<wayland display>.x-displays.json`), so apps started before keep a working `DISPLAY`, and one that ended is started again on the same display while the thread's processes still use it. `plutonium stop` stops them. Electron apps run on Wayland: `ELECTRON_OZONE_PLATFORM_HINT=wayland` for older Electron, `XDG_SESSION_TYPE=wayland` for 38 and later, which ignore the hint. Processes the user started (a terminal, a launcher) also get `PLUTONIUM_SHOW=1`, and frontends bring their windows and links to the front; an agent's don't, so what they open waits in the thread. An agent can opt in with `PLUTONIUM_SHOW=1 <command>`, or `focus: true` on `launch_app` and `open_tab`.
- **pid → thread.** Reads `/proc/<pid>/environ`, walking up parent pids, to say which thread a window's client belongs to, and whether it asked to be shown. Some apps blank their environment there (Electron 43 does, for its process title), so the helper also remembers the processes it launched, while they run.
- **Launching apps** into a thread, optionally waiting for the app's window.
- **Links from apps open as tabs in the thread.** `xdg-open`, `$BROWSER` and the user's default browser lead to `plutonium.ts open` (`src/opener.ts`, `docs/features/OPENING_LINKS.md`).
- **Agent bridge.** A thread's agent can list, launch, snapshot, focus and close its own windows, and open, navigate, snapshot, focus and close its own browser tabs (and answer their dialogs). The helper relays these to the shell page, which holds the window broker. Agents reach it through `plutonium.ts mcp`, a stdio MCP server.
- **The backup terminal.** A page (`/v1/terminal/`) with tabs of login shells on this machine, for Ash's switcher to open when no shell works (`src/terminal.ts`, `src/ptybridge.py`, `web/terminal/`, xterm.js in `web/vendor/xterm/`). Each session is `$SHELL` on a pty, made by Python's `pty` module, in the thread `plutonium:terminal`. Needs `python3`.
- **The desktop portal's screen capture and global shortcuts.** `org.freedesktop.impl.portal.ScreenCast` and `Screenshot` for apps (OBS, Firefox, Discord), through the browser's capture API: the focused shell (else Ash) asks the user, Ash publishes a PipeWire node. `Screenshot.PickColor`: the focused shell's picker. `GlobalShortcuts`: the focused shell binds the keys, every shell catches them. `FileChooser` (`OpenFile`, `SaveFile`, `SaveFiles`): the focused shell's file picker, the one tabs use, over the app's window (`src/portal.ts`, `src/shortcuts.ts`, `src/fileChooser.ts`, `portal/`, `docs/features/CAPTURE.md`, `docs/features/TAB_FEATURES.md`). On `$PLUTONIUM_PORTAL_BUS`, else the session bus; `PLUTONIUM_PORTAL=0` turns it off.
- **Server-driven tabs.** A frontend's server can drive the tabs the shell shows for it over the DevTools protocol, as T3 Code drives its desktop app's tabs with Playwright (`src/serverTabs.ts`, `docs/features/TABS.md`). The helper connects to the browser's own DevTools (`--cdp-port`) and gives the server one relay per tab, which reaches that tab's page and nothing else.

## Running

```
node helper/plutonium.ts daemon --shell-origin http://127.0.0.1:3773[,<origin>…] \
  [--wayland-display wayland-plutonium] [--port 3780] [--cdp-port 9224]
```

`--cdp-port` is the browser's `--remote-debugging-port`; without it there are no server-driven tabs. `PLUTONIUM_DEBUG_TABS=1` logs their traffic.

`/v1/shell.js` is `web/plutonium-shell.js`, or the file in `PLUTONIUM_SHELL_LIBRARY` (a session sets it to its live one, `plutonium live`), read on every request.

A session can have several shells (`docs/features/SHELLS.md`): `--shell-origin` takes all their origins, comma-separated.

`plutonium run` starts it with Ash (DRM sessions on port 3782, X11 ones on 3781). X11 apps need `xwayland-satellite` on `PATH` or in `PLUTONIUM_XWAYLAND_SATELLITE`, plus `systemd-socket-activate`.

Tests: `npm test` here (`docs/DEVELOPING.md`, "Helper tests").

Other commands:

| Command | What |
|---|---|
| `plutonium.ts thread-setup <thread>` | JSON `{env, mcpServer}` for a thread's processes |
| `plutonium.ts launch <thread> <program> [args…]` | start an app in a thread, wait for its window |
| `plutonium.ts mcp` | the agent bridge as an MCP server (reads `PLUTONIUM_THREAD_ID` and `PLUTONIUM_HELPER`) |
| `plutonium.ts open <url\|file>…` | `xdg-open` for a thread's processes: web links become tabs in `$PLUTONIUM_THREAD_ID`, anything else goes to the real `xdg-open` |

Clients find the socket in `$PLUTONIUM_HELPER`, else `$XDG_RUNTIME_DIR/plutonium/<wayland-display>.sock`.

## Listeners and access

- **Unix socket** (`$XDG_RUNTIME_DIR/plutonium/<wayland-display>.sock`, mode 0600) for local processes: the frontend's server and agents.
- **`127.0.0.1:<port>`** for the shell page. Apart from `GET /v1/shell.js`, a request is only served if both hold:
  - its `Origin` is one of the shell origins, which blocks other pages in the browser;
  - the connecting socket belongs to this user (checked in `/proc/net/tcp`), which blocks other users on the machine.

An agent's thread is whatever `PLUTONIUM_THREAD_ID` its MCP server process has. Agents only reach windows and tabs tagged with that thread (see Tags below). That's as strong as the thread tagging itself: a process can copy the variable.

## Tags

Every window and tab carries a list of tags (`docs/features/SHELLS.md`). The first is its origin, and never changes:
- for a window, the `PLUTONIUM_THREAD_ID` of its client, or of the nearest ancestor that has one; the browser reads it from `/proc`;
- for a tab, the thread it was created for, which tabs its page opens inherit.

Shells add and remove the others, for example to bring an item from another shell into a thread. When the browser can't read a client's environment (Ash in a container with its own user namespace), the library names the origin once from `GET /v1/window-threads`. The helper can't change tags, and neither can agents. A thread's id is its tag, and an agent reaches every item that carries it. Shells describe their tags as groups (label, owning shell), and the helper sends a thread's requests to the shell that owns its group.

## HTTP API

Shared (socket and shell):

| Request | Answer |
|---|---|
| `GET /v1/status` | Wayland display, shell origins, the connected shells (`shells`: origin, shell id, visible), and `gpu`: `{dmabufVersion, renderNode, accelerated}`, what Exo tells GL/Vulkan apps (null until Exo is up). Not `accelerated` means apps render in software; the helper also logs a warning |
| `GET /v1/thread-setup?thread=<id>` | `{env, terminalEnv, mcpServer: {command, args}}`: `env` for the thread's agents, `terminalEnv` (with `PLUTONIUM_SHOW=1`) for terminals the user types in |
| `GET /v1/window-threads?pids=1,2` | `{"<pid>": "<thread>"}`, untagged pids left out (for browsers without tags) |
| `GET /v1/window-shows?pids=1,2` | `{"<pid>": true}` for pids whose thread-tagged process (itself, or the nearest ancestor) has `PLUTONIUM_SHOW` |
| `POST /v1/launch {thread, argv, cwd?, waitMs?, show?}` | `{pid, windows}`; `windows` are the thread's new windows, if any appeared within `waitMs`. `show: true` sets `PLUTONIUM_SHOW` |
| `GET /v1/apps` | launchable desktop apps (`.desktop` entries from the XDG data dirs): `{id, name, genericName, comment, keywords, categories, hasIcon, terminal}`, by name |
| `GET /v1/apps/<id>/icon` | the app's icon (SVG or PNG; themes `PLUTONIUM_ICON_THEME`, breeze, hicolor, Adwaita) |
| `POST /v1/apps/launch {thread, id, waitMs?, show?}` | starts the app in the thread, as `/v1/launch` (`Terminal=true` apps in `$TERMINAL` or foot); shown unless `show: false` |
| `GET /v1/printers?title=` | the host's printers through CUPS (`lpstat`): `{available, printers: [{name, description, state, isDefault}], error?, defaultPdfPath}` (`~/Downloads/<title>.pdf`) |
| `POST /v1/print?printer&copies&duplex&color&title` (a PDF body) | prints it with `lp`: `{job}`; `duplex` none, long-edge or short-edge, `color` 1 or 0 |
| `POST /v1/screenshots` (a PNG body) | writes it to `~/Pictures/Screenshots/Screenshot from <date> <time>.png` (`$PLUTONIUM_SCREENSHOTS_DIR`): `{path}` |
| `POST /v1/print/save?path&title&overwrite` (a PDF body) | writes it (absolute or `~/` path, default `defaultPdfPath`) without overwriting unless `overwrite=1`: `{path}` |

The backup terminal. Its page and scripts (`GET /v1/terminal/`, `terminal.js`, `terminal.css`, `xterm.js`, `xterm.css`, `addon-fit.js`) are public and can't be framed. Its sessions are for the socket, or for this user's same-origin requests on the port: `Sec-Fetch-Site: same-origin`, which other pages can't send.

| Request | Answer |
|---|---|
| `GET /v1/terminal/sessions` | `[{id, alive, createdAt}]` |
| `POST /v1/terminal/sessions {rows, cols}` | `{id}`: a new session (at most 32) |
| `GET /v1/terminal/sessions/<id>/stream` | EventSource: `data` events (JSON strings of output, the scrollback first, up to 512 K characters), then `exit` (the status) |
| `POST /v1/terminal/sessions/<id>/input` | the body, as typed |
| `POST /v1/terminal/sessions/<id>/resize {rows, cols}` | |
| `POST /v1/terminal/sessions/<id>/close` | hangs up |

A session nobody watches for 30 s is hung up.

Socket only (the agent bridge; `<thread>` is the caller's thread):

| Request | Answer |
|---|---|
| `GET /v1/threads/<thread>/windows` | the thread's windows: `{id, title, appId, width, height, shown, focused}` |
| `GET /v1/threads/<thread>/windows/<id>/snapshot` | `image/png` of the window, even while hidden |
| `POST /v1/threads/<thread>/windows/<id>/focus` | `{how}`: shown in the shell (the frontend's `onFocus`), or popped out to the desktop |
| `POST /v1/threads/<thread>/windows/<id>/close` | `{closed}` after asking the app to close (waits up to 3 s) |
| `GET /v1/threads/<thread>/tabs` | the thread's browser tabs: `{id, url, title, loading, canGoBack, canGoForward, shown, focused, openerId, dialog?}` |
| `POST /v1/threads/<thread>/tabs {url, focus?, waitMs?}` | opens a tab for the thread (shown unless `focus: false`), waits for it to load |
| `POST /v1/threads/<thread>/tabs/<id>/navigate {url, waitMs?}` | loads a URL in the tab |
| `POST /v1/threads/<thread>/tabs/<id>/{back,forward,reload,stop} {waitMs?}` | |
| `POST /v1/threads/<thread>/tabs/<id>/dialog {accept, text?}` | answers the page's pending dialog |
| `POST /v1/threads/<thread>/tabs/<id>/{focus,close}` | shows the tab in the shell (the frontend's `onFocusTab`) / closes it |
| `GET /v1/threads/<thread>/tabs/<id>/snapshot` | `image/png` of the page, even while hidden |
| `POST /v1/threads/<thread>/windows/<id>/input {action, ...}` | input for the window (needs the browser's Plutonium domain, else 501): `move`, `click {x, y, button?, count?}`, `drag {from, to}`, `scroll {x, y, dx?, dy?}`, `type {text}`, `press {keys}`, `resize {width, height}`; points in snapshot pixels |
| `POST /v1/threads/<thread>/tabs/<id>/page {action, ...}` | Playwright on the tab: `snapshot` (`{url, title, snapshot}`), `click`, `hover`, `type`, `select`, `press`, `scroll`, `evaluate`, `wait_for`; elements by `ref` or `selector`; Playwright's errors are 409 |
| `GET /v1/mcp/tools?set=windows` | the MCP tools (`windows`: only the window tools), for a frontend's own MCP server |
| `POST /v1/threads/<thread>/mcp/call {name, arguments}` | runs an MCP tool for the thread: `{content, isError?}` |

Socket only, for server-driven tabs: `GET /v1/desktop-browser` with `Upgrade: plutonium-desktop-browser` turns the connection into T3 Code's desktop browser channel, newline-delimited JSON both ways. The helper sends `{type: "attached" | "detached", threadId, tabId}` as the shell shows or stops showing the server's tabs (all attached tabs first), and `{type: "cdp", threadId, tabId, message}` for each relay message. The server sends `cdp` (a DevTools message for that tab), `release` (it stopped driving the tab), `pointer` (`{phase: "move" | "click", x, y}`: where its next action lands, for the shell to draw), `open` (`{tag}`: no page shows the tab, so the helper opens one tagged `tag` and attaches it itself) and `close` (the tab's preview closed; the helper closes a tab it opened). `threadId` and `tabId` are the server's names. One server at a time: a new connection replaces the old one.

Shell only: `GET /v1/shell.js` (the library), `GET /v1/shell/requests?page=<id>&shell=<shell id>&visible=<0|1>` (EventSource of bridge requests), `POST /v1/shell/replies/<id>`, `POST /v1/shell/pages/<id>/visibility {visible}`, `POST /v1/shell/origins {origins}` (the browser's shell origins, which shell pages report so that shells added at runtime get in), `POST /v1/shell/server-tabs {page, threadId, tabId, browserTabId, targetId, url?, title?}` → `{browserTabId}` (the tab to show: another page's, if one shows the server's tab already) and `POST /v1/shell/server-tabs/detach {page, threadId, tabId}`.

With several shells connected, each page has its own stream (`page` is an id the library picks; a reconnect with the same id replaces it). A thread's requests go to the shell that owns the thread's group, if it's connected. Anything else goes to the visible page, else the one visible most recently. When the owner shows what an agent asked for, the library makes that shell the visible one.

## Shell library (`web/plutonium-shell.js`)

Load it from the helper in the shell page:

```js
const { connect } = await import("http://127.0.0.1:3780/v1/shell.js");
const shell = connect({
  // An agent asked to show one of its windows. Return true if the UI did.
  onFocus: (window) => { openTab(window.threadId, window.id); return true; },
});
shell.addEventListener("change", render);
shell.windowsOf(threadId);   // windows tagged threadId: { …NativeWindowEntry, tag, tags, threadId }
shell.untaggedWindows();
await shell.grantFor(id);    // for <native-window grant=…>
shell.showOnDesktop(id); shell.close(id); await shell.snapshot(id);
await shell.launch(threadId, ["foot"], { waitMs: 8000, show: true });  // show: the user's (default false)
await shell.apps();                      // desktop apps; shell.appIcon(id) → object URL
await shell.launchApp(threadId, "foot.desktop");  // shown unless { show: false }
// A window that appears after connecting, once its thread is known. show: its process has
// PLUTONIUM_SHOW (the user started it), so bring it to the front; else maybe just say so.
shell.addEventListener("windowopened", (event) => { const { window, show } = event.detail; });
shell.addEventListener("tabopened", (event) => event.detail.tab);  // a tab that appears after connecting
shell.setShellShortcuts(["Alt+Digit1", "Ctrl+KeyT"]);  // keys this page keeps while an app or tab has focus
// Chrome's context menus (this page's and its tabs') are drawn here, styled with
// --plutonium-menu-bg, -fg, -border, … (docs/features/CHROME_UI.md). connect({ contextMenu: false })
// leaves them to Chrome; contextMenu: (request) => true draws them, then
// shell.closeContextMenu(request.menuId, itemId).

// Browser tabs (Chromium with the tab broker; shell.tabsAvailable):
const tab = await shell.createTab(threadId, "example.com");
stage.append(shell.tabElement(tab.id));   // <embed type="application/x-chromium-surface-embed">
shell.tabsOf(threadId);                  // { id, url, title, loading, dialogType, … }
shell.navigateTab(id, url); shell.tabCommand(id, "back"); shell.answerTabDialog(id, true);
await shell.snapshotTab(id);
// connect({ onFocusTab: (tab) => { showTab(tab); return true; } }) for agents' focus_tab.
// connect({ onOpenTab: (tab) => currentThreadId }): a link this page opened in a new tab or
// window (Ctrl+click, target=_blank, window.open) arrives untagged; return its thread, and it is
// tagged and shown with onFocusTab.

// Server-driven tabs: the frontend's server drives a tab this page shows for it. Resolves to the
// browser tab to show (another shell page's, if it shows that server tab already).
const shownId = await shell.showServerTab(tab.id, { threadId, tabId });  // the server's names
await shell.releaseServerTab({ threadId, tabId });
shell.addEventListener("agentpointer", (event) => drawCursor(event.detail));  // {threadId, tabId, phase, x, y}

// Captures (shell.captureAvailable; docs/features/CAPTURE.md):
const png = await shell.screenshot({ type: "window", id });       // also { type: "output", id }, { type: "tab", id }, region
const stream = await shell.capture({ type: "window", id }, { size: { width: 1920, height: 1080 } });  // a MediaStream
await shell.takeScreenshot({ targets: [{ source, rect }] });     // the Print UI; saves to ~/Pictures/Screenshots
await shell.pickColor();                                          // [r, g, b] from a frozen screen, null on Escape (the portal's PickColor)
shell.captures(); shell.stopCapture(captureId);                  // every consumer's: "capturestart", "capturestop" events
// connect({ capturePicker, captureIndicator }): apps' and tabs' requests, and what's captured (library's by default).
// connect({ fileChooser }): tabs' file pickers and apps' (the FileChooser portal; request.source = {appId, pid, windowId, name})

// Tags and groups (shell.tagsAvailable):
shell.setGroups([{ tag: "plain:thread/abc", label: "Fix the build" }]);  // this shell's
shell.groups;                            // Map tag → { tag, label, shellId }, every shell's
shell.labelOf(tag);
shell.elsewhere(myTags);                 // { windows, tabs } that carry none of myTags
await shell.tagWindow(id, ["plain:thread/abc"]);   // brings it into the thread
await shell.tagTab(id, [], ["plain:thread/abc"]);  // takes it out (not its origin tag)
shell.shellId; shell.showShell();
```

It keeps the window, tab and group lists from `navigator.windowBroker` events and answers the helper's bridge requests with the broker. With an older browser that has no tags, it asks the helper for each window's thread instead.

## MCP tools

Windows: `list_windows`, `launch_app {argv, cwd?, wait_seconds?, focus?}`, `snapshot_window {window_id}` (image content), `focus_window {window_id}`, `close_window {window_id}`, and, with a browser that has the Plutonium DevTools domain, `click_window {window_id, x, y, button?, count?}`, `hover_window {window_id, x, y}`, `drag_window {window_id, from, to, button?}`, `scroll_window {window_id, x, y, dy?, dx?}`, `type_window {window_id, text}`, `press_window {window_id, keys}` and `resize_window {window_id, width, height}`. Points are `snapshot_window`'s pixels.

Tabs: `list_tabs`, `open_tab`, `snapshot_tab`, `navigate_tab`, `tab_action`, `answer_dialog`, `choose_files {paths}` (a pending file picker), `focus_tab`, `close_tab`, `list_printers`, `print_tab {printer?, save_to?, copies?, duplex?, color?, paper?, landscape?, scale?, margins?, background?, header_footer?, page_ranges?}` (finishes a print the page waits on), `cancel_print`, and (Playwright) `read_tab {tab_id}` (the page as an accessibility tree with `[ref=eN]`), `click_tab`, `hover_tab`, `type_tab {text, submit?, slowly?}`, `press_tab {key}`, `select_tab {values}`, `scroll_tab`, `evaluate_tab {expression}` and `wait_for_tab {text? | text_gone? | selector? | load?}`, each element by `ref` or `selector`.

What an agent launches or opens waits in its thread unless it passes `focus: true` (`launch_app`, `open_tab`). See [docs/features/AGENT_CONTROL.md](../docs/features/AGENT_CONTROL.md).

For example, Claude Code:

```
claude --mcp-config '{"mcpServers":{"plutonium":{"type":"stdio","command":"node","args":["…/helper/plutonium.ts","mcp"]}}}'
```

It must run as one of the thread's processes, i.e. with the thread environment.
