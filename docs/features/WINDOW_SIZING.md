# Window sizing and animation

How a `<native-window>` sizes its app, what happens when the app wants another size, and how a shell animates windows. `chromium/patches/0017-*`, `0018-*` and `0019-*`. Tested on Xvfb (`plutonium run --x11`, plain and niri shells, GTK 4 apps) on 2026-10-18.

## The page sizes the window

CSS decides who owns the size:
- **No CSS size** (`width`/`height: auto`): the element takes the window's size, whatever the app chooses.
- **A CSS size:** the window is asked to take the element's content box (`xdg_toplevel.configure`).
- **One of each:** a fixed width with an auto height works too.

While a page shows a window, nothing else sizes it (0017):
- **The app's requests** (maximize, unmaximize, minimize, an interactive move or resize from its title bar or edges) don't change it. The app is answered with its state unchanged, and the request goes to the page as an event (below).
- **Anything in Ash that changes its state or size** (maximize, snap, float, PiP, a resize) is undone just after: the window goes back to the normal state at the page's size.
- **Bigger than the screen:** the window isn't clamped to the work area, so an element may be bigger than the screen.

Before 0017, an app's maximize button made Ash resize the window to the work area while its element kept its size. A 1600×1000 window then drew inside a 1380×875 element.

## When the frame and the box differ: `object-fit`

The app's frame isn't always the content box's size. The app may not have redrawn after a resize yet, it may refuse the size (a minimum size, a fixed-size game), or it may snap to whole cells (terminals). `object-fit` and `object-position` place the frame, as for `<video>` (0018).
- **Default:** `object-fit: none` at `0 0`. The frame is shown as the app drew it, at the top left. Stretching a terminal a few pixels short of the box would blur its text.
- **Fullscreen:** `none`, centered.
- **`contain` / `scale-down`:** for a fixed-size app the page wants scaled into its box.

## Cross-fade: animating a window's size

`crossfade="MS"` on the element (0018) works the way niri and Hyprland animate a window:
1. When the page resizes the element, the frame from before the resize stays on top, stretched to the new content box. That frame is the window's surface at the old size, kept alive in viz by its exact id.
2. Once the app has drawn at the new size (or after 500 ms, if it doesn't), the old frame fades out over MS milliseconds, revealing the live window.
3. Resizes less than 100 ms apart (a drag) show the app live instead: a stretched frame over a window that keeps up would only smear.

To animate a window's size, a shell combines it with FLIP:
1. Set the element to its final size at once, so the app is configured once.
2. Animate a `transform: scale()` from the old size to none (`transform-origin: 0 0`).

The shell's own frame (border, shadow) can animate its `width`/`height` alongside. The niri shell does this in `placeTile()`, with the crossfade set to its `--anim` duration.

## Requests: `windowrequest`

The element fires a `windowrequest` event (`NativeWindowRequestEvent`), which doesn't bubble (0019):
- **`request`:** `"maximize"`, `"unmaximize"`, `"minimize"`, `"move"` or `"resize"`.
- **`edge`:** for a resize, the edge or corner to resize from (`"top"`, `"bottom-right"`, …).

The page decides what each request means. The niri shell maps maximize/unmaximize to maximize column. T3 Code maps them to the panel's maximize. Fullscreen requests work as before (`CONTROLS.md`).

## Several elements on one window

One element drives the window: its size is the window's, and it gets the requests. It is chosen in this order:
1. The fullscreen one.
2. The one the user last pressed in.
3. One on screen (intersecting the viewport).
4. The last attached.

Only the visible shell's elements count. When the driver changes, the window takes the new driver's size. Each element reports its on-screen rect, so the browser can tell which element a press on the window landed in.

## Verified

| | Result |
|---|---|
| App maximize/unmaximize/minimize (GTK 4, `gtk_window_maximize()` etc.) in the plain shell | configure answers at the element's size (1380×875), never maximized; three `windowrequest` events with the right `request` |
| Same, the prebuilt image without 0017 | configure 1600×1000 maximized; window 1600×1000 in a 1380×875 element |
| Element 1380 → 800 px, `crossfade=3000` | old frame squeezed to 800 px over the new layout, fading out |
| GTK Demo in a 300×300 element (it won't go below 379 px) | `none`: clipped at the top left; `contain`: scaled to fit |
| Second element on the same window | newest on-screen element drives (400×300); off screen → the first drives (1380×875); back → 400×300; removed → 1380×875 |
| niri: the app's maximize | column maximized (768 → 1560 px), app configured once; FLIP plus cross-fade, captured with animations at 1/10 speed |

Not verified: pointer input on a scaled (`contain`) window, and the "last pressed" rule. On Xvfb, neither DevTools nor xdotool input reaches embedded apps. A press-driven driver change needs a session with real input (DRM, `tools/uinput.py`).
