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
- the end of `launch_app`'s wait: the windows it returns, or `no window in thread T from pid N after S s`, with whether the process exited and every other window that came in the meantime (with pid and tags).

A launch that exits 0 at once with no window has usually handed its arguments to an instance already running, and the new window belongs to that instance's session and thread. The Flatpak LibreOffice does this over D-Bus: whoever owns `org.libreoffice.LibreOfficeIpc0` on the session bus gets every later start, in any Plutonium session, whatever `-env:UserInstallation` says. If that instance doesn't answer (2026-10-24: it was restarting after a crash), the new soffice.bin waits on D-Bus without connecting to Wayland, and no window comes. A private session bus (`env DBUS_SESSION_BUS_ADDRESS=… org.libreoffice.LibreOffice …`) does give a separate instance.

## Accessibility

`read_window` reads a window as an accessibility tree over AT-SPI, for apps that have one (GTK, Qt, LibreOffice; not terminals): role, name, states, text, value, its center in snapshot pixels and a ref (`a12`). `act_window` acts on a ref: its default action, `focus`, `set_text`, `set_value`, `select`, `scroll_into_view`, or any action the app lists; with no action of its own, `click` clicks the element's center.

The helper talks D-Bus itself (`helper/src/dbus.ts`: the session bus for the accessibility bus's address, then that bus). It finds the window's frame among the applications whose bus connection belongs to the window's pid, matched by title and size (`helper/src/a11y.ts`). Hidden elements are left out unless `all` is set; subtrees that manage their descendants are read only when small (Writer's paragraphs are). Writer's whole window reads in about 160 ms.

## Tabs

- `Plutonium.createTab` opens a tab in the shells' profile, opened by `agent`, without a shell page.
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
- **No wait for a shell page.** Before, a new server tab waited 10 s for a T3 page to show it and then went headless. Now the server sends `open` on the desktop browser channel. The helper opens the tab itself, tagged with the thread, and attaches it as its own page, so the tab is there in a few milliseconds. A T3 page that shows the thread later adopts that tab, as it adopts another page's. When the preview closes, the server sends `close`, and the helper closes the tabs it opened. A helper without the domain ignores `open`, and the server waits as before.

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
| T3: window tools on `/mcp` (a fake helper), the thread's tag forwarded, image content kept; nothing outside a session | ✅ `windowTools.test.ts` |
| Writer (2026-10-20): click the style box, `type_window "Title\n"`, then `type_window " Tide"` | ✅ " Tide" in the document, in Title style; lost before patch 0027 |
| foot, Writer: Wayland trace of `type_window` | ✅ one `enter` when the agent started, no `leave` between batches |
| Writer and foot snapshots | ✅ no title bar or close buttons drawn by the app |
| `launch_app` Writer at 1100×750; its window came after the 40 s wait (a fresh profile) | ✅ held at 1100×750 when it came |
| foot without a size: maps at 8×29, then settles | ✅ held at 696×488 |
| T3 panel: the held window scaled into a 539 px panel, the lock, "working" while typing, **Take control** | ✅ the app took the panel's size (539×916), `userControl`; `resize_window` refused after |
| `read_window` on Writer; `act_window` `set_text` on the paragraph, `click` on Italic; an unknown ref and action | ✅ 157 ms; text replaced; Italic checked; clear errors |

## Limits

- **US keyboard.** `type_window` types as a US layout would. The app maps keycodes through the session's keymap, so other layouts get other characters.
- **Popups.** Menus and other `xdg_popup`s are separate surfaces. They aren't in the window's snapshot, and an agent's click lands on the window under them. Keyboard navigation works.
- **Typing speed.** Exo drops a client that can't keep up (`libwayland: error in client communication`): LibreOffice Writer died 3 times out of 3 when a 400-character `type_window` went in as back-to-back batches of 64 key events, and lived through the same text twice over with the batches 25 ms apart.
- **Same app, two windows.** When the user's focus is in another window of the app the agent types into, the agent's window still borrows the seat's focus for each batch (the focus blip from before patch 0027).
- **Input on a held window.** The panel shows a held window scaled, and blocks the user's input to it until they take control: input under a CSS transform isn't checked yet.
- **Accessibility** needs the app on the session's accessibility bus. Apps in another session bus (a container, Flatpak without the a11y portal) aren't found, and `read_window` says so.
- **Qt apps on the X11 test session.** kwrite's shared-memory buffers (BGRX) fail to import into the GPU process on Xvfb with Vulkan ANGLE, and its retries starve other windows' snapshots. This isn't about agents; not checked on DRM.
- **Remote clients** still don't see native windows: see the backlog.
