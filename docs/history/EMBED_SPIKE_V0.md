# Embed spike v0: native Wayland windows as elements in a web page

Date: 2026-10-15. Branch `exo-viability` (patch: `~/projects/plutonium/patches/exo-viability.patch`; spike changes are tagged `EXO-EMBED`).

## Result

All v0 success criteria are met, demonstrated with KDE `kcalc` (Qt 6) embedded in a plain web page served over HTTP:

| Criterion | Evidence |
|---|---|
| Real surface rendered in the page | `<canvas>.embedSurface(id)` shows kcalc's live Exo surface in normal flow (`shots/spike-a.png`) |
| Scroll | Surface scrolls with the page and is clipped under a sticky header (`shots/spike-a-scrolled.png`) |
| Layers / z-order | A 55%-alpha DOM box composites above the surface (`shots/spike-k-result.png`) |
| Transforms | The same surface inside `rotate(-6deg) scale(.8)` renders correctly |
| Input | Clicking 7 + 3 = on the embedded copy shows 10 (`spike-k-input.png`); clicking × 2 = on the **rotated** copy gives 20. viz maps rotated clicks to the exact button coordinates (`spike-k-result.png`) |
| Page still works | Clicks and wheel over normal page content go to the page as usual |

The real kcalc Ash window stays open but hidden behind the maximised browser window. Rendering and input both go through the page.

## How it works

1. **Rendering (Blink):** `HTMLCanvasElement.embedSurface("client:sink:parentSeq:childSeq:tokenHi:tokenLo")` creates the canvas's existing `SurfaceLayerBridge` (the OffscreenCanvas mechanism) and embeds a `SurfaceRange` whose end has the Exo frame sink and embed token but sequence numbers +2³⁰. viz then always draws Exo's latest surface, including across resizes, without per-frame updates. Layout, scroll, clip, z-order and transforms come from Blink/cc unchanged.
2. **Discovery (Exo):** `SurfaceTreeHost` keeps a registry of live frame sinks and writes the toplevels (`id`, `app_id`, size) to `$EXO_EMBED_REGISTRY` (JSON) when it changes. The page polls it.
3. **Hit-test plumbing:**
   - The canvas's surface layer is marked surface-hit-testable.
   - A new `EmbeddedFrameSinkProvider.RegisterForeignEmbeddedFrameSink(parent, foreign)` mojo call makes the browser register the Exo sink as a viz child of the page's frame sink. viz only accepts child hit-test regions from registered parents.
   - viz's `HitTestManager` rewrites client-id-0 regions to the submitter's client id (renderers use 0 for "self"). Exo sinks really are client 0, so the aggregator now accepts `(0, sink)` when that exact sink is a registered child of the submitter.
4. **Input routing (browser):** `RenderWidgetHostInputEventRouter` does a synchronous viz hit-test on mouse/wheel events. If the target is a frame sink with no `RenderWidgetHostView`, it calls a hook installed by `ExoParts`. The hook converts the Blink event into an aura event and Exo delivers it to the surface under the transformed point. viz supplies coordinates in the surface's own space, with scroll and CSS transforms already inverted.
5. **Exo delivery fixes needed along the way:**
   - Injected events bypass `WindowEventDispatcher`, via a minimal `EventDispatcherDelegate`. Otherwise aura recorded the Exo window as the implicit press-capture target and stole the real mouse-up from the page.
   - Injected events carry an `exo-embedded` event property:
     - `wm::FocusController` skips them, so clicks don't raise or activate the hidden real window.
     - `exo::Pointer` targets the given surface directly, ignoring the browser's aura capture.
   - A synthetic move precedes each injected button or wheel event. Real events reaching the browser window make Exo send `wl_pointer.leave`, and Exo drops buttons without pointer focus.

## Dev loop

All of this ran headless-for-you on a private Xvfb (`:99`) inside the container, with xdotool for input and ImageMagick for screenshots. Nothing touched the Plasma desktop.

```
python3 -m http.server 8765 --bind 127.0.0.1 --directory ~/projects/plutonium/spike &
podman exec -d cros-build Xvfb :99 -screen 0 1600x1000x24 +extension XInputExtension
~/projects/plutonium/tools/launch-cros-spike.sh <tag> <client command>   # restarts Ash, opens page via CDP, starts client, screenshots
```

Test page: `~/projects/plutonium/spike/index.html`.

## Known v0 limitations (deliberately out of scope)

- **No access control:** any renderer can register any browser-owned frame sink as its child and inject input into it. A real version needs a browser-issued grant per page and window.
- **The real Ash window still exists.** It must stay visible (minimised windows get no input) and is just covered by the browser. Next step: detach or park it, so the page is its only presentation.
- **Mouse only:** button, move, drag and wheel. No keyboard/IME focus, cursor shape, touch, drag-and-drop or clipboard.
- **No resize feedback:** the element size isn't sent to the app as `xdg_toplevel.configure`. The page sizes the canvas to the app.
- **Popups and menus** still open as separate Ash windows, not inside the page.
- **Overlapping DOM above the surface doesn't block input:** viz marks such regions "ask the renderer" and the hook ignores that. The red overlay uses `pointer-events: none`, so this wasn't exercised.
- **Enter/leave churn:** every real mouse event currently produces leave + enter on the client (harmless for clicks; hover may flicker).
- **Software path only so far:** tested with shm buffers on Xvfb. The DRM/dmabuf path composites the same `SurfaceDrawQuad`s and should behave the same, but isn't verified.
- Diagnostic `EXO-EMBED` logging is still on.

## Files touched by the spike

`third_party/blink/.../html_canvas_element.{idl,h,cc}`, `platform/graphics/surface_layer_bridge.{h,cc}`, `third_party/blink/public/mojom/frame_sinks/embedded_frame_sink.mojom`, `content/browser/renderer_host/embedded_frame_sink_provider_impl.{h,cc}`, `components/input/render_widget_host_input_event_router.{h,cc}`, `components/viz/service/hit_test/hit_test_aggregator.cc`, `cc/trees/hit_test_data_builder.cc` (logging only), `components/exo/{surface_tree_host.{h,cc},shell_surface_base.{h,cc},pointer.cc}`, `ui/wm/core/focus_controller.cc`, `chrome/browser/exo_parts.cc`.
