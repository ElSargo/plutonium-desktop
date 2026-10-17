# T3 Code as the shell (test branch `t3-shell-test`)

Date: 2026-10-15, revised 2026-10-16. Since Phase 3 (`PHASE3_REPORT.md`) the frontend-neutral parts described below live in Plutonium's helper (`helper/`); T3 keeps only the UI and asks the helper for each thread's environment. Proof of concept: GUI apps that a T3 Code thread starts, from its agent or from its terminals, are listed in the thread's right panel under **Apps**. Each one opens as a panel tab, shown live as a `<native-window>`, beside Terminal, Files, Diff and the rest. The tab header has a button that pops the app out to the desktop.

Verified on Xvfb (`shots/t3-*.png`):
- A Claude Sonnet 5.5 thread was asked to launch `foot -T agent-foot`. The window appeared under that thread (`t3-agent.png`).
- Clicking the entry embedded it in the pane, where it took typing (`t3-pane.png`, `t3-pane-type.png`).
- A page reload re-listed and re-embedded it (`t3-pane2.png`).
- Killing the app removed the entry and closed the pane.

Verified after the right-panel revision (`shots/t3-apps-*.png`):
- `foot` started from the thread's T3 terminal was tagged with the thread, and it was listed under Apps (`t3-apps-list.png`).
- Opening it gave a panel tab next to Apps; the window was embedded at the panel's size and took typing (`t3-apps-tab-typed.png`).
- **Pop out** closed the tab, and the window came back on the Ash desktop, raised and active (`t3-apps-popout.png`). Opening it from Apps again re-embedded it.
- A page reload restored the open app tab and re-embedded it. Killing the app closed its tab.

Verified after the second revision (2026-10-16), on a private Ash (`:99`, socket `wayland-cros2`) and a second T3 server (port 3775) beside the live session:
- **X11 apps:** an X11 xterm started from the thread's terminal got `DISPLAY=:200`, the thread's own Xwayland. It appeared under the thread, embedded in the panel, and took typing and mouse drag-selection (`t3-x11-typed.png`).
- **Hidden windows:** apps launched hidden (`t3-hidden-launch.png`). Switching away from an app's tab left it hidden (`t3-hidden-switch.png`). Pop out showed it centred and active (`t3-hidden-popout.png`), and after re-embedding and switching away it was hidden again.
- **Prism Launcher (Flatpak, Qt):** in the panel, normal and maximised, clicks on instances selected them every time. That included right after a popped-out window had taken activation.

## How it works

1. **Chromium** (branch `t3-shell-test`, on top of Phase 2):
   - Exo records each Wayland client's pid on its surfaces (`wl_client_get_credentials`). The broker passes it through to `NativeWindowEntry.pid`.
   - `navigator.windowBroker.showOnDesktop(windowId)` shows and activates a window on the Ash desktop. If an element still shows it, this happens as soon as the last one detaches (`EmbeddedWindows::ShowOnDesktop`).
   - With `--plutonium-hide-windows`, set by `launch-t3-shell.sh`, every toplevel is parked (invisible, inactive, no input) from creation. Its last detach parks it again, unless it was popped out.
   - Exo's `wl_output` is version 4 and sends `name`/`description`. xwayland-satellite panics on the first keyboard focus without it.
   - Pointer presses into embedded windows are logged as `EXO-EMBED` at `--vmodule=embedded_windows=1,render_widget_host_input_event_router=1` (on in `launch-t3-shell.sh`).
2. **Container**: Ash must run in `cros-run`, a twin of `cros-build` with `--pid=host`. Otherwise host clients show as `pid=0`.
3. **Helper** (`helper/`, `plutoniumd`; was in the T3 server until Phase 3):
   - `thread-setup` gives a thread's processes `PLUTONIUM_THREAD_ID`, `WAYLAND_DISPLAY`, the toolkit backend variables, `PLUTONIUM_HELPER`, and `DISPLAY=:2NN`.
   - `:2NN` is a per-thread rootless Xwayland through xwayland-satellite. `systemd-socket-activate` holds `/tmp/.X11-unix/X2NN` and starts the satellite on the first X client, with the thread's tag in its environment. Exo sees the satellite as the client, so its windows resolve to the thread. The helper writes `/tmp/.X2NN-lock` and removes both files when the satellite exits.
   - `window-threads?pids=…` reads `/proc/<pid>/environ` and walks parent pids to map each pid to a thread.
   - The agent bridge (`plutonium.ts mcp`) lets an agent list, launch, snapshot, focus and close its thread's windows.
4. **T3 server** (`~/projects/t3code`, branch `plutonium`, base v0.0.45). Only active with `PLUTONIUM_HELPER` or `PLUTONIUM_WAYLAND_DISPLAY` set:
   - `apps/server/src/plutonium.ts` asks the helper for `thread-setup` (cached for 10 s).
   - Agents get the environment in `withAgentDeviceEnvironment`, and the thread's integrated terminals get it at spawn (`terminal/Manager.ts`).
   - Claude sessions also get the helper's MCP server as `mcpServers.plutonium` (`ClaudeAdapter.ts`).
5. **T3 web**:
   - `apps/web/src/plutonium/windowStore.ts` loads the helper's shell library (`/v1/shell.js`) and mirrors its windows (each with its thread) into a store. `?plutoniumHelper=<origin>` picks a non-default helper; it is read at boot (`helperOrigin.ts`, `main.tsx`).
   - `PlutoniumWindowsStarter` registers the bridge's focus handler: an agent's `focus_window` opens the app tab in its thread and navigates there.
   - `rightPanelStore.ts` has two new surface kinds. `apps` is the list: the thread's windows, then "Other windows" that no thread started. `app` is one window per tab, keyed by window id and checked against its app id, because window ids restart with Ash.
   - `RightPanelTabs.tsx` lists Apps (shortcut W) in the launcher and the + menu. `ChatView.tsx` renders the two surfaces.
   - Outside the shell the Apps entry is disabled, and restored app tabs are dropped.

## Running it

```
# 1. T3 server (web built once with: cd apps/web && npx vp build), pointed at the
#    helper of the Exo socket it serves:
cd ~/projects/t3code
PLUTONIUM_WAYLAND_DISPLAY=wayland-cros T3CODE_HOME=~/.t3-plutonium \
  node apps/server/src/bin.ts --port 3774 --host 127.0.0.1 --no-browser
# 2. Helper + Ash with T3 as the shell (first time: pass the pairing URL the server logs).
#    X11 apps need xwayland-satellite on PATH or PLUTONIUM_XWAYLAND_SATELLITE pointing at it
#    (e.g. $(nix build --no-link --print-out-paths nixpkgs#xwayland-satellite)/bin/xwayland-satellite).
PM=tools/pm.sh XDISP=:0 tools/launch-t3-shell.sh 'http://127.0.0.1:3774/pair#token=…'
```

## Limits

- **Thread tagging:** guaranteed for Claude. Codex and the other providers only get the tag when T3 issued the thread an MCP session.
- **Agent bridge:** only Claude sessions get the helper's MCP server.
- **Untagged windows:** apps started outside T3 appear under "Other windows" in every thread's Apps list.
- **Hidden apps:** apps not shown in a tab are invisible on the Ash desktop; Apps → Pop out brings one back. Whether Ash's shelf or window cycling still offers them is untested.
- **No auto-open:** a newly launched app gets no tab automatically; open it from Apps.
- **Mouse on `:0`:** reported broken in the panel on the real desktop, but not reproduced on `:99` (see BACKLOG). Phase 3 found presses the renderer handed to the page (`PHASE3_REPORT.md`). Check the `EXO-EMBED` lines, now including `renderer hit <element>`, in `logs/shell-wayland-cros.log`.
- **X11 tagging is per thread, not per app:** every X11 window of a thread shares the satellite's pid. An X11 app started outside T3 with that `DISPLAY` would count as the thread's.
- **Flatpak apps** get `DISPLAY`/`WAYLAND_DISPLAY` from the environment as usual. Prism, and Minecraft through it, need `--socket=x11` to reach the thread's X server.
