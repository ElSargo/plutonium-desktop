# Screenshots, screen sharing and recording

Status: built on branch `capture` (patches "screen capture for shells, capture requests to the focused shell" and "PipeWire video nodes for captures, getDisplayMedia asks the shell"); being verified. What's left is in `BACKLOG.md`, "Capture and sharing". "How it's built" below says where each part is.

There's one capture primitive in Ash, and three kinds of consumer use it: native apps through the desktop portal, shell pages, and agents. The shell the user has in focus runs the UI: the picker, the indicators and the stop buttons.

```
          ┌──────────── Ash: capture sessions (a viz capturer per source) ─────────┐
sources:  output · window (parked or not) · tab · a region of any of these
          └──────┬───────────────────────┬──────────────────────────┬─────────────┘
                 │ PipeWire node          │ MediaStream / PNG         │ PNG, later video
                 ▼                        ▼                           ▼
   native apps through the portal  shell pages (trusted)      agents (MCP, own thread)
   OBS, Discord, Zoom, Firefox     picker, screenshots,       snapshot_*,
                                   recording, thumbnails      start_recording
```

## What exists

- **Window snapshots** (patch 0005): a viz `CopyOutputRequest` on the window's surface, cropped to the window. It works while the window is parked, because parked windows keep drawing (patch 0010).
- **Tab frames** (patch 0007): a `FrameSinkVideoCapturer` on a hidden tab's view.
- **Agents** take PNGs of their thread's windows and tabs (`snapshot_window`, `snapshot_tab`), and record them (`start_recording`, Agents below).

Built since (below): the portal backend (ScreenCast, Screenshot, GlobalShortcuts), PipeWire output, a shell API, and getDisplayMedia from tabs through the shell's picker.

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

- `org.freedesktop.impl.portal.ScreenCast`, `Screenshot`, `GlobalShortcuts` and `FileChooser` (`TAB_FEATURES.md`, "One picker with the FileChooser portal"), and `Print` under a name of its own (`TAB_FEATURES.md`, "The Print portal"). `RemoteDesktop` may come later.
- Files: `plutonium.portal`, plus `plutonium-portals.conf`, which chooses our backend for these interfaces. `plutonium-print.portal` names the Print backend, `printportal.py`. The rest stay with the GTK backend until our own backend covers them (`BACKLOG.md`, "Our own portal backend for the rest").
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
- **Recording** (`start_recording {window_id | tab_id, path?}`, `stop_recording {recording_id?}`; `helper/src/recordings.ts`): the helper's "start" capture command, as the portal's, with the consumer `{kind: "agent", thread, name}`. So it goes to every shell as `capturestart` and any shell can stop it. The helper writes the PipeWire node to a WebM file with GStreamer on the host (`gst-launch-1.0 -e pipewiresrc path=<node> keepalive-time=500 ! videoconvert ! vp8enc ! webmmux ! filesink`; without GStreamer, start says what to install). Stop sends the encoder EOS and stops the capture. A capture a shell stops (or the switch, or the source closing) ends the encoder; `stop_recording` still returns the file, with `ended` saying why. Frames come with damage, and the last one is repeated every 0.5 s while the source is still. The file is in `$TMPDIR/plutonium-recordings` unless `path` says.
- If recording is switched off globally, start fails with the switch's error.
- **T3 Code** offers `start_recording` and `stop_recording` for windows. Its `preview_recording_start`/`stop` for its preview tabs stay its own recorder: CDP screencast frames into a MediaRecorder in a hidden page of Plutonium's browser (the helper's "scratch" page), with the agent's pointer and clicks drawn in, and the file handed over as a T3 attachment. That recorder is no capture: shells don't see it, and the recording switch doesn't refuse it (BACKLOG).

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

## How it's built

**Ash: `chrome/browser/plutonium_capture.{h,cc}`** (`PlutoniumCapture`), one registry of captures and requests.
- **Sources** are JSON objects `{type: "output" | "window" | "tab", id, region?}`. An output's id is the display id as a string (display ids don't fit in a JSON number); outputs come from the display list (`display::Screen`). `region` is in the source's pixels.
- **Screenshots:** an output is a copy of its root window's layer (`ui::GrabWindowSnapshot`), a window is `EmbeddedWindows::Snapshot()` (also parked), a tab is `PlutoniumTabs::Snapshot()`; then cropped.
- **A shell's MediaStream of a window** comes from the window's own frame sink, the one its Exo surface tree submits to (patch 0054: the DesktopMediaID is the surface's host window, and `AuraWindowVideoCaptureDevice` captures a non-root window that embeds a client's sink from that sink). So it's the whole window, also where it's partly off the screen or held at a capture size bigger than it (Chromium's own window capture, a subtree of the screen's frame, is clipped to the screen). Frames come while the surface is drawn somewhere, on the screen or in a shell that shows it: a parked window that nothing shows gives none. PipeWire captures, which use the window's own copies, cover that case (below). Client-side shadows are in the frame.
- **A shell's MediaStream:** the "stream" command registers a desktop stream id for the shell document (`DesktopStreamsRegistry`), and the library calls `getUserMedia({video: {mandatory: {chromeMediaSource: "desktop", chromeMediaSourceId}}})`. Chrome's own capture devices do the rest: an output is its root window, a window is its widget's aura window (a subtree capture of the root's frame: `MakeWindowCapturable()` keeps it drawn while parked at zero opacity), a tab is its `WebContents`. `DesktopCaptureAccessHandler` hands the capture its `MediaStreamUI`, wrapped (`WrapStreamUI()`), so the capture starts and stops with the stream and `stopCapture()` really stops it; Chrome's "is sharing your screen" notification is left out, since the shells show it. A region is cropped in the library (`MediaStreamTrackProcessor`, `VideoFrame.visibleRect`).
- **PipeWire** (`chrome/browser/plutonium_pipewire.{h,cc}`, `PlutoniumScreencast`): the "start" command, for the portal.
  - Frames: for an output or a tab, a `FrameSinkVideoCapturer` on the same targets, ARGB in shared memory. A tab's is a hidden capture with no size (the page keeps its own), and a navigation to another site, which gives the page a new view, gets a new capturer on that view. For a window, its own copies as it draws (`plutonium_agent::WindowScreencast`, as agents' screencasts, at most 30 a second): a window's subtree of the screen's frame only covers what fits on the screen, so this is what lets OBS record a parked window, or one held at 1080p on a smaller screen.
  - Each frame is copied into a PipeWire buffer (MemFd, else MemPtr; BGRx or BGRA) of a driver stream (`PW_STREAM_FLAG_DRIVER`, `pw_stream_trigger_process()` per frame), at the source's size when it started, letterboxed after. Frames come with damage: a still screen sends none after the first.
  - Cursor: hidden, embedded (a capturer overlay with the cursor image), or metadata (`SPA_META_Cursor`, the image only when it changes). A window's capture has none (the pointer isn't over a window off the screen).
  - libpipewire is `dlopen()`ed, with no configuration (`config.name=null`; it loads the protocol, client-node and adapter modules itself): the images have `libpipewire-0.3-0t64`, `libpipewire-0.3-modules` and `libspa-0.2-modules`, not PipeWire's `client.conf`.
  - dmabufs: a node offers XRGB/ARGB8888 dmabufs with the linear modifier first (a mandatory modifier property, so only consumers that import dmabufs take them), then shared memory. With a dmabuf format, buffers are GBM buffers on the first render node (one device per stream), their fds exported to the consumer, and each frame is written through the buffer's mapping (still a CPU copy, but the consumer gets a buffer its GPU imports). Without a render node, shared memory only.
- **`ext-image-copy-capture-v1`** (`components/exo/wayland/ext_image_copy_capture.{h,cc}`): for Wayland clients that capture the screen themselves, such as grim (wf-recorder only speaks wlr-screencopy; wl-screenrec wants dmabufs, see BACKLOG). Output sources only (Exo has no foreign toplevel list), no cursor. A session asks as the portal does (the focused shell's picker, else Ash's; both switches on, as it can be a screenshot or a recording), runs as a capture of kind "wayland" that any shell can stop, and a client that goes away while asked closes its picker. Each frame is a copy of the output's root layer written into the client's shared-memory buffer. Full damage each frame. No dmabufs: wl-screenrec allocates its encoder's tiled ones whatever modifiers are offered, which only a GPU copy could fill.
- **Requests:** `Request()` sends a "capturerequest" to `FocusedShell()` (one function, for EXO-MULTIMON to make per-display). If it doesn't take it (no listener, or no `preventDefault()`), or goes away before answering, Ash's own picker asks (`chrome/browser/ui/ash/main_extra_parts/plutonium_capture_ui.{h,cc}`). An answer is checked against the request's types and against the sources there are.
- **The indicator:** every capture goes to every shell; the focused shell's library says it shows it ("acknowledge"). After 2 s unacknowledged, Ash shows its own strip in the top right corner, a Stop button per capture.
- **The switches:** `plutonium.capture` in local state, `{recording, screenshots}`. Switching recording off stops every capture. They cover shells, the portal and tabs' getDisplayMedia. Agents' `snapshot_window` and `snapshot_tab` are views of their own thread's items, not screenshots of the user's screen, and stay on.
- **A window's capture size** (`EmbeddedWindows::SetCaptureSize()`): the newest running capture that holds one sets the size the app is asked for, whatever its elements ask; a captured window keeps drawing at full rate (`KeepDrawing()`).
- **getDisplayMedia** (shell mode): `DesktopMediaPickerFactoryImpl` makes a picker that sends the same request; the answer is a `DesktopMediaID`, and `DisplayMediaAccessHandler` wraps its UI as for a shell's stream (a capture of kind "display").

**The broker** (`navigator.windowBroker`): `screenshot(sourceJson) → Blob`, `captureCommand(command, argsJson) → JSON`, and `ShellCaptureEvent`s: "capturerequest" (cancelable), "capturerequestend", "capturestart", "capturechange", "capturestop", "capturesettingschange". Commands: "sources", "list", "settings", "setSettings", "stream", "stop", "acknowledge", "setSize", "answer".

**The DevTools Plutonium domain** (the helper): `captureCommand` ("sources", "list", "settings", "stop", "setSize", "request", "cancelRequest", "start"), `screenshot`, and the `captureEvent` event.

**The shell library** (`helper/web/plutonium-shell.js`): `capture(source, {region, size, cursor, frameRate})`, `screenshot(source, {region})`, `saveScreenshot(blob)`, `takeScreenshot({targets})` (the Print UI: the output frozen under a shade; drag a region, click a target, Enter for all of it), `outputSource()`, `captureSources()`, `captures()`, `stopCapture(id)`, `setCaptureSize(id, size)`, `acknowledgeCapture(id)`, `answerCapture(requestId, answer)`, `setCaptureSettings()`, and events "capturestart", "capturechange", "capturestop", "capturesettingschange", "screenshot". connect() options `capturePicker` and `captureIndicator`: the library's own (a dialog with thumbnails; a strip with Stop buttons), `false` (Ash's), or a function.

**Shells:** while the selector is open it has the keyboard: the library blurs the `<native-window>` that has it, and gives it back after. niri binds Print (region or window), Ctrl+Print (the screen) and Alt+Print (the focused window), as niri does; plain binds Print. For keyboards without a Print key (Oliver's laptop), Super+Shift+S does what Print does in both, and in niri Super+Ctrl+Shift+S and Super+Alt+Shift+S do what Ctrl+Print and Alt+Print do. Files go to `~/Pictures/Screenshots` (`POST /v1/screenshots`).

**The portal backend** (`helper/src/portal.ts`): `org.freedesktop.impl.portal.ScreenCast` (version 5) and `Screenshot` (version 2) as `org.freedesktop.impl.portal.desktop.plutonium`, on `$PLUTONIUM_PORTAL_BUS` or the session bus.
- The app's pid comes from the request handle (`/…/request/1_42/…` is `:1.42`) and the bus's `GetConnectionUnixProcessID`; its thread from `/proc`, its name from its desktop entry.
- Restore data is `("plutonium", 1, <JSON>)`: the output by name, a window by app id and title, a tab by URL.
- A capture a shell stops ends its portal session (`Session.Closed`).
- **`PickColor`** asks the focused shell ("pick_color"; the library's `pickColor()`, or its `colorPicker` option: a function, or false for none): the library freezes its output (a screenshot shown full screen), shows the color under the pointer, and a click answers it (Escape cancels). The color goes back as fractions. Without a shell, "other".
- **GlobalShortcuts** (version 1, `helper/src/shortcuts.ts`): `BindShortcuts` asks the focused shell ("bind_shortcuts" over the shell relay; the library's dialog lists each shortcut with the app's preferred key, "Press a key…" to change it, Allow or Don't allow). Bindings are kept per app id in `$XDG_STATE_HOME/plutonium/global-shortcuts.json`, so an app that binds the same ids again (OBS at every start) isn't asked again. Every shell gets the bound combos ("global_shortcuts") and adds them to its `setShellShortcuts` list, so they're caught whatever has the keyboard; the library posts a press and a release to `POST /v1/shell/global-shortcut`, which the portal emits as `Activated` and `Deactivated`. Triggers are the XDG spelling (`CTRL+ALT+p`) with the modifiers CTRL, ALT, SHIFT and LOGO and the common keysyms; others are left unbound. Without a shell to ask, the app's preferred triggers are taken as they are (Ash has no binding dialog of its own). A release is only seen if the key-up reaches the shell's page: holding the key while the focus moves gives the release on blur.
- **FileChooser** (`OpenFile`, `SaveFile`, `SaveFiles`; `helper/src/fileChooser.ts`): the focused shell's file picker, over the app's window (`TAB_FEATURES.md`, "One picker with the FileChooser portal").
- **Print** (`helper/src/printPortal.ts`, `printportal.py`): the focused shell's print dialog, then CUPS (`TAB_FEATURES.md`, "The Print portal").
- Files: `helper/portal/plutonium.portal`, `plutonium-print.portal` and `plutonium-portals.conf`. DRM sessions install them, set `XDG_CURRENT_DESKTOP=Plutonium` for D-Bus activation and systemd, and restart xdg-desktop-portal, so it picks this backend. When the session ends (Ash exits, `plutonium stop`, Ctrl+Alt+Backspace, a crash), the previous value goes back (or it's unset, if there was none) and the portal restarts again, so a desktop on another VT gets its own backends. `PORTAL_SESSION=0` (`plutonium.env`) leaves the portal alone. X11 sessions never touch it.

## Testing

**Verified** on X11 (slot 1, Xvfb, niri and plain, 2026-10-25), with real X input through Ash (xdotool) where marked:

| | |
|---|---|
| Screenshots: output (1600x1000), a region (300x200), a parked window (its geometry, no shadows); a missing source is an error | ✓ |
| Library: saveScreenshot() into `~/Pictures/Screenshots`, numbered within a second | ✓ |
| Shell streams: parked window (its real content), output, cropped region (640x360); "capturestart"/"capturestop"; acknowledged | ✓ |
| A parked window that draws: 52 frames in 2 s while captured | ✓ |
| Capture size: an output at min=max 1280x720 is letterboxed to it; a window held at 1280x720 while shown at the top left | ✓ |
| stopCapture() from the library ends the page's track | ✓ |
| Switches: recording off ends a running stream and refuses new ones (screenshots still work); screenshots off refuses screenshots (NotAllowedError) | ✓ |
| A portal request: niri's library picker, with thumbnails; the answer goes back to the helper | ✓ |
| Ash's picker when the shell leaves it (`capturePicker: false`); Ash's indicator after 2 s when it doesn't acknowledge, and its Stop | ✓ (xdotool) |
| getDisplayMedia from a tab: niri's picker, a window track in the tab, a "display" capture of tab 1 every shell sees | ✓ |
| niri: Print, then a drag (600x400 file) or a click on a tile (the window: 768x947); Ctrl+Print (the screen) | ✓ (xdotool) |
| The portal end to end: `tools/portal-screencast.py` through xdg-desktop-portal 1.22.1 on `tools/portal-bus.sh`'s bus: niri's picker named the client (its process name, pid and thread), Ash's PipeWire node 84 at 1600x1000, GStreamer's `pipewiresrc` through the portal's fd recorded the screen with the cursor drawn in | ✓ |
| A restore token: the second run started without a picker | ✓ |
| PipeWire: a parked window held at 1920x1080 on a 1600x1000 screen (foot snapped to 1920x1066, letterboxed): 40 live frames through `pipewiresrc`; stopping it lets the window go and removes the node | ✓ |
| The portal, a window (`types` 2, cursor metadata): node at the window's size; its restore token brings back the same window by app id and title, without a picker | ✓ |
| The Screenshot portal, interactive: niri's picker, the file's URI back through xdg-desktop-portal | ✓ |
| `grim` (1.5.0) on the session's socket: niri's picker ("grim wants to share your screen"), then a 1600x1000 PNG of the screen (build 2c719f7dbcb2, 2026-10-26) | ✓ |
| A shell's MediaStream of a window (0054, build 3f5ff6241236): foot held at 1920x1080 on the 1600x1000 screen, `shell.capture()` → 1920x1080 frames of the whole window (16 in 3 s from `top -d 0.2`); the first frame can still be the old size, letterboxed | ✓ |
| grim killed while its picker is open: the picker closes (build 39742c2a2d20) | ✓ |
| GlobalShortcuts: `tools/portal-shortcuts.py` on `tools/portal-bus.sh`'s bus: niri's binding dialog (Push to talk: Ctrl+Backquote, Mute: none), Allow; Ctrl+\` through Ash gives `Activated` and, 0.4 s later, `Deactivated` | ✓ (xdotool) |
| PickColor through xdg-desktop-portal: the library's picker, the pointer moved and clicked with xdotool: (27, 57, 73)/255, the X server's pixel there | ✓ (xdotool) |
| PipeWire with dmabufs built in (0052): `pipewiresrc`, which takes shared memory, still gets frames | ✓ |

**On DRM** (tty5, a 2560x1600 panel at scale 1.78, build 5876b575e376, input from `tools/uinput.py`, 2026-10-25): `tools/capture-checks.sh` passed (a screenshot of the output, a shell's stream at 2560x1600, a PipeWire node 2560x1600 whose frames show the real screen, with the pointer drawn in); Print (a dragged region), Alt+Print (the focused window) and Ctrl+Print (the screen) with real keys. Found there: the selector didn't take the keyboard from an app window that had it, so Escape went to the app; the library now blurs the focused `<native-window>` while the selector is open and focuses it again after (checked on X11).

Quirks seen only on Xvfb: Alt+Print arrives with an empty `code` (X maps it to SysRq; on evdev it stays PrintScreen); xdotool's instant `click` is sometimes lost on Ash's own widgets, a press and release 150 ms apart isn't.

- `cd helper && node --test test/portal.test.ts`: restore data, screenshots on disk, and the backend end to end on a private `dbus-daemon`, called as xdg-desktop-portal calls it.
- `tools/portal-shortcuts.py --app-id ID` binds two shortcuts through the GlobalShortcuts portal and prints `Activated`/`Deactivated`. The app id needs a desktop entry the portal finds: on `portal-bus.sh`'s bus, `$XDG_RUNTIME_DIR/plutonium/portal-bus-test/share/applications/ID.desktop`. Start that bus's portal again (`portal-bus.sh start`) after the helper is up, or it has no ScreenCast cursor modes. Don't `stop` the bus while a session's helper is on it: the helper doesn't reconnect, so its portal backend is gone until the session restarts.
- grim reaches an X11 session's socket from the host through Chrome's mount namespace: `WAYLAND_DISPLAY=/proc/<chrome pid>/root/run/user/1000/wayland-plutonium-x11-s<N>`.
- `tools/portal-screencast.py` is a portal client (ScreenCast through `OpenPipeWireRemote` and GStreamer's `pipewiresrc`, or `--screenshot`): with PyGObject and GStreamer, e.g. `nix-shell -p 'python3.withPackages (p: [ p.pygobject3 ])' gst_all_1.gst-plugins-base gst_all_1.gst-plugins-good pipewire`.
- `tools/portal-filechooser.py open|save|save-files` is a FileChooser client (filters, an accept label and two choices), with PyGObject.
- `tools/portal-bus.sh start` gives a private bus with its own xdg-desktop-portal that uses this backend; run the session's helper with `PLUTONIUM_PORTAL_BUS` set to it, and apps with `DBUS_SESSION_BUS_ADDRESS`. Its xdg-desktop-portal finds the files through `XDG_DATA_HOME`, `XDG_DATA_DIRS` and `XDG_CONFIG_HOME` (checked with 1.22.1); its own `XDG_DATA_HOME`, so a `plutonium.portal` a DRM session installed in `~/.local/share` doesn't shadow this checkout's. Its Screenshot portal wants the permission store and an access dialog for non-interactive screenshots, which a bare bus doesn't have.

## Not planned

- **Hiding parts of the screen from capture** (notifications, password prompts). The screen is one composited page, so leaving a layer out needs a separate render for each capture. To keep something private, share a window instead of the screen.
- **Audio through the portal.** The ScreenCast portal doesn't carry audio. Apps capture it from PipeWire themselves.
