# Fullscreen, keys and the app launcher

Better control of the windows and tabs a shell shows (and pointer capture for apps, below), tested on DRM (tty2, T3 Code as the shell) on 2026-10-17. `chromium/patches/0011-*.patch`.

## Fullscreen (native, any frontend)

Fullscreen belongs to the browser, not the frontend. The element that shows an app (`<native-window>`) or a browser tab (`<embed>`) becomes the shell document's fullscreen element, through Blink's own Fullscreen API. It then covers the screen, and its size goes to the app or page: a terminal gets more rows and columns, and a page gets a bigger viewport. Nothing is scaled. The frontend needs no code for it. It sees the usual `fullscreenchange` events and can style `:fullscreen` if it wants.

How an element gets there:

| Trigger | What happens |
|---|---|
| **Super+F** | Toggles fullscreen for the element showing the focused app or tab. If neither has the keyboard, it only leaves fullscreen. |
| The app asks (`xdg_toplevel.set_fullscreen`, e.g. a game) | Its element goes fullscreen. If no element shows it yet, that happens as soon as one does. `unset_fullscreen` leaves. |
| A tab's page asks (`requestFullscreen()`, e.g. a video) | The tab's `<embed>` goes fullscreen, then the page's element fills it. Esc in the page leaves both, as in a browser window. |
| The page's own script | `element.requestFullscreen()` on a `<native-window>` or `<embed>` works with a user gesture, as for any element. |

While its element is fullscreen, the app is told it is fullscreen: the `xdg_toplevel` configure carries the fullscreen state. Taking the element out of the page ends fullscreen. A window that wanted fullscreen gets real fullscreen when it is popped out to the desktop.

Esc is not a way out: it belongs to the app (games use it). So the "Press Esc to exit full screen" bubble is not shown for the shell's elements.

Measured on the panel (2560×1600 at scale 16/9, so 1440×900 DIP):

| | In the panel | Fullscreen |
|---|---|---|
| foot (window size, DIP) | 536×812 | 1440×900 |
| example.com in a tab (`innerWidth`×`innerHeight`) | 539×808 | 1440×900 |
| weston-simple-egl `-f` (asks at startup) | – | fullscreen as soon as shown |

### Chromium pieces

- Blink: a `ScopedAllowFullscreen::kBrowserRequest` reason lets a browser-requested element fullscreen through the renderer's activation check. `NativeWindowClient.SetFullscreen` asks a `<native-window>`; `SurfaceEmbed.SetFullscreen` asks a tab's `<embed>`. Both report changes back (`NativeWindowHost.OnFullscreenChanged`, `SurfaceEmbedHost.OnEmbedElementFullscreenChanged`).
- Content: `ContentBrowserClient::IsFullscreenAllowedWithoutUserActivation()`. Chrome allows the shell document only, and still requires activation for its page script, which Blink checks.
- Exo: a parked window's fullscreen is its element's. `set_fullscreen` while parked asks the element (`EmbeddedWindows::Observer::OnEmbeddedWindowFullscreenRequested`) instead of changing the Ash window. The configure reports fullscreen while the element is.
- `chrome/browser/plutonium_keys.cc`: the Super+F handler, a pre-target handler on Ash's shell, so it sees keys before apps and pages do.

Fixed along the way:
- `<native-window>` sized the window to its object-fit rect, and the fullscreen UA style asks for `contain`. The window kept its aspect ratio (594×900 instead of 1440×900). It now uses the content box.
- Parked windows kept their server-side frame. The 40 DIP caption came out of the element's height once the window was as tall as the display. Parked windows now have no frame (the client's choice comes back on pop-out), and their bounds are set directly, not fitted to the work area.

## Pointer capture (lock and confine)

Embedded apps can capture the pointer through `zwp_pointer_constraints_v1` and `zwp_relative_pointer_v1`, as on any Wayland desktop. Games use a lock for mouse-look, and some use confinement to keep the pointer inside the window. Tested on DRM on 2026-10-17 with `weston-constraints` (each click cycles unconstrained, confined, locked).

| | What the app gets |
|---|---|
| **Lock** | The pointer stays put and is hidden (the client sets a null cursor; the cursor plane goes off). Motion arrives only as relative motion: a 3000-unit move came as 375 `relative_motion` events adding up to exactly 3000, with no absolute motion. The page sees no mouse events. |
| **Confine** | The pointer moves normally but can't leave the window's input region. At the edge it is warped back a few pixels inside. |

Ending a capture:
- **Super+Escape** releases any capture. The app can't capture again until the user clicks on it. This is Exo's existing "broken by user action" rule.
- **Keyboard focus leaving the app** ends it: another panel tab, Ctrl+T, a click in the page. A persistent constraint comes back when the app has the keyboard again.
- **The app** ends it itself, as usual.

Shortcuts keep working during a capture (Super+F, Alt+1…9, the launcher), because only mouse events are taken.

What changed in Chromium (`chromium/patches/0012-*.patch`):
- **Permission.** Chrome's security delegate allowed pointer locks for ARC windows only. In the Plutonium shell (`--plutonium-hide-windows`), any app may lock.
- **Activation.** A capture used to need the window to be active, which a parked window never is. It now accepts a parked window that has embedded keyboard focus.
- **Focus.** Pointer observes the seat for embedded keyboard focus. Aura focus doesn't move when a page gives an embedded window the keyboard. It updates in a posted task, because the seat is notifying its observers at that moment.
- **Confinement** was a stub that never confirmed. It now confines to the surface's input region, from the root window's pre-target handler, before the page sees the event.
- **Fixed along the way:**
  - A confinement left behind when the app swapped it for a lock kept warping a locked pointer back.
  - A warp target on the element's fractional edge loops forever, because the page rounds that pixel to itself. Warps now land 4 DIP inside the window and are never repeated for synthesized moves.

Not done:
- Confinement regions (`set_region`) are ignored: the whole surface's input region is used.
- The lock's cursor position hint is ignored.
- Not tested in X11-hosted sessions (warping the pointer under Xwayland).
- Not tested with a real game yet.

## Modal dialogs and pointer leave

**Modal dialogs** (`chromium/patches/0030-*.patch`, EXO-MODAL). While a GTK modal dialog was open, the app sent its keys to the dialog, but the parent's element still reported `windowFocused`. Exo now implements `xdg_wm_dialog_v1`, which GTK 4 and Qt 6 use to say a window is modal to its parent. While a page shows the dialog:
- focusing the parent (`focusWindow()`, a click) focuses the dialog instead;
- a dialog that opens, becomes modal, or is first shown over the focused window takes its focus;
- when the focused dialog closes or its element goes away, focus goes back to the parent.

The elements' `windowfocus` and `windowblur` events follow, so a shell can move its own focus with them (Styx does). If no element shows the dialog, focus stays on the parent. GTK then drops the keys, because its parent is blocked. A shell should show the app's new windows.

Verified on the slot's Xvfb session with a small GTK 4 app (a window and a `modal=True` transient window), its dialog shown in a second element. The dialog took focus when shown, kept it when the parent was clicked, got the keys, and gave focus back to the parent when it closed or its element was removed.

Not covered: **GTK 3** says a dialog is modal only through GNOME's `gtk_shell1`, which Exo doesn't implement. Qt 5 says nothing.

**Pointer leave after a drag** (`0029`). A press in an embedded window keeps the pointer there until the release (an implicit grab). When the release happened over something else, the app got `wl_pointer.leave` only at the next move. It now gets the leave with the release, as on other compositors. Verified with `wev` and xdotool on Xvfb. The other ways out (onto the page, an overlay covering the window, the element hidden) already sent a leave, as does leaving the browser window, by the code (Xvfb can't test that).

## Shell shortcuts

A frontend's own shortcuts used to stop working once an app or a tab had the keyboard. `navigator.windowBroker.setShellShortcuts(["Alt+Digit1", "Ctrl+KeyT", …])` (and `shell.setShellShortcuts()` in the shell library) lists the combinations the shell handles itself. The format is modifiers `Ctrl`, `Alt`, `Shift`, `Super`, then a `KeyboardEvent.code`. While an embedded window or a tab has keyboard focus, a matching press goes to the shell page as an ordinary key event, and the app or page never sees it.
- For windows, the key handler marks the event (`exo::kShellKeyEventKey`). Exo's keyboard then leaves it to the page's view.
- For tabs, the tab's `WebContentsDelegate::PreHandleKeyboardEvent` forwards it to the shell page.

Super+F comes first and can't be taken.

## T3 Code

New keybinding commands. They are configurable like any other, and their defaults are backfilled into existing configs when the server starts:

| Default | Command | What |
|---|---|---|
| Alt+1…9 | `rightPanel.tab.1`…`9` | Focus the right panel's tab at that position |
| Ctrl+Tab / Ctrl+Shift+Tab | `rightPanel.nextTab` / `previousTab` | Cycle the panel's tabs |
| Ctrl+T | `preview.newTab` | New browser tab, address bar focused |
| Super+Space | `appLauncher.toggle` | The app launcher |

"Focus" means keyboard focus moves into the tab: an app's window, a browser tab's page, or a blank tab's address bar. T3 registers these bindings as shell shortcuts, so they work from inside an app or a page. Verified on DRM with a uinput keyboard: Alt+1, Ctrl+Tab, Ctrl+Shift+Tab and Ctrl+T pressed inside foot switched tabs or opened a browser tab.

**App launcher.** A command palette mode, like the project and new-thread pickers. It lists the desktop apps the helper finds (84 on this machine), with icons. It shows recently launched apps first and filters as you type (name, then generic name, keywords and comment). Enter launches the app into the current thread. Its first window opens as a panel tab, the panel opens if it was closed, and the window gets the keyboard.

## Helper

- `GET /v1/apps`: the launchable desktop entries, from `$XDG_DATA_HOME` and `$XDG_DATA_DIRS` (NixOS fallbacks if unset). Hidden, NoDisplay, OnlyShowIn, and missing TryExec entries are skipped.
- `GET /v1/apps/<id>/icon`: the icon, SVG or PNG. Looked up in `PLUTONIUM_ICON_THEME`, breeze, hicolor and Adwaita, then pixmaps.
- `POST /v1/apps/launch {thread, id, waitMs?}`: runs the entry's Exec, with field codes dropped and Flatpak's empty `@@` markers removed. `Terminal=true` apps run in `$TERMINAL`, else foot, kitty, alacritty and so on.
- Shell library: `apps()`, `appIcon(id)` (an object URL, fetched so only the shell can read it), `launchApp(threadId, id)`, `setShellShortcuts(list)`.

## Not done / caveats

- **Super+F on Plasma (`:0`) wasn't pressed for real.** Ash on X11 gets Super combinations unless KWin grabs them. Everything above was tested on DRM.
- **Switching panel tabs while fullscreen ends fullscreen**, because the element leaves the page. The app is told so.
- **One element per window decides.** If two elements show the same window, the fullscreen one (else the newest) answers the app's requests.
- **A popped-out foot looked more translucent than its `alpha=0.92`** (seen once, on DRM). Not investigated, and not checked against a build from before this change.
- **Launching needs a thread.** Without one, the launcher says so. A single-instance app that is already running (a second Firefox) will probably open its window in the running process's thread (untested). The launcher stops waiting for a window after 60 s.
