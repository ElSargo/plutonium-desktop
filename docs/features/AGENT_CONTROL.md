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
- **Keys.** Keyboard focus follows aura focus. For the agent's keys the window borrows it, standing in for whatever has it (`Seat::SetEmbeddedFocus`), and gives it back afterwards. The keys go through `Seat::DispatchAgentKeyEvent()` with their physical code, so Exo's key tracking and modifiers come out right, and the app maps them through its keymap. Text is typed as a US keyboard would type it (`helper/src/keys.ts`); other characters are refused.
- **Frame rate.** viz slows a frame sink whose frames nothing draws to one frame a second, and a parked window no page shows is never drawn: its app waited up to a second to redraw after input. `EmbeddedWindows::KeepDrawing()` sends frames with `may_throttle_if_undrawn_frames = false`. The helper keeps a window awake (`Plutonium.setWindowAwake`) from the agent's first input until it has been left alone for 60 s, and a window screencast keeps it awake while it runs.
- **Screencast.** `Plutonium.startWindowScreencast` sends frames as the app draws them. A video capturer on the window's frame sink saw no damage, for the same reason, and refreshed only every 200 ms. Instead, each commit is copied as `Snapshot()` does: one copy at a time, at most 30 a second, always including the last frame of a burst (`chrome/browser/plutonium_agent.cc`).
- A window snapshot taken within 200 ms of input waits for the rest of that time, so it shows the app's answer.

## Tabs

- `Plutonium.createTab` opens a tab in the shells' profile, opened by `agent`, without a shell page.
- `Plutonium.captureTab` captures a tab no page shows.
- A tab no page shows draws a frame a second too, and Playwright waits on frames before every action, so each click took 2 s. While a thread's Playwright connection is open, the helper keeps the tabs it drives awake (`Plutonium.setTabAwake`: a hidden capture, as tab capture uses). Two animation frames now take 12 ms and clicks 40–80 ms.
- Playwright would dismiss every dialog a page opens unless someone listens, so the helper listens. Dialogs stay for the user and for `answer_dialog`.

## MCP tools

All tools act on the calling thread's windows and tabs only.

| Windows | Tabs |
|---|---|
| `list_windows`, `launch_app`, `snapshot_window`, `focus_window`, `close_window` | `list_tabs`, `open_tab`, `snapshot_tab`, `navigate_tab`, `tab_action`, `answer_dialog`, `focus_tab`, `close_tab` |
| `click_window {x, y, button?, count?}`, `hover_window`, `drag_window {from, to}`, `scroll_window {x, y, dy?, dx?}` | `read_tab`: title, URL and the page as an accessibility tree with `[ref=eN]` |
| `type_window {text}`, `press_window {keys}` (`"ctrl+s"`, `["ctrl+a", "Backspace"]`) | `click_tab`, `hover_tab`, `type_tab {text, submit?, slowly?}`, `press_tab`, `select_tab`, `scroll_tab`, `evaluate_tab`, `wait_for_tab` (by `ref` or `selector`) |
| `resize_window` (only a window no page shows) | |

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

## Limits

- **US keyboard.** `type_window` types as a US layout would. The app maps keycodes through the session's keymap, so other layouts get other characters.
- **Popups.** Menus and other `xdg_popup`s are separate surfaces. They aren't in the window's snapshot, and an agent's click lands on the window under them. Keyboard navigation works.
- **The focus blip.** Keys sent to an unfocused window take keyboard focus for a moment, so the focused app sees `leave` and `enter`.
- **Qt apps on the X11 test session.** kwrite's shared-memory buffers (BGRX) fail to import into the GPU process on Xvfb with Vulkan ANGLE, and its retries starve other windows' snapshots. This isn't about agents; not checked on DRM.
- **Remote clients** still don't see native windows: see the backlog.
