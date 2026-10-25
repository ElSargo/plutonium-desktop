# Window sizing and animation

How a `<native-window>` sizes its app, what happens when the app wants another size, and how a shell animates windows. `chromium/patches/0017-*` to `0020-*`. Tested on Xvfb (`plutonium run --x11`, plain and niri shells, GTK 4 apps and foot) on 2026-10-18.

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

## The box is where the window is

The page's content box is always where the window is drawn, as Hyprland draws a window it is resizing (0020):
- **While the app catches up:** after the page resizes the element, until the app answers by drawing at a new size (or for at most 300 ms), its latest frame is stretched to the box. Any new size is its answer, as niri takes the commit that acks a configure: a terminal snaps to whole cells, so it rarely draws the exact size. A page that snaps its layout (T3 Code's panel), or a drag, never shows a gap or a window lagging behind the page.
- **When the app answers with another size** (it won't take that size, or snaps to whole cells): `object-fit` and `object-position` place its frame, as for `<video>` (0018).
  - **Default:** `object-fit: none` at `0 0`, the frame as the app drew it, at the top left. Stretching a terminal a few pixels short of the box would blur its text.
  - **Fullscreen:** `none`, centered.
  - **`contain` / `scale-down`:** for a fixed-size app the page wants scaled into its box.

**Whole device pixels** (0055): the element snaps the window's rect in its own transform space, and the compositor moves its surface layer by whatever fraction of a pixel the transforms above it add (when they are only 2D translations, e.g. a CSS `translate()` at scale 1.78). The window stays crisp, and viz can put it on a display plane, which takes whole-pixel rects. Verified on Xvfb: a niri tile at `translate(3.37px, 5.71px)` shows GTK Demo exactly as untransformed, shifted by (3, 6) px (screenshots, max difference 5 from the app redrawing). A transform that animates on the compositor isn't snapped while it runs.

Before this, a resize showed the old frame unstretched until the app redrew, leaving a gap during a drag. The first attempt at niri's animation had the element animate its own size, which lagged behind a page that snapped its layout.

## Cross-fade: niri's resize animation

`crossfade="MS"` (0018; `crossfade-easing` and the rules below, 0020) adds niri's cross-fade. On a resize the page makes, the frame from before it, stretched to the box, stays on top until the app has answered (or 300 ms passed). Then it fades out over MS milliseconds, eased by `crossfade-easing` (a CSS easing function; by default `cubic-bezier(.25, 1, .5, 1)`, close to niri's default spring). The old frame is the window's surface at the old size, kept alive in viz by its exact id.

What doesn't fade:
- **Small resizes:** 10 pixels or less either way, which niri doesn't animate.
- **Continuous resizes:** less than 100 ms apart (a drag). The app's frame is stretched live, as Hyprland and niri show an interactive resize.
- **A first size:** an element only fades a box it has already shown the window in. Attaching a window (or switching the element to another one), and showing an element that was hidden (`display: none`, `visibility: hidden`) or off screen, don't fade.

The page owns the geometry, so animating the size is up to it. niri's animation is three things started together once the app has drawn at the new size: the size easing from old to new, the old and new frames stretched to it, and their mix. A page gets it like this:
1. Set the element to its final size at once (the app is asked to resize once), and hold a `transform: scale()` back to the old size (`transform-origin: 0 0`). The stretched old frame then shows exactly as before.
2. Wait for a `windowchange` where `windowWidth`/`windowHeight` differ from what they were when the size was set, or are the new size (or 300 ms), as niri's transactions wait.
3. Animate that transform to `none` (FLIP), and its own frame (border, shadow), with the cross-fade's duration and easing. The element starts the cross-fade at the same moment.

The niri shell does this for every layout change (`placeTile()`): all windows are asked for their sizes, nothing moves until they have drawn, and then the tiles' transitions, the FLIPs and the cross-fades start together. A page that snaps its layout (T3 Code) gets the window filling the new box at once and fading into the app's new frame.

Hyprland doesn't cross-fade a resize. It stretches the app's latest frame to the animated size, which is what the element does while the app catches up.

## Requests: `windowrequest`

The element fires a `windowrequest` event (`NativeWindowRequestEvent`), which doesn't bubble (0019):
- **`request`:** `"maximize"`, `"unmaximize"`, `"minimize"`, `"move"` or `"resize"`.
- **`edge`:** for a resize, the edge or corner to resize from (`"top"`, `"bottom-right"`, …).

The page decides what each request means. The niri shell maps maximize/unmaximize to maximize column. T3 Code maps them to the panel's maximize. Fullscreen requests work as before (`CONTROLS.md`).

**Move and resize** come from a press the app is handling (its title bar, its edges). The browser then gives the page the rest of that drag: the input router stops sending it to the window (`HandForeignDragToPage()`), the app gets a pointer leave, and the page gets the moves and the release as ordinary pointer events (with `buttons` set; there was no `pointerdown` in the page). niri turns them into its interactive move (the column follows the pointer and drops where it's released, as Super+drag) or its column width resize (from the left or right edge; floating windows resize both ways). The plain shell, with one window per stage, ignores both.

The page also has the mouse captured for the rest of the drag (the router's capture target is its root view), so the moves and the release reach it wherever the pointer goes, over a tab or over the window itself. The drag is the page's from the request on, whichever way the press was routed (directly, or through the renderer for regions where page content may overlap the window). GTK asks after its drag threshold, so the first few pixels of the drag still go to the app.

GTK 4's resize edges are in its shadow, outside the window geometry, where the element clips the surface: a press there reaches the page, not the app, so an edge resize never starts in a shell (niri's Super+right-drag resizes a column instead). An app that asks for a resize from inside its window gets niri's column resize.

## Several elements on one window

One element drives the window: its size is the window's, and it gets the requests. It is chosen in this order:
1. The fullscreen one.
2. The one the user last pressed in.
3. One on screen (intersecting the viewport).
4. The last attached.

Only the visible shell's elements count. When the driver changes, the window takes the new driver's size. Each element reports its on-screen rect, so the browser can tell which element a press on the window landed in.

## Popups

An app's menus, context menus and tooltips (`xdg_popup`s, and X11 override-redirect menus, which xwayland-satellite turns into `xdg_popup`s) are Ash windows of their own, drawn above the page: the page only draws the window itself. So they show only where a page shows the window (patch 0045):
- **Shown:** an element in the visible shell is on screen with the window (the driver, else any such element). The parked window is kept where that element's content box is, so popups open next to the element. Its popups move with it, and are scaled about the window's origin when CSS transforms scale the element (T3 Code's panel shows a held window scaled).
- **Shown nowhere** (another thread, the panel closed, another shell, the element off screen): its popups stay open but are invisible, take no input from the user and hold no pointer grab. They never cover the shell or another thread. Agents' keys still reach them through the window, as before. Showing the window again shows them again, at the element.

Each element reports its content box and its transform's scale (`SetRectInWidget`); the browser tells Exo where the window is shown (`EmbeddedWindows::SetShown()`).

Checked on Xvfb (slot 9, plain shell, zenity's entry context menu opened by `press_window` shift+F10, 2026-10-24):
- Opened while the window's thread is shown: under the entry, as usual.
- Opened while another thread is shown: nothing on screen. The user's clicks where the menu is go to the page. Switching back shows it under the entry.
- Switching threads with it open: it goes with the thread and comes back with it.
- The element under `transform: translate(300px, 100px) scale(0.6)`: the menu moves and shrinks with the window.
- A user's right-click menu: a click outside the element dismisses it. A click inside the element counts as a click on the app's window, since the window fills the element.
- Unit test `ShellSurfaceTest.EmbedParkedPopupsHiddenUnlessShown` (`exo_unittests`, which doesn't build on this setup: `wayland/clients/client_base.cc` against the GBM headers).

Before this, a parked window's popups were drawn wherever the window was last parked, over the shell, even when no page showed the window: a GTK context menu over another thread, and LibreOffice Calc's Insert menu and a tooltip over T3 Code while the panel didn't show Calc (`agent-tests/runs/20261024-142622-calc-normal-cdf.md`, problem 2).

## Verified

| | Result |
|---|---|
| App maximize/unmaximize/minimize (GTK 4, `gtk_window_maximize()` etc.) in the plain shell | configure answers at the element's size (1380×875), never maximized; three `windowrequest` events with the right `request` |
| Same, the prebuilt image without 0017 | configure 1600×1000 maximized; window 1600×1000 in a 1380×875 element |
| Element 600×400 → 1000×700 at once, `crossfade=1500` | window fills the new box from the first frame (old frame stretched), then fades into the app's new frame |
| Element widened 15 px every 16 ms (a drag) | window fills the box in every frame; no gap, no fade |
| niri: maximize column, at 2 s linear | tile border and window grow together; old frame stretched and new one squeezed, mixed by the same progress |
| Element switched from one window to another | the new window at once, no fade |
| niri: foot (snaps to cells, answers 1560×947 for 1560×960) maximized | tiles move 6 ms after the request, when foot answers; before, the shell waited the full 300 ms for an exact size with foot's frame stretched |
| GTK Demo in a 300×300 element (it won't go below 379 px) | `none`: clipped at the top left; `contain`: scaled to fit |
| Second element on the same window | newest on-screen element drives (400×300); off screen → the first drives (1380×875); back → 400×300; removed → 1380×875 |
| niri: the app's maximize | column maximized (768 → 1560 px), app configured once; FLIP plus cross-fade, captured with animations at 1/10 speed |
| niri, X11 with two host displays (2×1280×800): GTK Demo's header bar dragged left over the tab column | `drag … handed to the page` in Ash's log; the page gets every move with `buttons` 1 and the release; the columns swap (GTK Demo 648 → 16). Before the capture fix, moves over the tab or the window and the release went to them, and the drag never ended |
| Same, dragged onto the second display | stays on its display and drops back, as niri's Super+drag (moving to another display is HTML drag and drop, `MULTI_MONITOR.md`); the second display's page unaffected |

Not verified: pointer input on a scaled (`contain`) window, and the "last pressed" rule. On Xvfb, neither DevTools nor xdotool input reaches embedded apps. A press-driven driver change needs a session with real input (DRM, `tools/uinput.py`).
