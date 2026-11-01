# Native windows for remote T3 clients

**Status:** built 2026-10-28 (T3 patch "remote clients see native windows", helper `windowStream.ts`). No Chromium change: it uses the window screencast and input the Plutonium DevTools domain already has.

The Plutonium shell shows a thread's windows with `<native-window>` elements, which only the session's own browser has. A T3 client anywhere else (another machine's browser, or any page that isn't the shell's origin) used to have no Apps panel. Now T3's server streams the windows to it.

## How it works

- **The helper** (on its socket only, like the other server-facing routes):
  - `GET /v1/windows`: every window (id, app, title, size in DIPs, tags).
  - `GET /v1/windows/:id/stream?maxWidth&maxHeight&quality`: the window's frames as one long response, each an 8-byte header (JPEG length u32, width and height u16, big-endian) and the JPEG (`Plutonium.startWindowScreencast`). A reader that falls behind loses frames, not latency. While a stream is open the window is kept awake (drawing at full rate); an agent's own wake timer doesn't put it to sleep under a stream.
  - `POST /v1/windows/:id/mouse` (a `WindowMouseEvent`) and `POST /v1/windows/:id/keys` (`{events: WindowKeyEvent[]}`): the user's input, straight to `Plutonium.dispatchWindow{Mouse,Key}Event(s)`. Unlike the agent tools this isn't per thread: it is the user's own view.
- **T3's server** (`apps/server/src/plutonium/windowStream.ts`, only with `PLUTONIUM_T3`): `/api/window-stream/ws` sends `{type:"windows", windows}` whenever the list changes (it polls the helper each second); `?windowId=N` sends the window's JPEGs as binary messages and forwards `{type:"mouse", event}` and `{type:"keys", events}` to the helper in order. Watching needs `orchestration:read`, input `preview:operate` (as driving a preview does); remote clients authenticate with the usual WebSocket ticket. Close codes: 4404 the window is gone, 4503 no helper.
- **The web app**: outside the shell, `startRemoteWindows` fills the same window store from the list (with `remote: true`), so the Apps panel, its Elsewhere list and app tabs work as in the shell. A window's tab draws its frames on a canvas (`RemoteWindowView`), scaled down to fit, and sends pointer (press, release, moves once a frame, wheel as notches, drags captured) and keys (`KeyboardEvent.code` and modifiers) back.

## Limits

- The window keeps its size; the remote panel doesn't resize it (the shell's panel does).
- Keys go as physical codes through the session's keymap; there is no IME or clipboard for remote clients yet.
- Pop out, "To display N", adding a window from Elsewhere to the thread (tags) and launching apps from the launcher are shell-only.
- JPEG frames: fine on a LAN or tailnet, not tuned for slow links.

## Verified (2026-10-28, slot 25, X11)

T3 opened at `http://localhost:6273` (a non-shell origin, paired with `plutonium hydra pair`) in the session's browser: Apps listed a KWrite started in the thread; its tab showed the window's frames; a click on "New File" and typed keys reached it (the title became "Untitled (hi remote) *"). Unit tests: `helper/test/windowStream.test.ts`, T3's `windowStream.test.ts` (server) and `remoteWindows.test.ts` (web).
