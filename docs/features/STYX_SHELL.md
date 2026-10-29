# Styx

Styx is a Plutonium shell page (`shells/niri/index.html`, installed as `niri`) whose design follows the [niri](https://github.com/YaLTeR/niri) scrollable-tiling Wayland compositor nearly 1:1: its layout, look, animations and default binds are niri's, credited to niri's authors. The code is Plutonium's. Like the plain shell, it is built only on the substrate: `navigator.windowBroker`, `<native-window>`, browser tabs and the helper's shell library. Tested on DRM (tty2) on 2026-10-17, Chromium patch `chromium/patches/0016-*.patch`.

```
plutonium run niri plain          # DRM, Styx at startup, the plain shell second (Super+Tab)
plutonium run --x11 niri          # a private Xvfb (:99)
```

It's an installed shell (`~/.pluto/shells/niri`, [SHELL_PACKAGES.md](SHELL_PACKAGES.md)), served at `http://niri.localhost:8770/`.

## What it does

- **Scrollable tiling.** Each workspace is an endless horizontal strip of columns. A column holds one or more windows stacked vertically, or tabbed (Super+W, with niri's tab indicator in the gap). New windows open as a column right of the focused one, at half the screen width. The view scrolls just enough to keep the focused column on screen (`center-focused-column "never"`).
- **Workspaces.** These are dynamic and stacked vertically. There is always one empty workspace at the bottom, and an empty workspace goes away once you leave it. Switching slides vertically.
- **Overview** ([screenshot](../images/niri-overview.png); Super+O, or a hot corner). It zooms out to 0.5 and shows every workspace as a card with the wallpaper, rounded corners and a shadow, on niri's `#262626` backdrop.
  - Click a window to go to it, or click a workspace to switch.
  - Drag a window anywhere a Super+drag can put it (below), on any workspace, or into the gap between two workspaces for a new one there.
  - Drag a workspace to drag the view (sideways: columns; up and down: workspaces).
  - The wheel switches workspaces (Shift or sideways: columns), a two-finger scroll swipes, and Escape or Enter closes the overview. Every bind keeps working in it.
  - Holding a drag and drop (a window from another shell, a file) over a workspace for half a second goes to it; near the top or bottom edge the workspaces switch.
- **Moving windows** (Super+drag, or the app's own title bar), as niri's interactive move: the window leaves the layout, the others close up, and niri's insert hint shows where it goes:
  - the sides of a column, or the gap between two: a new column there;
  - the top or bottom of a window: into that column, above or below it;
  - the middle of a window, or anywhere on a tabbed column: a **tab** of that column (it becomes tabbed);
  - a workspace dot in the bar's minimap: the last column of that workspace.
  Near the left or right edge the view scrolls along (niri's `dnd-edge-view-scroll`), and the hot corners work mid-drag. Dropped nowhere (on the bar), it goes back. A window or tab dropped here from another shell or display lands the same way.
- **Resizing** (Super+right-drag) from the edge or corner nearest the pointer, as niri: sideways the column's width, up and down the window's height in its column. A double click there toggles the full width, or resets the height.
- **Swipes and the view drag.** niri's three-finger swipes (sideways: the view; up and down: workspaces) follow the fingers and snap to a column or workspace at the end, carried on by the swipe's speed. With Chromium patch 0074 the shell library passes three- and four-finger swipes to the shell page (`touchpadswipe`, DRM only): three fingers swipe as niri's (the content follows the fingers), four fingers up open the overview and down close it. Without it the event never comes, and a two-finger scroll with Super held (or any in the overview) is the swipe instead. Super+middle-drag drags the view the same way.
- **Hot corners** (`CONFIG.hotCorners`, niri's `gestures { hot-corners }`): top left by default; any corner can be turned on. With several displays only a corner of the whole desktop is hot.
- **The bar's minimap** (`minimap.js`, on the left): a numbered dot per workspace, then the focused workspace's columns at the screen's proportions, each window as its app's icon (a tab as its site's favicon; a letter if there's none), a tabbed column as its active tab with a count, floating windows after it, and the part on screen outlined. Click a window to go to it, a dot for its workspace; the wheel over the strip moves between columns. It moves with the layout, 1:1: the current workspace's pill slides along the dots, and a strip per workspace slides up and down as a vertical swipe goes; the outline scrolls with a sideways one. Between swipes the same moves run as CSS transitions with the layout's `--anim`. The DOM is rebuilt only when the layout's structure changes. A swipe's frame sets only transforms (and a width when it changes), and the layout is saved once the swipe settles, not every frame.
- **Floating windows** (Super+V, Super+Shift+V): above the tiles, centred at their tiled size. Super+drag moves them, and Super+right-drag resizes them.
- **The look.** niri's knobs are at the top of the script (`CONFIG`):
  - gaps 16;
  - a 4 px border, `#7fc8ff` on the active window and `#505050` on the others;
  - 12 px corner radius, with the window clipped to it;
  - niri's shadow (softness 30, spread 5, offset 0 5, `#0007`).
  The focus ring, presets and centring mode can be switched there too.
- **Animations.** Column, view and workspace movement use a spring-like ease of about 280 ms. Opening a window scales its tile (border and window together) in from 0.5, from its center, and fades it in. Resizes animate as in niri. A layout change asks the windows for their new sizes and waits until they have drawn at new sizes (at most 300 ms, a niri transaction), holding each window scaled back to its old size. Then the tiles ease to their new sizes, each window is scaled along (FLIP), and its old frame cross-fades into its new one, all with the same duration and easing (`WINDOW_SIZING.md`). An interactive resize (Super+right drag) is live, without animations.
- **The app's own maximize button** maximizes its column (Super+M), and unmaximize restores it.
- **Launcher** (Super+D), in place of fuzzel. It searches the helper's desktop apps, with icons and recently used ones first. It can also run a command line, open a web address as a browser tab, or start Claude Code with Plutonium's MCP tools.
- **The hotkey overlay** (Super+Shift+/) is shown at startup, as in niri.
- **Browser tabs are tiles too.** Their page dialogs are drawn over the tile.
- **Which windows it shows:**
  - everything tagged `niri:desktop`. That's the thread it launches apps in, so it also covers apps started from its terminals;
  - windows nobody claims (no tag), which it tags.
  Another shell's windows come in through the Super+Tab overlay ("show in its shell"). The layout is kept in the page's storage and survives a reload of the page (not an Ash restart: window ids restart).

## Binds

These are niri's default `config.kdl` binds, with Mod = Super:

| Keys | Action |
|---|---|
| Super+T / Super+D / Super+Q | terminal (foot) / launcher / close window |
| Super+←→↑↓, Super+H J K L | focus column left/right, window down/up |
| Super+Ctrl+the same | move column left/right, window down/up |
| Super+Home/End, +Ctrl | focus / move to the first or last column |
| Super+PageDown/PageUp, Super+U/I | workspace down/up; +Ctrl moves the column, +Shift moves the workspace |
| Super+1…9, Super+Ctrl+1…9 | focus workspace N, move the column there |
| Super+[ / ] | consume or expel window left/right |
| Super+, / . | consume window into column / expel it |
| Super+R, Super+Shift+R, Super+Ctrl+R | preset column widths (1/3, 1/2, 2/3), preset window heights, reset heights |
| Super+- / =, +Shift | column width ∓10%, window height ∓10% |
| Super+M | maximize column (niri's Super+F, which the browser keeps for fullscreen) |
| Super+Shift+F | fullscreen window |
| Super+Ctrl+F | expand column to the available width |
| Super+C, Super+Ctrl+C | center column, center the visible columns |
| Super+V, Super+Shift+V | floating, switch focus between floating and tiling |
| Super+W | tabbed column (a click on the tab indicator goes to that tab) |
| Super+O | overview |
| Super+Shift+←→↑↓ / H J K L | focus the display that way |
| Super+Ctrl+Shift+the same | move the column to the display that way (each window a column there) |
| Super+Shift+E, Ctrl+Alt+Delete | exit Styx (ends the session), after a confirm |
| Super+Alt+L | lock the screen (the session service; until the shell has it, a notice) |
| Super+wheel | workspace; +Ctrl moves the column there; +Shift, or sideways: column; +Ctrl+Shift, or Ctrl sideways: move the column |
| Super+two-finger scroll | swipe: the view, workspaces |
| Super+drag, Super+right-drag, Super+middle-drag | move window (a column, into one, a tab), resize from the nearest edge, drag the view |

All of them are registered as shell shortcuts, so they work while an app or tab has the keyboard. Super itself is registered too. While it's held, a layer over the windows takes the pointer, so Super+drag and Super+wheel reach the page.

**Left out:** Super+Tab (the browser's shells overlay; niri uses it for the previous workspace), Super+Escape (the browser's pointer release), and power off monitors (Super+Shift+P: nothing to turn the display off with yet). Three- and four-finger swipes need patch 0074 (see Swipes).

## Chromium changes (`chromium/patches/0016-*.patch`)

- **Shell shortcuts beat Ash's accelerators.** Super+D opened ChromeOS's "Turn on Dictation?" dialog instead of the launcher, and Search+V would open clipboard history. `plutonium_keys.cc` now marks any press that is one of the visible shell's shortcuts, and its release, with `wm::kShellShortcutEventKey`. `wm::AcceleratorFilter` leaves marked events alone, so they reach the page as ordinary keys. This applies to every frontend.
- **No Search+arrow rewriting in shell mode.** ChromeOS's event rewriter turns Search+←→↑↓ into Home/End/PageUp/PageDown ("six-pack" keys), and Alt+↑↓ into PageUp/Down. Super+Left never reached the page. Desktop keyboards have real Home/End/Page keys, so `EventRewriterAsh` skips that remapping when `--plutonium-shell-url` is set.
- **No white strip under windows.** When an element is bigger than its window's surface, viz fills the gap (the gutter) with the client frame's `root_background_color`. Exo never set it, so the default, white, was used: a white strip under foot, which snaps to whole cells. It was in the plain shell too (`shots/phase4-drm-foot.png`). Exo now sends transparent, so what's behind the window shows.

- **Touchpads work.** This is a Linux-built ChromeOS (`is_chromeos_device` is false), so it has no ChromeOS gestures library. Touchpads fell through to the plain evdev converter, which ignores multitouch: the touchpad did nothing. `out/Cros/args.gn` now sets `use_libinput = true`, and `launch-drm-shell.sh` passes `--enable-features=LibinputHandleTouchpad`, so every touchpad goes through Chromium's libinput converter (pointer, buttons, two-finger scroll, tap-to-click). The converter had bit-rotted (raw pointers, `StringPrintV`), and its `USE_LIBINPUT` define is now private to `//ui/events/ozone/evdev`, so turning it on doesn't rebuild half of Chrome.
- **Three- and four-finger swipes** (2026-10-27, Chromium patch `0074`). The libinput converter read only pointer events, so swipes with three fingers or more never left it. It now sends them as ChromeOS's gesture library does (scroll events with a finger count; a fling cancel begins one, a fling start ends it). In shell mode, Ash's system gesture filter hands those to the focused display's visible shell page instead of Ash's overview and desks: `navigator.windowBroker`'s `touchpadswipe` event, which the shell library re-sends as the shell's `touchpadswipe` (`{ phase, fingers, dx, dy, x, y }`). Nothing else gets them, so a swipe never scrolls the page or the window under it.

- **Scrolling in apps.** Wheel and touchpad scrolling reach an embedded window from the browser, as Blink wheel events (`chrome/browser/exo_embedder.cc`). These were turned back into aura `MouseWheelEvent`s built from the pixel delta, which went wrong in three ways. Each fix is now in place:
  - **Wheel speed.** A notch is 120 there, but `MouseWheelEvent::kWheelDelta` is 53 on ChromeOS, so each notch became 120/53 ≈ 2.26 ticks. GTK3 clients such as Firefox collapse discrete counts, so the result was wrong speeds. The embedder now passes the notches as `tick_120ths` and the offset in `kWheelDelta` units.
  - **Wheel units.** Exo sent 10 axis units per notch (Weston's convention). It now sends 15, as libinput, KWin and niri do. High-resolution wheels count whole notches across events for `axis_discrete`.
  - **Touchpad.** Each scroll step was truncated to a whole pixel twice: in the libinput converter, and when turned into wheel ticks. It was then divided by 12 as if it were a wheel. Precise-pixel scrolling is now a `ui::ScrollEvent`, and Exo sends it as finger axis events in pixels. The end of the gesture (libinput's zero axis, or the wheel's ended phase) becomes `axis_stop`, so clients can do kinetic scrolling.
  - **Only the first event of a scroll reached the app.** This was the main bug. Over niri's tiles (rounded and clipped), viz's hit test says "ask", so a wheel sequence's first event goes through the async targeter, which then routes it to the native window. The targeter sends the rest of a sequence (changed/ended phases) to `wheel_target_`, a view, and a native window has none, so they were dropped. Fast scrolling or a touchpad gesture is one sequence, so almost nothing arrived. `RenderWidgetHostInputEventRouter` now latches a sequence that starts on a native window (`foreign_wheel_sink_`) and routes the rest of it there.
  Measured with `WAYLAND_DEBUG` on foot and the uinput mouse: one notch is `axis_discrete 1`, `axis 15`. Before, it was `axis_discrete 2`, `axis 33.96`.

## Verified on DRM (tty2, uinput keyboard and mouse)

| | |
|---|---|
| Startup hotkey overlay; Escape closes it (`shots/niri-drm-hotkeys.png`) | ✓ |
| Super+T ×3: three half-width columns, the view scrolled to the newest, rounded corners, border on the focused one | ✓ |
| Super+Left ×2 moves focus (after the rewriter change), and typing reaches the focused foot (`echo niri $((6*7))` → `niri 42`) | ✓ |
| Super+H, Super+PageDown | ✓ |
| Super+, consumes the next column; Super+R goes to 2/3; Super+W tabbed, with the indicator | ✓ |
| Super+O overview; Super+Ctrl+U in the overview moves the column up a workspace, and a new empty one stays at the bottom; Escape closes it | ✓ |
| Super+D (after the accelerator change): the launcher with icons, "foot" + Enter opens a new column next to the focused one | ✓ |
| Hot corner opens the overview; a click on a window closes it and focuses that window | ✓ |
| No white gutter under foot | ✓ |

These were tested on Xvfb only: consume-or-expel, floating (Super+V), overview click across workspaces, the page reload restoring the layout.

## Not done

- **Not tried yet:** Super+drag and Super+right-drag (uinput can't hold Super during a mouse drag), dragging in the overview, browser tabs as tiles, the Claude Code launcher entry.
- **Resizes aren't animated.** Sizes change at once, and only positions animate. Animating the element's size would reconfigure the app every frame.
- **No close animation.** The element disappears with its window.
- **Swipes and drop zones are checked against a mock broker only** (`preview` tab, 2026-10-27): the drop zones, insert hint, tab click, resize from an edge, swipe snapping and overview drops. Not yet on DRM with a real touchpad and mouse: whether Chromium's touchpad scroll deltas are told apart from wheel notches as expected (`isNotch()`), and Super+middle-drag.
- **Dialogs (transient windows) are tiled.** niri floats them, but the broker doesn't report a window's parent.
- **Shell-wide Super.** While Styx is visible, apps never see Super (it is a shell shortcut), so app shortcuts with Super don't work.
