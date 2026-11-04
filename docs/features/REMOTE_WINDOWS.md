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

## Windows as server tabs, for every T3 client

**Status:** built 2026-11-04 (T3 patch "native windows are their threads' server tabs", `apps/server/src/plutonium/windowTabs.ts`; helper routes `text` and `close`). Not yet tried from the mobile app.

The web app's Apps panel needs Plutonium's own `/api/window-stream`. The mobile app, T3's desktop app, and any other T3 client know only server tabs: the thread's preview list and `/api/preview-stream`. So the server lists each window as one of its thread's server tabs too, and streams it through the same route as a page:

- **The list:** each second the server reads the helper's `GET /v1/windows`. A window with a `t3:thread/` tag is a tab of that thread: id `plutonium-window-<window>-<pid>` (the pid, so a client holding a closed window's tab can't land on another window that reused its number), `runtime: "server"`, address `app://<app id>`, the window's title. Opened, retitled and closed go out as the usual preview events, in the same revision order as pages. Agents' `t3_preview_*` tools and the server's browser don't see these tabs (`PreviewManager.list` leaves them out; clients get `listForClients`). Hydra's web app leaves them out too: it shows windows as app tabs.
- **The stream:** `/api/preview-stream/ws` with a window's tab id streams the helper's frames (paced by the viewer's acks: two in flight, and a newer frame replaces one waiting). The viewport is the window's size in DIPs, sent again when its frames change shape. One viewer at a time has control (the first that may operate, or `takeControl`); one losing control lets go of the keys and buttons it held.
- **Input:** mouse as `mouse`, wheel and touch pans as whole notches (100 px each, the rest kept), keys by `code`. A soft keyboard's keys without a code go by name (Backspace, Enter, arrows) or, for text, as text, which the helper types under the session's keymap as `type_window` does (`POST /v1/windows/:id/text`). A touch viewer's probe always answers "editable", so its keyboard comes up on any tap.
- **Closing the tab** asks the app to close the window, as its close button does (`POST /v1/windows/:id/close`): it may ask to save first.

## Limits

- The window keeps its size; the remote panel and server-tab viewers don't resize it (the shell's panel does). On a phone a desktop-sized window is shown scaled down.
- A window an agent holds at its size isn't shown as the agent's to server-tab viewers: they see it unclaimed, and their input goes in beside the agent's.
- Server-tab viewers: no navigation, reload or zoom for a window (they are ignored), and no clipboard.
- Keys go as physical codes through the session's keymap; there is no IME or clipboard for remote clients yet.
- Pop out, "To display N", adding a window from Elsewhere to the thread (tags) and launching apps from the launcher are shell-only.
- JPEG frames: fine on a LAN or tailnet, not tuned for slow links.

## Verified (2026-10-28, slot 25, X11)

T3 opened at `http://localhost:6273` (a non-shell origin, paired with `plutonium hydra pair`) in the session's browser: Apps listed a KWrite started in the thread; its tab showed the window's frames; a click on "New File" and typed keys reached it (the title became "Untitled (hi remote) *"). Unit tests: `helper/test/windowStream.test.ts`, T3's `windowStream.test.ts` (server) and `remoteWindows.test.ts` (web).
