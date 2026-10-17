# Phase 3: frontend-agnostic integration and agent bridge

Date: 2026-10-16. Branches: Chromium `t3-shell-test` (uncommitted on top, all in `patches/exo-phase3.patch` against `9f2eedcd653d`), T3 Code fork `plutonium` (uncommitted), this repo `t3-shell-test` (uncommitted). New Chromium code is tagged `EXO-BRIDGE`.

## Result

The exit criterion is met on the private dev instance (`:99`, socket `wayland-cros2`): **an agent in either frontend opens an app, sees a snapshot of it and closes it, with no frontend-specific Chromium code.**

- **Plain shell** (`shell/index.html`): Claude Code (Sonnet) ran as a terminal app in the page's thread, with only the helper's MCP tools allowed. It launched kcalc and took a snapshot while kcalc was hidden: it was never shown on the desktop or in a tab. It described the window correctly ("dark-themed calculator, empty display, … NORM at the bottom") and closed it (`closed: true`).
- **T3 Code**: a new thread with Claude Haiku 5.5 launched kcalc, described the snapshot the same way, and called `focus_window`. That opened kcalc's tab in the thread's right panel. Next turn, `close_window` closed it and its tab went away.
- **Same substrate for both:** the same Chromium build, the same helper and the same shell library. The frontends differ only in UI: how threads are listed and what "focus" opens.

| # | Item | Result | Evidence (`shots/phase3-*.png`) |
|---|---|---|---|
| 1 | Frontend-agnostic helper | ✅ `helper/` (`plutoniumd`) took over the pid → thread resolver, the per-thread X display and the thread environment from the T3 fork. It also launches apps into threads. T3's server code for this went from 176 lines plus an HTTP route to an 87-line client | `t3-agent-focus` |
| 2 | Agent bridge | ✅ `windowBroker.close()` and `windowBroker.snapshot()` (viz `CopyOutputRequest`, works on hidden windows). The helper relays list, launch, focus, close and snapshot through the shell page. `plutonium.ts mcp` exposes them as MCP tools, limited to the caller's thread | `snapshot-hidden`, `snapshot-shown`, `plain-agent`, `t3-agent-close` |
| 3 | Second, minimal frontend | ✅ `shell/index.html`: threads, launch box, Apps list, one tab per window, snapshot, pop out, close, and "Start agent" (Claude Code in foot with the MCP server). About 300 lines, no build step, nothing T3-specific | `plain-start`, `plain-focus`, `plain-fill`, `plain-agent` |
| 4 | Panel mouse issue on `:0` | 🔶 Diagnosed from the log, not fixed: see below. A new renderer log line names the element that took a press | `logs/t3-shell.log` (2026-10-15 20:19–20:20) |

Also verified:
- **Hidden-window snapshot:** foot, never shown anywhere, gave a 696×488 PNG, exactly its window geometry, without client-side shadow.
- **Thread scoping:** focus, close and snapshot of a window from another thread are refused (`404 This thread has no window 2.`).
- **Shell reconnects:** after a page reload, a helper restart or an Ash restart, the shell library's EventSource reconnects by itself.
- **T3 terminals and X11:** a T3 terminal's shell got the thread tag and `DISPLAY=:201` from the helper. An X11 xterm launched through the helper got `:200` and resolved to its thread.

## How it works

```
 agent (Claude Code, …)                       shell page (any frontend)
   │ stdio MCP                                  │ navigator.windowBroker, <native-window>
 plutonium.ts mcp ──Unix socket──► plutoniumd ◄─┤ EventSource: bridge requests
   (PLUTONIUM_THREAD_ID)             │          │ POST: replies (JSON or PNG)
                                     │          │ fetch: window-threads, launch, thread-setup
 frontend server ──thread-setup──────┘          └── web/plutonium-shell.js (loaded from the helper)
 (T3: agent/terminal env + MCP server)
```

**Chromium (`EXO-BRIDGE`, about 170 lines):**
- `exo::EmbeddedWindows::Close(id)` calls the toplevel's `OnCloseRequested`, as Ash's close button would. Wayland apps get `xdg_toplevel.close`; X11 apps get `WM_DELETE_WINDOW` through the satellite.
- `exo::EmbeddedWindows::Snapshot(id, callback)` puts a `viz::CopyOutputRequest` on the host window's layer:
  - a layer with a copy request is drawn even under the parked window's zero opacity, and the copy is taken before that opacity applies;
  - the result is cropped to the window geometry (no client-side shadow), in physical pixels.
- `blink.mojom.WindowBroker` gains `Close(window_id)` and `Snapshot(window_id) => (BigBuffer? png)`. PNG encoding runs on the thread pool.
- Script sees `navigator.windowBroker.close(id)` and `snapshot(id) → Promise<Blob>`. As before, only the shell document gets them, and the browser re-checks on every call.

**Helper (`helper/`, Node 24, no dependencies; see `helper/README.md`):**
- **Listeners:**
  - a Unix socket (0600) for local processes;
  - `127.0.0.1:<port>` for the shell page. It only answers requests whose `Origin` is the shell origin *and* whose socket is owned by this user (`/proc/net/tcp`). The first check keeps out other pages in the browser, the second other users.
- **Bridge:** the window broker exists only in the shell page, so the helper sends it requests over an EventSource, and the page replies with a POST. The library answers each request with the broker:
  - `windows` → `getWindows()`;
  - `focus` → the frontend's `onFocus`, falling back to `showOnDesktop`;
  - `close`;
  - `snapshot` → the PNG `Blob`, posted as `image/png`.
- **Thread scoping:** each bridge call resolves the target window's pid to a thread and compares it with the caller's.
- **`launch`** spawns the app detached with the thread environment. It then polls the shell's window list for the thread's new windows, and waits another 300 ms for a second window (a dialog or splash) before returning.

**Frontends:**
- **Plain shell:** loads `…/v1/shell.js` and renders from `shell.windowsOf(thread)`. Its `onFocus` switches to the window's thread and opens the tab.
- **T3 Code** (fork, `plutonium` branch):
  - **Server:** `plutonium.ts` asks the helper for `thread-setup` through a short `node -e` child (environments are built synchronously at spawn) and caches the answer for 10 s. Agents and terminals get the env. Claude sessions also get the helper's MCP server as `mcpServers.plutonium`. The `/api/plutonium/window-threads` route is gone.
  - **Web:** `windowStore.ts` mirrors the shell library into zustand. `PlutoniumWindowsStarter` registers `onFocus`, which opens the app tab in the thread (primary environment) and navigates there. `?plutoniumHelper=` is read at boot (`main.tsx`), before the pairing redirect drops the query.
  - **Size:** 618 lines across 14 files, against upstream.
- **Launchers:**
  - `tools/launch-shell.sh` works for any frontend. It (re)starts the helper and Ash for one shell origin, and only touches its own instance (by profile and socket), so it can run beside another session.
  - It leaves its caller's `CLAUDE*` variables out of the helper's environment, so agents started from it aren't taken for nested sessions.
  - `launch-t3-shell.sh` and `launch-plain-shell.sh` wrap it.

## Panel mouse issue on `:0` (item 4)

From the `EXO-EMBED` lines of the user's session (`logs/t3-shell.log`, 2026-10-15 20:15–20:23):
- **Most presses into embedded windows went through:**
  - viz hit-tested them to the window's sink (`down hit (0, n) … here 1`);
  - the renderer confirmed (`queried down (0, n)`);
  - and Exo dispatched (`press for sink … -> window #n`).
- **Two presses on window #8 (Prism) were lost**, at 20:19:01 and 20:20:17:
  - viz hit-tested them to the window, with flags 124, which include `kHitTestAsk`, so the browser has to confirm with the renderer;
  - the renderer answered the page's own sink, `(36, 7)`, so the press went to T3 instead of the app.
  - So, at that point, the renderer's hit test found an element other than the `<native-window>`. Candidates: a T3 element covering the panel (overlay, resize handle, toast), or layout that had moved since viz's hit-test data was submitted.
- **Window #8's two delivered presses** had surface coordinates around y = 1330, a lot taller than the panel. That's worth checking against its geometry: a scale or offset mismatch would make clicks land in the wrong place.

**Next step:** the renderer now logs the element it hit (`EXO-EMBED renderer hit <element> at <point>`, `--vmodule=web_frame_widget_impl=1`, on in `launch-shell.sh`). The next `:0` session will show which element takes the press.

## Bugs found

- **Plain shell: the window didn't fill its tab.** `<native-window>` is a replaced element: with `position: absolute; inset: 0` and no width or height, it takes the window's own size. Fixed with an explicit `width/height: 100%`, as T3 does.
- **Plain shell: restored tabs were dropped on reload.** Tabs were reconciled against the window list before the broker's first snapshot arrived. Now this waits for `shell.ready`. T3's store does the same.
- **T3: the helper port was lost on first open.** The pairing redirect dropped `?plutoniumHelper=`. It is now read at boot.
- **Helper: the CLI parsed the app's own arguments** (`launch <thread> foot -T x`). Fixed: they're passed through untouched.

## Known issues and limits

- **The bridge needs the shell page.** With no shell connected, list, focus, close and snapshot fail with 503; launch still works. If several shell documents connect (two tabs), the latest one serves.
- **The agent's thread is self-declared** (`PLUTONIUM_THREAD_ID` of the MCP process), as strong as the thread tagging. Per-thread Exo servers (Phase 5) would fix both.
- **Only Claude agents in T3 get the MCP server.** Codex and others still get the environment, so their apps are tagged, but they have no bridge tools.
- **Helper restarts forget thread X displays.** Processes started before the restart keep their old `DISPLAY`, now dead. Agents started while the helper had no satellite kept the host's `DISPLAY`.
- **`focus_window` in T3** opens the tab in the primary environment's thread. A thread on a remote environment isn't handled; those don't use the local helper anyway.
- **The helper URL is a convention:** `127.0.0.1:3780`, or `?helper=` / `?plutoniumHelper=`. Nothing tells the page automatically.
- **Snapshot is the window geometry only.** Popups and menus are separate toplevels, and there is no scaling option. Large windows give large PNGs: about 16 KB for a 1376×726 terminal.
- **No unit tests** for the helper or the new broker methods. Verified by hand on Xvfb, as before.
- **The Chromium, T3 and repo changes are not committed.** The Chromium diff is in `patches/exo-phase3.patch`.

## Files

- **Chromium:**
  - **Changed:**
    - `components/exo/embedded_windows.{h,cc}` (`Close`, `Snapshot`)
    - `chrome/browser/plutonium_shell.cc` (`Close`, `Snapshot`, PNG)
    - `window_broker.mojom`, `native_window_broker.{h,cc,idl}`
    - `web_frame_widget_impl.cc` (hit log)
- **This repo:**
  - **New:**
    - `helper/` (`plutonium.ts`, `src/{daemon,relay,threads,client,mcp}.ts`, `web/plutonium-shell.js`, README)
    - `shell/index.html`
    - `tools/launch-shell.sh`, `tools/launch-plain-shell.sh`
    - `patches/exo-phase3.patch`
    - `docs/PHASE3_REPORT.md`
  - **Changed:** `tools/launch-t3-shell.sh` (now a wrapper), docs
- **T3 fork:**
  - **Changed:** `apps/server/src/plutonium.ts` (helper client), `ClaudeAdapter.ts` (MCP server), `apps/web/src/plutonium/{windowStore.ts,PlutoniumWindows.tsx}`, `main.tsx`
  - **New:** `apps/web/src/plutonium/helperOrigin.ts`
  - **Reverted to upstream:** `apps/server/src/{http,server}.ts` (no resolver route)

## Running it

```
# Plain shell on a private instance beside any other session:
PM=tools/pm.sh SOCKET=wayland-cros2 CDP_PORT=9223 PROFILE=/tmp/cros-exo-test2 \
  HELPER_PORT=3781 XDISP=:99 tools/launch-plain-shell.sh

# T3: server first (PLUTONIUM_HELPER or PLUTONIUM_WAYLAND_DISPLAY points it at the helper)
PLUTONIUM_WAYLAND_DISPLAY=wayland-cros T3CODE_HOME=~/.t3-plutonium \
  node apps/server/src/bin.ts --port 3774 --host 127.0.0.1 --no-browser
PM=tools/pm.sh XDISP=:0 tools/launch-t3-shell.sh

# The bridge by hand
PLUTONIUM_HELPER=$XDG_RUNTIME_DIR/plutonium/wayland-cros.sock node helper/plutonium.ts launch <thread> foot
curl --unix-socket $XDG_RUNTIME_DIR/plutonium/wayland-cros.sock http://x/v1/threads/<thread>/windows
```
