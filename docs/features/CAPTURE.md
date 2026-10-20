# Screenshots, screen sharing and recording

Status: design, nothing built yet. The tasks are in `BACKLOG.md`, "Capture and sharing".

There's one capture primitive in Ash, and three kinds of consumer use it: native apps through the desktop portal, shell pages, and agents. The shell the user has in focus runs the UI: the picker, the indicators and the stop buttons.

```
          ┌──────────── Ash: capture sessions (a viz capturer per source) ─────────┐
sources:  output · window (parked or not) · tab · a region of any of these
          └──────┬───────────────────────┬──────────────────────────┬─────────────┘
                 │ PipeWire node          │ MediaStream / PNG         │ PNG, later video
                 ▼                        ▼                           ▼
   native apps through the portal  shell pages (trusted)      agents (MCP, own thread)
   OBS, Discord, Zoom, Firefox     picker, screenshots,       snapshot_* today,
                                   recording, thumbnails      recording later
```

## What exists

- **Window snapshots** (patch 0005): a viz `CopyOutputRequest` on the window's surface, cropped to the window. It works while the window is parked, because parked windows keep drawing (patch 0010).
- **Tab frames** (patch 0007): a `FrameSinkVideoCapturer` on a hidden tab's view.
- **Agents** take PNGs of their thread's windows and tabs (`snapshot_window`, `snapshot_tab`). T3's browser panel reports recording as unsupported (`startScreencast` in its patch 0005).

Not there yet: a portal backend, PipeWire output, a shell API, routing getDisplayMedia from tabs, and global shortcuts.

## Decisions

| Question | Decision |
|---|---|
| Who runs the UI for a request | The shell the user has in focus. Shells show windows, they don't own them, so a request isn't routed by thread. If the focused shell has no picker, Ash's fallback picker opens. |
| What the picker offers | Every output, window and tab, whatever its thread or shell. Grouping them by shell is fine. |
| Agents | No permission dialogs: consent is up to the harness. An agent reaches only its own thread's items, as it does now. |
| Turning it off | One global setting that refuses recording to everyone (portal, tabs, shells, agents). Screenshots have a separate switch. Ash enforces both. |
| Frame transport | Ash produces the PipeWire streams itself, rather than Exo implementing `ext-image-copy-capture-v1` for an external portal. Tabs and page regions aren't Wayland surfaces, and the capturer's frames are already GPU buffers. `ext-image-copy-capture` can come later, for grim and wf-recorder. |
| Size | A capture can set a window's size, separately from how the shell lays the window out (below). |

## Sources

| Source | How Ash captures it |
|---|---|
| Output | The root window's frame sink: what the screen shows, including the shell page. |
| Window | The Exo surface's frame sink. It keeps working when the window is parked or on another workspace, so OBS can record a window that isn't on screen. |
| Tab | The `WebContents`' frame sink, as in patch 0007. |
| Region | A crop of any of the above, for region screenshots and recording part of the screen. |

Cursor modes follow the portal: hidden, embedded, or metadata (position and image sent alongside the frames). OBS prefers metadata.

## Shells

Shells get these through the broker, wrapped by the shell library. The names are drafts.

- **Capture directly, with no picker.** A shell is already trusted with every window.
  - `shell.capture(source, { size?, cursor? }) → MediaStream`
  - `shell.screenshot(source, { region? }) → Blob`
  - One primitive covers several features:
    - Print: the shell draws a region or window selector in the DOM, then crops.
    - Recording to a file with `MediaRecorder`.
    - Live window thumbnails, such as niri's overview or the overlay, using `<video>`.
- **Answer requests.** A request goes to the focused shell only:
  - `capturerequest {id, consumer: {appId, pid, thread} | {tab}, types, multiple, cursorModes}`
  - The shell answers with `shell.answerCapture(id, { sources, size? })` or with a refusal.
  - If the shell doesn't answer, or registers no handler, the fallback picker opens. A request never hangs.
- **Follow captures.** Every shell gets `capturestart` and `capturestop` with the source, consumer, size and thread, including for captures that had no picker: a restored OBS source, or an agent recording. `shell.captures()` lists the live ones, and `shell.stopCapture(id)` revokes one. Any shell can stop any stream.
- **An indicator is guaranteed.** A shell is expected to show something, such as a dot or an outline around the captured window. If the focused shell doesn't acknowledge a capture, Ash draws its own indicator.

### Resizing for capture

The page already sizes the windows it embeds, and `object-fit` already places a frame that doesn't match its box (`WINDOW_SIZING.md`). A capture can add a size of its own:

- `capture.setSize(source, {width, height})`, or a size chosen in the picker. While it's set, it overrides the element's size in the window's `xdg_toplevel.configure`.
- The element keeps the window's place in the layout and shows the frame with `object-fit: contain`. The shell can choose to show a hint that the window is held at a capture size.
- When the last capture holding a size stops, the element's size takes over again.
- If the app picks a different size (terminals snap to cells, some apps have minimum sizes), the stream takes the frame the app produces and letterboxes it to the asked size. It doesn't scale.
- This works for parked windows too: a window that isn't on screen can be recorded at 1080p.

To check: Exo must keep sending frame callbacks to a parked window while it's captured. Snapshots work while a window is parked, but steady frame pacing hasn't been tested.

## The portal backend

`plutoniumd` implements the backend side of xdg-desktop-portal on the session D-Bus:

- `org.freedesktop.impl.portal.ScreenCast`, `Screenshot` and `GlobalShortcuts`. `RemoteDesktop` may come later.
- Files: `plutonium.portal`, plus `plutonium-portals.conf`, which chooses our backend for these interfaces. The rest (file chooser, and so on) stay with the GTK backend until our own backend covers them (`BACKLOG.md`, "Our own portal backend for the rest").
- The session sets `XDG_CURRENT_DESKTOP=Plutonium` and passes it to D-Bus activation (`dbus-update-activation-environment`).

A ScreenCast request runs like this:
1. The helper finds the app from the request: the app id, and the pid from the D-Bus connection's credentials.
2. It sends a `capturerequest` to the focused shell and waits for an answer.
3. It asks Ash to start a capture session for each chosen source.
4. Ash publishes each one as a PipeWire video node, with dmabuf and negotiated modifiers, plus a shared-memory fallback.
5. The helper returns the node ids to the portal.

**Restore tokens.** With `persist_mode`, the helper stores a token that names something stable rather than a window id: "the output", or an app id plus a title pattern. When a token comes back, the picker is skipped and the capture still goes to every shell as `capturestart`. OBS depends on this, or it would ask on every launch.

**Screenshot** with `interactive: true` uses the picker. With `interactive: false`, it returns the output without asking, unless screenshots are switched off.

**Where PipeWire lives.** Ash can reach `$XDG_RUNTIME_DIR/pipewire-0` because the runtime dir is shared with the host. The container image needs libpipewire. For Chromium:
- WebRTC's PipeWire code is consumer-only, and its `rtc_use_pipewire` is `is_linux && use_sysroot`, which is false for `target_os = "chromeos"`.
- So the producer is our own code. It can use the same dlopen stubs (`third_party/webrtc/modules/portal`) or link libpipewire directly.

## Tabs

getDisplayMedia from a tab goes to Ash's `DesktopMediaPicker`. That picker is replaced by the same `capturerequest` to the focused shell, so a tab and a native app asking for a capture look the same to the user. The stream stays inside Chromium (a `DesktopMediaID` backed by the same capture session), so no PipeWire is involved.

## Agents

- Agents capture only their thread's windows and tabs, with no dialogs.
- Recording over MCP comes later, built on the same capture session, with output to a file. Each recording goes to every shell as `capturestart`, so the user can still see it and stop it.
- If recording is switched off globally, the tools return an error that says so.

## Apps

**Discord (native Wayland client).** Discord's Linux client has added Wayland features one at a time. It uses four separate pieces:

| Discord feature | Plutonium's side |
|---|---|
| Screen and window share | ScreenCast portal, PipeWire node from Ash |
| Screen-share audio | Captured by Discord itself, not the portal (see below) |
| Push-to-talk | GlobalShortcuts portal |
| Idle/away status | `ext-idle-notify-v1`, which Exo lacks (it has `zwp_idle_inhibit` only) |

- **Audio.** Reports disagree: some say Discord shares all system audio rather than the shared app's, others say apps that talk to PipeWire directly aren't heard.
  - If it takes the default monitor, nothing is needed.
  - If it looks for a per-app node, the helper can publish one: it knows the shared window's pid, so it can find that app's audio streams. This is what Vesktop's venmic does.
  - Test this before building anything.
- **Push-to-talk.** The helper answers the GlobalShortcuts portal, and the focused shell runs the binding UI. Shells already see keys before apps do (`setShellShortcuts`), so a bound key is caught and reported as activated or deactivated. OBS hotkeys use the same portal.
- **The XWayland Discord can't share anything here.** Each thread has its own rootless Xwayland, so X11 capture only sees that X server. So the thread environment sends Electron apps to Wayland, next to `GDK_BACKEND` and `QT_QPA_PLATFORM` (`helper/src/threads.ts`): `ELECTRON_OZONE_PLATFORM_HINT=wayland` for older Electron, and `XDG_SESSION_TYPE=wayland` for Electron 38 and later, which ignore the hint and pick Wayland by the session type. Checked with Electron 41 and 43 launched in a thread: Wayland windows, no X connections. If that breaks some app, set them per app instead. Electron 43 blanks its `/proc/<pid>/environ`, so the helper resolves what it launched by pid (`helper/README.md`, pid → thread). Any X11 app that captures with XComposite has the same problem.
- **Discord in a tab** goes through the getDisplayMedia path above.

**OBS.** PipeWire Screen Capture, through the portal:
- Restore tokens matter most.
- Cursor metadata mode should be supported.
- Window capture of parked windows works.
- Hotkeys go through GlobalShortcuts.

## Not planned

- **Hiding parts of the screen from capture** (notifications, password prompts). The screen is one composited page, so leaving a layer out needs a separate render for each capture. To keep something private, share a window instead of the screen.
- **Audio through the portal.** The ScreenCast portal doesn't carry audio. Apps capture it from PipeWire themselves.
