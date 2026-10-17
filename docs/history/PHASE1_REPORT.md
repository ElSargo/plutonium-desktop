# Phase 1: solid embedding core

Date: 2026-10-15. Branch `exo-viability`, patch `patches/exo-phase1.patch` (all Chromium changes against `9f2eedcd653d`, a superset of `exo-viability.patch` that replaces the spike's `canvas.embedSurface`). Phase 1 code is tagged `EXO-EMBED`. Day-by-day status is in `PHASE1_PROGRESS.md`.

## Result

The exit criterion is met on the Xvfb dev loop. KDE `kcalc` (Qt 6), `gtk4-demo` (GTK 4) and Firefox run side by side as `<native-window>` elements in one page (`shots/phase1-multi3.png`). In each of them:

- typing works;
- menus open above the page;
- resizing the element resizes the app;
- wheel and page scrolling work;
- rapid-capture checks show no flicker.

foot and `weston-editor` (text-input-v1) also work.

| # | Item | Result | Evidence (`shots/phase1-*.png`) |
|---|---|---|---|
| 1 | Pointer focus churn | ✅ One `enter` per entry, one `leave` per exit. A drag that leaves the element still delivers the release to the app. The synthetic re-enter hack is gone | Exo pointer logs |
| 2 | Keyboard focus and IME | ✅ Clicking an app gives it the keyboard and clicking page content takes it back. Focus moves between apps. `zwp_text_input_v1` activates on the embedded surface and hands back to the page | `gtk-type2`, `ff-type`, `ime2`, `foot` |
| 3 | Cursor shapes | ✅ The app's cursor shows over the app and the page's cursor elsewhere. GTK switches I-beam/arrow correctly every time | `tools/xcursor_probe.c` output |
| 4 | Resize feedback, incl. fractional scale | ✅ Element size → `xdg_toplevel.configure`, following a live CSS `resize` drag. At 1.25× the 420×330 CSS-px element gives a 420×330 DIP window, rendered sharp; clicks map exactly (7+2=9) | `resize`, `flick-mid`, `frac`, `frac-zoom`, `frac-input` |
| 5 | Detach from Ash windows | ✅ Parked windows are invisible, untargetable, unactivatable and floated. Removing the element puts the window back on the desktop at its embedded size; a new element re-parks it | `detached5`, `reattached` |
| 6 | Popups and menus | ✅ kcalc menus, GTK popover, Firefox tab list and URL dropdown open anchored to the element, above the page. Pressing outside a popup closes it | `final-menu`, `gtk-menu`, `ff-menu`, `final-pop` |
| 7 | Async hit-test correctness | ✅ DOM above a window (the red overlay, the sticky header over a scrolled-under window) gets the click and the app does not | `final-pop` (overlay count 1, kcalc unchanged), `scrolled-input` |
| 8 | Multiple windows and `<native-window>` | ✅ Three apps plus a GTK dialog (which becomes its own window and goes away on close) | `multi3`, `gtk-about` |

Flicker measurement (`tools/flicker_check.py`, ~30 ms per frame):
- **Drag-resizing GTK:** at most 0.2% of the element showed the grey backdrop, a sliver at the growing edge. No black or empty frames.
- **Page scrolling:** at most 0.1% across both card columns.

## How it works

**The element.** `<native-window window="ID">` is a Blink replaced element (`HTMLNativeWindowElement` + `LayoutNativeWindow`).
- It reflects `windowState`, `windowTitle`, `appId`, `windowWidth`/`windowHeight` and `windowFocused`, and has `focusWindow()`/`blurWindow()`.
- It fires `windowchange`, `windowfocus`, `windowblur` and `windowclose`.
- It paints a `cc::SurfaceLayer` for the range [current surface, +2³⁰], so viz always draws the latest frame, including mid-resize.
- Without a CSS size it takes the window's size. With one, it asks the window to resize (pixels ÷ device scale factor → DIPs).

**Browser side.** `NativeWindowHost`/`NativeWindowClient` mojo (`third_party/blink/public/mojom/native_window/`) is served by `ExoEmbedder` in `chrome/browser/exo_embedder.cc`, a `DocumentService` per element. On attach it:
1. registers the Exo frame sink as a viz child of the page's frame sink (refcounted);
2. parks the window;
3. streams the window's info to the element.

**Exo side.** `exo::EmbeddedWindows` (`components/exo/embedded_windows.cc`) does the following:
- assigns ids to toplevels and publishes the registry (`$EXO_EMBED_REGISTRY`);
- counts attachments and parks the window while it has any;
- sends sizes;
- owns embedded keyboard focus;
- injects mouse events.

**Input routing.** `RenderWidgetHostInputEventRouter` first asks viz which frame sink is under the pointer.
- **Clean hit on a foreign (view-less) sink:** the event goes straight to Exo.
- **Region marked "ask":** the renderer decides through the normal targeter. `WebFrameWidgetImpl::GetFrameSinkIdAtPoint` returns the window's sink only where the element itself is hit. So DOM above the window wins, and event order is kept behind pending queries.

Around that:
- Drags are captured by whichever side they started on.
- Leaving the element sends an explicit synthetic `leave`.
- A press on page content clears embedded keyboard focus.

**Keyboard.** `Seat::SetEmbeddedFocus` makes the embedded surface the keyboard target while the browser window keeps aura focus.
- `exo::Keyboard` installs a pre-target handler on the page's view and stops propagation, so the page doesn't also get the keys.
- `ShellSurface` reports `activated` while embedded-focused.
- When an app that used text input loses focus, the browser hands the input method back to the page's view.

**Cursor.** While embedded, `exo::Pointer` sends its cursor to `CursorManager::SetForeignCursor` on the page's view instead of setting it globally. Injected events are tagged so Ash's `CompoundEventFilter` leaves the cursor alone.

**Popups.** Parked windows float, so `xdg_popup`s (which go into their parent's container) show above the browser. Pressing outside the client's surfaces releases the popup grab, as xdg_popup grabs require (Qt relies on this).

## Bugs found and fixed this phase

- **Cursor reset to Chrome's arrow.**
  - **Cause:** injected events ran through Ash's `CompoundEventFilter`, which set the cursor from the parked window (`kNull`). A client's second `wl_pointer` that never set a cursor also pushed `kNull`.
  - **Fix:** new `wm::kSkipCursorUpdateEventKey` event property; `kNull` is not forwarded.
- **Page typing dead after an embedded text-input client.**
  - **Cause:** Exo took the browser window's input method and left no client on deactivation.
  - **Fix:** `ExoEmbedder` restores the page view's `TextInputClient` when the window loses keyboard focus or closes.
- **Detached window shrank to its minimum size.**
  - **Cause:** the size was read after moving the window back to the default container, which clamps it.
  - **Fix:** read the size first and restore the pre-park position.
- Earlier in the phase:
  - press/release ordering, drag capture and balanced enter/leave;
  - DOM-over-window input blocking via the renderer targeter;
  - popup dismissal on outside press;
  - keyboard routing.

## Known issues and limits

- **A client whose dmabufs can't be imported stalls the whole display.** gtk4-demo's Vulkan renderer on Xvfb (no native pixmaps): the GPU process logs ~80k shared-image failures and stops presenting. This isn't specific to embedding, but one bad client freezing everything needs a guard. Tests used `GSK_RENDERER=cairo`. On real DRM hardware dmabuf import works (see `TTY_REPORT.md`).
- **Firefox's cursor sometimes lags one move.** The same happens when Firefox is a normal Ash window (it pairs a new image with the previous hotspot), so it isn't an embedding bug.
- **Only text-input-v1 is supported**, which Exo already had. GTK 4, Qt and foot use v3, so IME composition works only for v1 clients for now. No IME engine runs on this Xvfb Ash, so composition (pre-edit/commit) wasn't exercised. Activation, focus handoff and surrounding text were.
- **Modal dialogs** become separate embeddable windows. While one is open the parent ignores input and keys go to the dialog, but the page still shows the parent as keyboard-focused. Where dialogs go is a Phase 2+ policy question.
- **Firefox doesn't receive TILED states** (it binds an older xdg-shell), so it keeps its CSD shadow; geometry offsets handle that. Its minimum width is 500 px, so a 420 px element clips it.
- **Page zoom** changes the element's pixel size, and the window gets more DIPs rather than larger content. It's consistent, but it may not be what users expect.
- **No access control yet:** any page can attach any window (Phase 2 grants).
- **Testing was Xvfb + shm only.** The DRM/dmabuf path wasn't re-run for Phase 1.

## Dev loop

```
tools/launch-phase1.sh <tag> "<client cmd>"...   # restarts Ash on Xvfb :99, opens spike/phase1.html, starts clients, screenshots
tools/cdp_eval.py phase1 '<js>'                   # evaluate in the test page (run inside cros-build)
tools/xcursor_probe [out.ppm]                     # current X cursor: size, hotspot, pixel hash (build from xcursor_probe.c)
tools/flicker_check.py OUT N name:x,y,w,h ...     # rapid screenshots + backdrop/black coverage per rect
```

Env for the launcher: `PM` (podman wrapper), `PAGE_QUERY` (e.g. `?w=420&h=330`, `?auto=1`), `EXTRA_FLAGS` (e.g. `--force-device-scale-factor=1.25`).

## Files

- **New:**
  - `components/exo/embedded_windows.{h,cc}`
  - `chrome/browser/exo_embedder.{h,cc}`
  - `third_party/blink/public/mojom/native_window/native_window.mojom`
  - `third_party/blink/renderer/core/html/html_native_window_element.{h,cc,idl}`
  - `third_party/blink/renderer/core/layout/layout_native_window.{h,cc}`
- **Changed:**
  - **Exo:** `seat`, `keyboard`, `pointer`, `shell_surface{,_base}`, `wayland/xdg_shell.cc`
  - **Input:** `render_widget_host_input_event_router`, `render_widget_targeter`, `cursor_manager`
  - **Blink:** `web_frame_widget_impl.cc`, element/style/tag registrations
  - **Ash/wm:** `ui/wm/core/compound_event_filter`
  - **Browser:** `exo_parts`, `chrome_browser_interface_binders.cc`, BUILD files
- **Kept from the spike:**
  - `components/viz/service/hit_test/hit_test_aggregator.cc`: accepts a browser-owned child sink in a renderer's hit-test data once it is registered as that renderer's child.
  - `ui/wm/core/focus_controller.cc`: injected events don't activate the parked window.
- **Removed from the spike:** `canvas.embedSurface`, `EmbeddedFrameSinkProvider.RegisterForeignEmbeddedFrameSink`, the `SurfaceTreeHost` registry, the synthetic re-enter.
