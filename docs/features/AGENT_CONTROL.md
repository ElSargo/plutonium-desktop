# Agents drive windows and tabs (2026-10-19)

An agent in a thread can now use its thread's native apps and browser tabs, not only list, launch, snapshot and close them: click, type, press keys, scroll and drag in a window; read a page as an accessibility tree with element refs, and click, type, select and evaluate in it. This works with any shell, or with no shell page open at all, and it stays compatible with how T3 Code drives its own tabs.

## How it fits together

- **The browser** (patch 0025) has a DevTools domain, `Plutonium` (`chrome/browser/devtools/cros_protocol.pdl`), on its browser target. Only trusted clients get it: the session's `--remote-debugging-port`, which only the helper uses. Pages, extensions and the shells' own tab automation don't. It lists and watches the shells' windows and tabs, opens and drives tabs, captures both, and sends windows input.
- **The helper** is the control plane (`helper/src/desktop.ts`). When the browser has the domain it goes straight to it; with an older browser it asks a shell page, as before, and the new input tools answer 501. Showing something to the user (focus) always goes through the shell, which decides how.
- **Pages** are driven with Playwright (`playwright-core`, the helper's only dependency, installed by `npm ci` when a session starts). Each thread gets a relay (`helper/src/pages.ts`) that looks to Playwright like a browser whose pages are that thread's tabs, on a loopback WebSocket with a secret path (`helper/src/websocket.ts`). `context.newPage()` opens a tab in the thread.
- **Windows** get input straight from Exo (below), in the window's own coordinates: the snapshot's pixels.

## Windows

`EmbeddedWindows::InjectMouseEvent()` and `InjectKeyEvents()` (EXO-AGENT) give a window input whether or not a page shows it, and leave the user alone:

- **Mouse.** The event goes to the deepest surface under the point, like a page's input. Unlike a page's, the parked window isn't moved and doesn't get focus. Wheel deltas are notches (120 per notch).
- **Keys.** The user's keyboard focus follows aura focus; the agent's is beside it (patch 0027, below). The keys go through `Seat::DispatchAgentKeyEvent()` with their physical code, so Exo's key tracking and modifiers come out right, and the app maps them through its keymap. Text is typed as a US keyboard would type it (`helper/src/keys.ts`); other characters are refused.
- **Frame rate.** viz slows a frame sink whose frames nothing draws to one frame a second, and a parked window no page shows is never drawn: its app waited up to a second to redraw after input. `EmbeddedWindows::KeepDrawing()` sends frames with `may_throttle_if_undrawn_frames = false`. The helper keeps a window awake (`Plutonium.setWindowAwake`) from the agent's first input until it has been left alone for 60 s, and a window screencast keeps it awake while it runs.
- **Screencast.** `Plutonium.startWindowScreencast` sends frames as the app draws them. A video capturer on the window's frame sink saw no damage, for the same reason, and refreshed only every 200 ms. Instead, each commit is copied as `Snapshot()` does: one copy at a time, at most 30 a second, always including the last frame of a burst (`chrome/browser/plutonium_agent.cc`).
- A window snapshot taken within 200 ms of input waits for the rest of that time, so it shows the app's answer.

## Popups (patch 0060, 2026-10-26)

Menus, context menus and tooltips are `xdg_popup`s: surfaces of their own, which an agent couldn't see or click before.

- **Seen.** `EmbeddedWindows::Snapshot()` copies the window's open popups (`ShellSurfaceBase::GetAgentPopups()`: its popups and theirs, shown on screen or not) as it copies the window, and draws them over it where they are. A menu that goes past the window's right or bottom edge grows the image to hold it; the window's own pixels keep their coordinates. `Plutonium.getWindowPopups` lists them, in the window's coordinates, and `snapshot_window` returns them as `popups`, in its pixels.
- **Used.** An agent's pointer event at a point on a popup goes to the popup's surface (`DoDispatchMouseEvent()`), as the user's would: hover opens a submenu, a click picks an item. An agent press outside every popup closes the ones holding a grab, and their children, as a press outside does for a user (`popup_done`), and goes no further, nor does its release. Keys go to the app, which sends them to its menu, as before.
- **Told.** `click_window`, `press_window`, `act_window` and the other window actions wait 250 ms after the action and return the window's open popups (`popups`, or `"closed"` once they're gone), and the thread's windows that opened (`newWindows`: `new window #9 ("Character", 982×615)`) or closed (`closedWindows`) since the agent last heard of its windows: from an action's result, `list_windows` or `launch_app`. A dialog slower than the wait is named by the next action.

## Agent focus (patch 0027)

Before, the agent's keys borrowed the seat's focus for each batch and gave it back, so the user's app saw `leave` and `enter` around every batch, and an app that moves its own focus after a key only while it's focused didn't: after Enter in Writer's paragraph style box, the text typed next was lost.

Now a client can have its own keyboard focus for the agent beside the user's (`Seat::AddAgentFocus()`, EXO-AGENT). A client none of whose surfaces has the user's focus has its keyboards focus its most recent agent surface: it gets `enter` and stays focused, and the user's app keeps its focus. The user's keys never go there, since real keys follow aura focus and the parked window has none. The agent's key events go only to the target's keyboard (`Seat::agent_key_target()`), and so do its modifier changes. Only when the user's focus is in another window of the same app does the window borrow the seat's focus for a batch, as before.

`InjectKeyEvents()` adds the agent focus for its keys. `EmbeddedWindows::HoldAgentFocus()` keeps it; the helper holds it (`Plutonium.setWindowAgentFocus`) for as long as it keeps the window awake, from the agent's first input until 60 s without any.

## Decorations (patch 0027)

The compositor tells every app not to draw a title bar or borders (EXO-DECOR): a page frames a window it shows, and Ash a window on the desktop.

- **xdg-decoration** (foot, Qt, GTK 4 with it): a new toplevel decoration is configured `server_side` at once, and every `set_mode` and `unset_mode` gets `server_side` back.
- **KDE server-decoration** (`org_kde_kwin_server_decoration_manager`, new in Exo): GTK 3 (LibreOffice, Inkscape, GIMP 2) reads only this. The default mode is server, and every `request_mode` gets server back.

LibreOffice drew its own title bar and close buttons before; it draws none now.

## Finding apps

`launch_app` runs its `argv` with no shell: `argv[0]` is looked up on the helper's PATH. Installed apps often aren't on PATH under their names: a Flatpak is reachable as `flatpak run …` or its app id (`org.libreoffice.LibreOffice`), and a Nix build may not be on PATH at all. So `find_apps {filter?}` lists the apps the user's launcher shows (`helper/src/apps.ts`, the desktop entries in `$XDG_DATA_HOME` and `$XDG_DATA_DIRS`, Flatpak exports included), through `GET /v1/apps/find`. Each has its name, generic name, desktop id, an `argv` ready for `launch_app` (the entry's Exec with its `%f`/`%U` field codes and Flatpak's empty `@@u … @@` dropped; a `Terminal=true` app wrapped in a terminal), its `cwd` if it asks for one, its `source` (`flatpak`, `nix profile`, `system` or `user`) and its desktop file, so two installs of one app can be told apart.

The filter is a case-insensitive regular expression (or plain text, if it isn't one) matched against the name, generic name, keywords, desktop id and Exec: `spreadsheet` finds Calc, `office` LibreOffice. With a filter, `onPath` lists the matching executables on PATH too, separately (they're mostly command-line programs), at most 20, with `moreOnPath` counting the rest.

Every install is listed (2026-10-26): when two desktop files have the same id (the same app in a Nix profile and the system), the launcher shows the first, and the other is listed too, with `launcherShows` naming the first. Apps with no desktop file still aren't listed, except as programs on PATH.

`launch_app` waits up to `wait_seconds` for the app's new windows to appear and then stay the same for a second, and returns the ones open then. A window that closes meanwhile (a splash screen, LibreOffice's document recovery) doesn't end the wait; the helper logs it. An empty list means no window was open when the wait ran out.

When an agent's `launch_app` can't find `argv[0]`, the error says it isn't on PATH, points to `find_apps`, and lists up to three apps `find_apps` gives for its name, with their argv.

## Sizes agents hold

`launch_app` takes a `width` and `height`. The helper holds an agent's windows at that size, or, without one, at the size the app picks (followed while no page shows the window, since apps settle their size after mapping). That includes windows that come after `launch_app` stops waiting (a slow first start, a main window after a splash), for 60 s more. `resize_window` holds the new size, also while a page shows the window. A window the user starts (`focus: true` without a size) isn't held.

The helper tells the shells (`agent_windows` notice; `shell.agentWindows` and `"agentwindowschange"` in the shell library): the held size, and `busy` while an agent gave the window input in the last 4 s. T3 Code shows a held window at its size, scaled down to fit the panel without stretching, behind a lock that says the agent is using it and offers **Take control**. That releases the hold (`shell.releaseWindow()`, `POST /v1/shell/windows/<id>/release`): the panel sizes the window again, and `resize_window` refuses while the panel shows it. An agent working in a window the user controls shows as "Agent working" in its tab's header. `list_windows` gives `agentSize` and `userControl`.

## Which windows are a thread's (2026-10-24)

A window is a thread's when its tags include the thread's tag. The browser tags a new window with `PLUTONIUM_THREAD_ID` from its client's `/proc/<pid>/environ`, walking up its parents (patch 0014). Ash runs in a podman user namespace, so it can't read the environment of processes in other user namespaces: every host app, and every sandboxed one (a Flatpak's bwrap makes its own). For those it logs `EXO-TAGS can't read window #N's client environment` and adds the window untagged. A shell then asks the helper (`/v1/window-threads`) and names the window's origin (`setWindowOriginTag`).

The helper runs on the host, so it can read the sandboxed app's environment, and it knows which processes it started (`rememberLaunch`). The agent tools no longer depend on a shell naming the origin. A window with no tags belongs to the thread that started its client (`threadForPid`, cached per window), in direct (DevTools) mode as well as through a shell. Before, that fallback ran only when a shell sent no tag list at all. The browser always sends one, so a Flatpak's untagged window never reached its thread when no shell had named it.

The helper's log answers "why didn't my window show up":

- each launch: `launched pid N in thread T: [argv]`, or `could not launch [argv] in thread T: …`;
- each new window: its app id, pid and tags, and the thread it went to and how (`from pid N's environment`, `pid N is one the helper started`), or why it got none (`the client's pid is unknown`, `pid N is gone`, `no thread tag in pid N or its parents (k environment(s) unreadable)`); later tag changes as `tags now […]`;
- the end of `launch_app`'s wait: the windows that closed during it, the windows it returns, or `no window in thread T from pid N after S s`, with whether the process exited and every other window that came in the meantime (with pid and tags).

A launch that exits 0 at once with no window has usually handed its arguments to an instance already running, and the new window belongs to that instance's session and thread. The Flatpak LibreOffice does this over D-Bus: whoever owns `org.libreoffice.LibreOfficeIpc0` on the session bus gets every later start, in any Plutonium session, whatever `-env:UserInstallation` says. If that instance doesn't answer (2026-10-24: it was restarting after a crash), the new soffice.bin waits on D-Bus without connecting to Wayland, and no window comes. A private session bus (`env DBUS_SESSION_BUS_ADDRESS=… org.libreoffice.LibreOffice …`) does give a separate instance.

## Accessibility

`read_window` reads a window as an accessibility tree over AT-SPI, for apps that have one (GTK, Qt, LibreOffice; not terminals): role, name, states, text, value, its center in snapshot pixels and a ref (`a12`). `act_window` acts on a ref: its default action, `focus`, `set_text`, `set_value`, `select`, `scroll_into_view`, or any action the app lists; with no action of its own, `click` clicks the element's center.

The helper talks D-Bus itself (`helper/src/dbus.ts`: the session bus for the accessibility bus's address, then that bus). It finds the window's frame among the applications whose bus connection belongs to the window's pid, matched by title and size (`helper/src/a11y.ts`). A Flatpak reaches the accessibility bus through its sandbox's `xdg-dbus-proxy`, so its connection's pid is the proxy's, not the app's: a connection counts as the app's when its pid has the same Flatpak instance (`instance-id` in `/proc/<pid>/root/.flatpak-info`, which the proxy shares). Before (2026-10-24), a Flatpak's windows were found only by title, so an untitled one (LibreOffice's "discard the recovery data?" box) wasn't, and `read_window` said the app wasn't on the bus at all. A GTK frame can include its window's client-side shadow (the "Save Document?" box: 526×218 for a 506×198 window): a frame bigger than the window by the same margin both ways matches, and the outline's points leave the shadow out, so they land where `click_window` expects them. Hidden elements are left out unless `all` is set; subtrees that manage their descendants are read only when small (Writer's paragraphs are). Writer's whole window reads in about 160 ms.

A ref whose element the app has since replaced or closed (Calc replaces its status bar in chart mode) gives "a4 is gone…: read the window again", from `read_window` and `act_window`, instead of an empty outline.

`select` asks the element's parent's `Selection` to select it. GTK 3's lists of more than one column refuse that (`SelectChild` answers false: Calc's chart type list, an icon column and a text column), so a table's cell has its row selected through the table's `Table.AddRowSelection`, which works there and makes the app react as to a click. With neither, it clicks the element's center with the pointer and says so. It doesn't fall back to the element's first action: those list cells' is "Expand or contract".

Each element's state is read first, and a defunct one is asked nothing more. Name, description and child count are read one by one, never with `GetAll` on `Accessible`: that includes `Locale`, and LibreOffice Calc aborts (`IllegalAccessibleComponentStateException` out of `ScAccessibleContextBase::getLocale`) when asked for it on its cells' or input line's defunct objects. That was the crash on 2026-10-24.

A table with more than 400 children (a sheet: 1048576 × 16384 cells) is read through its `Table` interface: the cells at its visible corners give the visible rows and columns, and of those cells (at most 1000) the outline lists the ones with text and the focused one, after a line with the table's size and the visible range. Calc's whole window, cells with values included, reads in about 300 ms.

Each call has 4 s. The first one the app doesn't answer stops the read (calls not yet made aren't sent), and so does 20 s in all. The result says which call got no answer, after how many elements, and whether the app is still on the accessibility bus (busy or hung) or gone (it quit or crashed). With nothing read, `read_window` fails with that.

## Tabs

- `Plutonium.createTab` opens a tab in the shells' profile, opened by `agent`, without a shell page.
- **Incognito tabs** (Chromium patch 0045, T3 patch 0023). `createTab` (the shell API's `windowBroker.createTab(url, tag, incognito)` and `Plutonium.createTab {incognito}`) opens a tab in a new off-the-record profile of its own. It's the kind DevTools makes for `Target.createBrowserContext`, which may open windows. The tabs its page opens share that profile, and the profile is destroyed once none of them is open. Tabs report `incognito`. A T3 tab opened with `profileId: "incognito"` gets one from both paths that can create it: the server's `open` to the helper carries `incognito`, and the shell page asks for it too. Neither adopts a tab of the other kind. On a browser without the patch, the tab fails rather than silently sharing the shells' storage, which is what happened before.
- `Plutonium.captureTab` captures a tab no page shows.
- A tab no page shows draws a frame a second too, and Playwright waits on frames before every action, so each click took 2 s. While a thread's Playwright connection is open, the helper keeps the tabs it drives awake (`Plutonium.setTabAwake`: a hidden capture, as tab capture uses). Two animation frames now take 12 ms and clicks 40–80 ms.
- Playwright would dismiss every dialog a page opens unless someone listens, so the helper listens. Dialogs stay for the user and for `answer_dialog`.

## MCP tools

All tools act on the calling thread's windows and tabs only.

| Windows | Tabs |
|---|---|
| `list_windows`, `find_apps {filter?}`, `launch_app`, `snapshot_window`, `focus_window`, `close_window` | `list_tabs`, `open_tab`, `snapshot_tab`, `navigate_tab`, `tab_action`, `answer_dialog`, `focus_tab`, `close_tab` |
| `click_window {x, y, button?, count?}`, `hover_window`, `drag_window {from, to}`, `scroll_window {x, y, dy?, dx?}` | `read_tab`: title, URL and the page as an accessibility tree with `[ref=eN]` |
| `type_window {text}`, `press_window {keys}` (`"ctrl+s"`, `["ctrl+a", "Backspace"]`) | `click_tab`, `hover_tab`, `type_tab {text, submit?, slowly?}`, `press_tab`, `select_tab`, `scroll_tab`, `evaluate_tab`, `wait_for_tab` (by `ref` or `selector`) |
| `resize_window {width, height}`: the size it's held at | |
| `read_window {ref?, all?}`, `act_window {ref, action, text?, value?}` | |

## In T3 Code

- **Every provider gets the window tools** (patch 0017). T3's own MCP server, which every provider uses, offers the helper's window tools. It lists them from the helper (`GET /v1/mcp/tools?set=windows`) and forwards each call with the calling thread's tag (`POST /v1/threads/<thread>/mcp/call`), so the helper stays the only place they're defined. Tabs are T3's own `preview_*` tools, on the same real tabs. Claude no longer gets the helper's stdio MCP server as well: its tools would be there twice.
- **Tab coordinates are CSS pixels** (patch 0020). `preview_click`, `preview_hover` and `preview_drag` take x/y in CSS pixels from the viewport's top-left. `preview_snapshot`'s image is one pixel per CSS pixel, so a point read off it is a point the tools take; `screenshot.viewport` gives the viewport's CSS size, and a viewport wider than 1280 is shrunk to 1280 by that ratio. The server used to scale the image by its headless render scale (2), so a desktop tab, drawn at the screen's ratio (1.78 here), gave 1138×711 images and claimed 1280×800. Now it reads the viewport from the page, captures it as drawn and shrinks the PNG on the server (patch 0021). A scaled capture makes Chromium emulate other device metrics for a moment, which a tab on screen showed as one frame of the page at 1/ratio size in its corner.
- **Drags along a path** (patch 0020). `preview_drag` takes `path: [{x,y}, …]` (2–500 points), `button` and `modifiers` besides `source` and `target`. The button goes down at the first point, the mouse moves through the rest in steps of at most 8 px, and comes up at the last, as real input, so agents can draw on a canvas (Excalidraw) without dispatching events from `preview_evaluate`. The panel's cursor follows each point.
- **The panel's cursor on a scaled tab** (patch 0020). A tab at a fixed viewport (after `preview_resize`, or the 1280×800 agents open with) is drawn scaled down and centred in the panel. The agent's cursor is placed from where the page sits and its scale, which only the Electron host published; the Plutonium host now publishes them too, so the cursor lands where the click does at any size. The floating preview draws the cursor too, on the layout the tab publishes for it (patch 0021); before, only the panel did.
- **A stuck action doesn't wedge its tab** (patch 0022). Agent actions on a tab run one at a time. Each now holds the queue only until its timeout (plus 500 ms). One still running then is abandoned: its caller gets a timeout that says so, the queue moves on, held buttons and keys are let go, and a path drag sends nothing more. An action whose time ran out while it waited doesn't start. Each mouse event fails after 5 s if the page doesn't take it, with an error saying the tab isn't drawing frames. The page takes moves with its next frame, so with the display off or switched to another session, a move would otherwise wait for a frame that never comes. `preview_status` reports `busy`: the running action, and `stuck` ones that timed out without finishing. Input still can't reach a tab while no frames are drawn; that needs the browser to keep drawing (see the backlog).
- **`preview_resize` answers with the new size** (patch 0021). A desktop tab takes a fixed size a moment after the server publishes it, so the reply waits (up to 3 s) for the page to report it, instead of giving the size before.
- **No wait for a shell page.** Before, a new server tab waited 10 s for a T3 page to show it and then went headless. Now the server sends `open` on the desktop browser channel. The helper opens the tab itself, tagged with the thread, and attaches it as its own page, so the tab is there in a few milliseconds. A T3 page that shows the thread later adopts that tab, as it adopts another page's. When the preview closes, the server sends `close`, and the helper closes the tabs it opened. A helper without the domain ignores `open`, and the server waits as before.
- **Recordings encode in Plutonium's browser.** `preview_recording_start` runs a video encoder in a page of its own. T3 Code launches its downloaded headless shell for it, which NixOS can't run, so recording always failed. Now the server sends `scratch` on the desktop browser channel: the helper opens a hidden page (`Target.createTarget` with `hidden`, in no window and no shell) and attaches it like a tab. The server turns on focus emulation for it, since a hidden page doesn't paint the encoder's canvas otherwise, and the encoder's last-frame wait is bounded, since a page in no window never calls `requestVideoFrameCallback` back. `close`, or the server going away, closes it. Without a helper the server uses its headless shell as before; when that can't start, the agent is told so with the host's own message (NixOS's "Could not start dynamically linked executable…"), not Playwright's "Target page, context or browser has been closed".
- **`visible` means the user sees the tab.** It counted only viewers the server streams to, which a tab Plutonium's shell shows never has, so `preview_open` and `preview_status` said `visible:false` with the panel open. Each tab's relay now answers `Plutonium.getTabs` with that tab alone, and `visible` is its `embedded`: a shell shows it, in the side panel or the floating preview (both draw the tab natively). `preview_open` waits up to 3 s for the preview it asked for.
- **Results that say what happened** (T3 patch 0030, 2026-10-26). `preview_press` and `preview_drag` return `done` ("Pressed Shift+Tab.", "Dragged through 3 points, from 100,100 to 300,300."); before, only the tool icon. `preview_navigate`'s status, built inside the navigate, no longer lists the navigate itself under `busy`. `preview_evaluate` is in the snapshot's `actionTimeline`, like clicks and presses. In a snapshot's accessibility tree, Playwright's `[active]` (the element with keyboard focus) reads `[focused]`: a tester took `[active]` for the chosen option.
- **Recordings have a length** (T3 patch 0030). MediaRecorder streams its file, so the WebM had no Duration and an MP4 a duration of 0: players couldn't show the length or seek well. The server writes it into the header after the stop (`recordingDuration.ts`): a Duration in a WebM's Info, the duration of an MP4's `mvhd`, `tkhd`, `mdhd` and `mehd`. There's no ffmpeg on NixOS's PATH to remux with.
- **A shell showing a tab counts** (T3 patch 0030). The idle sweep (`closeIdleAgentTabs`) closed an agent's tab no viewer streamed after a while, even with the user watching it in the panel. It now asks whether a shell shows the tab, and the tab a request without a `tabId` means (`latestThreadTab`) prefers one a shell shows. `visible` doesn't count the panel's hidden background embed for agent actions: only a recording the user starts in the panel makes one.
- **The floating preview follows the agent** (T3 patch 0030). When the agent's cursor moves in another of the thread's tabs, the floating preview switches to it (`ChatView.tsx`); before, it switched only to a new tab or one the server asked to show.
- **Private tabs are marked** (T3 patch 0030). An incognito tab's panel tab shows a mask in place of its site's icon, and the floating preview a "Private" badge.
- **A slow request doesn't drop the server's browser host.** The broker used to cut off a host whose request went unanswered, so one slow call (a first recording start downloading chrome-headless-shell in a fresh T3 home, about 28 s) also failed the agent's parallel calls with "No preview automation host". The server's own host is in-process, so now only the slow request fails. A recording start on it gets `open`'s allowance for an install.

## Verified (Xvfb, X11 session)

| Check | Result |
|---|---|
| zenity (GTK 4) entry dialog no page shows: `click_window` on the field, `type_window "Agent Smith!"`, `click_window` on OK | ✅ zenity printed `Agent Smith!` |
| `press_window ctrl+a`, then `Backspace`, then `type_window "replaced: A_b{1}"`, then `press_window Enter` | ✅ printed `replaced: A_b{1}`; the snapshot in between showed it |
| foot: `scroll_window dy=-5`, `drag_window` over four lines | ✅ scrolled 15 lines; lines 7–10 selected; Wayland trace shows press, 12 motions, release |
| foot frame callbacks during 2 s of output, no page showing it | 1 a second before; 34 after |
| Window screencast while foot prints 50 lines a second | 4–5 fps before; 28 fps after |
| `read_tab`, `type_tab` by ref, `evaluate_tab`, `click_tab`, `wait_for_tab` on hidden tabs | ✅; a click 2 s before `setTabAwake`, 40–80 ms after |
| `open` on the desktop browser channel (a fake server) | ✅ attached in 9 ms; `close` closed the tab |
| An agent (slot 1, 2026-10-24): `preview_open` example.com with its thread shown, `preview_recording_start`, scroll, click a link, `preview_recording_stop` | ✅ `visible:true`; a 1280×800 VP9 webm at the returned `path` shows the scroll, the click and the next page |
| T3: window tools on `/mcp` (a fake helper), the thread's tag forwarded, image content kept; nothing outside a session | ✅ `windowTools.test.ts` |
| Writer (2026-10-20): click the style box, `type_window "Title\n"`, then `type_window " Tide"` | ✅ " Tide" in the document, in Title style; lost before patch 0027 |
| foot, Writer: Wayland trace of `type_window` | ✅ one `enter` when the agent started, no `leave` between batches |
| Writer and foot snapshots | ✅ no title bar or close buttons drawn by the app |
| `launch_app` Writer at 1100×750; its window came after the 40 s wait (a fresh profile) | ✅ held at 1100×750 when it came |
| foot without a size: maps at 8×29, then settles | ✅ held at 696×488 |
| T3 panel: the held window scaled into a 539 px panel, the lock, "working" while typing, **Take control** | ✅ the app took the panel's size (539×916), `userControl`; `resize_window` refused after |
| `read_window` on Writer; `act_window` `set_text` on the paragraph, `click` on Italic; an unknown ref and action | ✅ 157 ms; text replaced; Italic checked; clear errors |
| `read_window` on the Flatpak Calc with a CSV open (X11 test session, private bus), 6 times with and without `all` | ✅ 220–330 ms, the cells' values listed, Calc alive; the reader from before aborted it on the first read |
| Flatpak LibreOffice (X11 test session): its a11y connection's pid | `xdg-dbus-proxy`'s, with soffice.bin's Flatpak instance id |
| `read_window` on its untitled "discard recovery data?" box | ❌ before: "isn't on the accessibility bus"; ✅ after (untitled lookup checked on "Save Document?": found by size, with its 10 px shadow; a pointer click at the outline's Cancel hit it) |
| `act_window select` on "Bar" in the chart type list | ✅ "select its row", the wizard showed Bar's subtypes (before: "The app refused to select it") |
| `read_window`/`act_window` on a ref of a replaced subtype list item | ✅ "a39 is gone…" (before: an empty outline) |
| `type_window "a\t\tb\t\t\tc\n"` ×8 in Calc | ✅ A, C, F every row (before: A, B, C every row) |
| zenity (GTK 4, X11 test session, 2026-10-26): `press_window shift+F10` on the entry | ✅ result lists the menu's popup; the snapshot (300×428 for a 300×253 window) shows the menu below the entry |
| A `click_window` on its "Select All", then `type_window "replaced"` | ✅ the pointer entered the menu's surface; menu closed; the entry read "replaced" |
| A `click_window` outside the open menu | ✅ `popup_done`, no button event to the window; result `popups: "closed"` |
| Writer (Flatpak, private bus): `click_window` on Format, `hover_window` on Text, `click_window` on Bold | ✅ the menu (past the window's bottom: a 1000×867 image) and its submenu in the snapshots, two popups listed; Bold on after the click |
| Format → Character…; Escape in the dialog; Escape in the welcome dialog | ✅ `new window #9 ("Character", 982×615)`; `window #8 closed`; `window #7 closed` |

## Limits

- **US keyboard.** `type_window` types as a US layout would. The app maps keycodes through the session's keymap, so other layouts get other characters.
- **Popups on screen.** A popup an agent opens shows on screen only while a panel shows its window, at the panel; otherwise it stays open but invisible (`WINDOW_SIZING.md`, "Popups"). Agents see it in snapshots either way. A popup that opens above or left of the window is cut off at the window's edge in the snapshot.
- **GTK 3 menus right after opening.** LibreOffice's menu ignored a click on an item that came about 250 ms after the menu opened; the same click 600 ms after worked.
- **GTK 4 dialogs and right clicks.** In zenity's entry dialog, an agent's right click on the entry made GTK ask for the window menu (`show_window_menu`), not the entry's context menu; shift+F10 opens that.
- **Tab and Enter.** LibreOffice Calc loses the second of two Tabs that come back to back after typing in a cell (`"mean\t\t100"` put 100 one column short; 8 of 8 rows on the X11 test session, from `type_window` and from `press_window ["Tab", "Tab"]`). Tabs on empty cells and doubled letters weren't affected. So `type_window` and `press_window` wait 80 ms after each Tab or Enter that has more keys after it (50 ms was enough there).
- **Typing speed.** Exo drops a client that can't keep up (`libwayland: error in client communication`): LibreOffice Writer died 3 times out of 3 when a 400-character `type_window` went in as back-to-back batches of 64 key events, and lived through the same text twice over with the batches 25 ms apart.
- **Same app, two windows.** When the user's focus is in another window of the app the agent types into, the agent's window still borrows the seat's focus for each batch (the focus blip from before patch 0027).
- **Input on a held window.** The panel shows a held window scaled, and blocks the user's input to it until they take control: input under a CSS transform isn't checked yet.
- **Accessibility** needs the app on the session's accessibility bus. Apps in another session bus (a container, Flatpak without the a11y portal) aren't found, and `read_window` says so. Accessibility actions aren't blocked by an app's modal dialogs the way pointer clicks are.
- **Qt apps on the X11 test session.** kwrite's shared-memory buffers (BGRX) fail to import into the GPU process on Xvfb with Vulkan ANGLE, and its retries starve other windows' snapshots. This isn't about agents; not checked on DRM.
- **Remote clients** still don't see native windows: see the backlog.
