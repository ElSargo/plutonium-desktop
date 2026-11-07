# Several shells in one session

Switch between shells (frontends such as Hydra and the plain shell) without losing apps or tabs. Every app window and browser tab can be shown by any shell.

Plan, agreed on 2026-10-17:

1. **Browser: several live shells** (done, below). Steps 2–4 are done too. Every enabled shell's page runs all the time, one is visible, and switching is instant.
2. **Tags and group labels.** Every window and tab gets a set of namespaced tags (`t3:thread/<id>`, `plain:thread/<id>`, `wm:workspace/2`, …), and a table of groups (tag → label, owning shell). Items with the same tag belong together, so a workspace window manager and a thread-based shell can understand each other's grouping. Importing an item into a thread adds the thread's tag. The thread an app was started in stays as a fixed tag. Only shells and the native UI may set tags, and a tag also gives that thread's agent access.
3. **Native overlay** (Ash, views): Super+Tab opens it, arrows move, Enter acts. It lists the shells: switch, add, edit, turn off. It also lists every window and tab grouped by label, with search, and actions: focus in its shell, pop out, add to thread, close.
4. **Frontends:** Hydra (`hydra`) and the plain shell register their threads, tag what they open, and get an "Elsewhere" area for importing items from other shells.

## Step 1: several live shells

Tested on 2026-10-17. On Xvfb (`:99`) the plain shell was the startup shell, with T3 second. On DRM (tty2) T3 was the startup shell, with the plain shell second.

### Using it

```
# DRM: T3 at startup, the plain shell second
plutonium run hydra plain

# Xvfb: the plain shell at startup, T3 second
plutonium run --x11 plain t3
```

**Super+Tab** shows the next shell and **Super+Shift+Tab** the previous one. These are stand-ins until the overlay (step 3) exists.

`SHELLS` is `<name>=<url>|<name>=<url>`. The launchers pass it to the browser as `--plutonium-shells`, now with `--plutonium-shells-exact`: the list is the whole list, `!` before shells that are off ([SHELL_PACKAGES.md](SHELL_PACKAGES.md)). They also add its origins to the helper's `--shell-origin`, which now takes a comma-separated list. Each URL names the session's helper: `?helper=` for the plain shell, `?plutoniumHelper=` for T3. A page can also ask the browser, `await navigator.windowBroker.getHelperUrl()` (the launcher's `--plutonium-helper-url`); the bundled shells take `?helper=`, then that, then port 3780.

### How it works

- **The list** lives in local state (`plutonium.shells`: id, name, URL, enabled). The startup shell (`--plutonium-shell-url`) and the `--plutonium-shells` entries are added to it when it doesn't have them yet. An entry it has is one with the same URL but for the fragment (where the launcher puts T3's one-time pairing token), or the same name on the same origin; it takes the new URL. The startup shell is always enabled.
- **Windows.** The startup browser (`--app`) becomes the startup shell's window. Once it exists, every other enabled shell gets its own fullscreen app window, opened hidden. Switching shows and activates the target window and hides the previous one. A hidden page reports `document.visibilityState === "hidden"` and is throttled like a background tab, but it keeps running: its WebSocket, its EventSource and its broker events all carry on.
- **Who is a shell.** A shell document has to be in its own shell's window and on that shell's origin. A shell's origin in another shell's window doesn't count. Outside shell mode nothing changed: there's one `--plutonium-shell-origin`, in any top-level page. Renderers get the list of origins (comma-separated `--plutonium-shell-origin`), so the SurfaceEmbed plugin loads in every shell.
- **Only the visible shell drives.** Every shell gets the full broker: windows, tabs, grants and events. Only the visible one decides how windows and tabs are shown (with several displays, one visible shell per display, and a window is in one page at a time: `MULTI_MONITOR.md`, "One window, one place"):
  - **Windows.** A hidden shell's `<native-window>` elements stay attached, but their size, focus and fullscreen requests are ignored. When the shell becomes visible again, its elements size their windows again. If several shells show the same window, its size follows the visible shell.
  - **Tabs.** A tab can be shown by one `<embed>` at a time. A hidden shell's `<embed>` doesn't attach. Every `<embed>` remembers its tab, and when its shell becomes visible it takes the tab back. Before this change, an `<embed>` whose tab another one took stayed empty.
  - **On a switch:** fullscreen elements leave fullscreen, embedded keyboard focus is cleared, and tabs that no `<embed>` shows move into the visible shell's window. That keeps them painting, so snapshots of them still work.
- **Keys.** Each shell page registers its own shortcuts (`setShellShortcuts`), and the visible shell's apply. Shortcuts pressed inside an app or tab go to the visible page.
- **Helper.** It now keeps one request stream per shell page. Each page connects with a random id and posts its visibility when it changes. Agent requests go to the visible shell, or else to the one visible most recently. `GET /v1/status` lists the connected shells.

### Verified

| | Xvfb | DRM |
|---|---|---|
| Both pages load. Each has `navigator.windowBroker`, and only the visible one reports `visibilityState` "visible" and has focus | ✓ | ✓ |
| Super+Tab switches both ways. The helper's view of which shell is visible follows | ✓ | ✓ |
| The same foot window shown in both shells is sized by the visible one (T3 box 496×284, plain stage 1376×862; on DRM 694×387 and 734×812), and a hidden shell attaching it doesn't resize it | ✓ | ✓ |
| The same example.com tab in both shells moves to the visible shell's `<embed>` on every switch, laid out at that size | ✓ | |
| Alt+1 with foot focused: goes to T3's page when T3 is visible (T3 registers it), and to foot when the plain shell is visible (it registers nothing) | ✓ | |
| Four switches with a shared window and tab: no crash, no DCHECK | ✓ | |

Fixed along the way:
- **Crash on switching back** (`FocusController` DCHECK). A tab attached to an `<embed>` reports its embedder's page view as its native view. Moving "parked tab views" into the new shell's window therefore moved the previous shell's whole page view. When that shell's window was activated later, it restored focus into a page that now sat in another window. Now only unattached tabs move, and the hand-over happens before the new window is activated.
- **GPU process DCHECK** (`SurfaceAllocationGroup`). Replaying an `<embed>`'s last visual properties on reattach reused an old LocalSurfaceId. The replay was removed: the plugin sends fresh properties after any attach.

## Step 2: tags and groups

### Tags

Every window and tab carries a list of tags (`tags` on `NativeWindowEntry` and `BrowserTabEntry`). Items with the same tag go together, whichever shell shows them. Tags are printable ASCII without spaces, at most 256 characters and 32 per item. By convention they're namespaced: `t3:thread/<id>`, `plain:thread/<id>`, `wm:workspace/2`.

- **The first tag is the origin, and never changes** (`tag`):
  - for a window, the `PLUTONIUM_THREAD_ID` of its client process, or of its nearest ancestor that has one; the browser reads it from `/proc` before it announces the window;
  - for a tab, the tag it was created with.
  A tab that a page opens starts with all of its opener's tags.
- **When the browser can't read the environment** (Ash in a container with its own user namespace, as in all our test setups), the window arrives with no tags. The helper names it as the window arrives: it finds the pid's thread and calls the DevTools command `Plutonium.setWindowOriginTag`, once for every shell. The shell library still asks the helper and names it with `setWindowOriginTag` for a window that is still untagged (a helper from before, or one that missed it). From then on it's fixed like any other origin. A browser on the host reads it itself.
- **Shells add and remove the others** with `updateWindowTags(id, add, remove)` and `updateTabTags(…)`. So does the browser's overlay. Removing the origin does nothing. The helper and agents can't change tags.
- **A thread's id is its tag.** The helper gives an agent every window and tab that carries its thread's tag: the ones its processes started, plus the ones a shell added to the thread.

### Groups

A group is a tag that a shell has described: `{tag, label, shellId}`.
- Each shell replaces its own groups with `setGroups([{tag, label}])`. A tag another shell already owns stays with that shell.
- `getGroups()` and the `groupschanged` event return every shell's groups.
- The table is kept in local state (`plutonium.groups`), so items keep their labels while their shell is off. Removing a shell drops its groups.

**Routing.** A page's request stream says which shell it is (`shell=<id>`, from `getShellId()`). The helper asks the browser for the groups (cached for 2 s) and sends a thread's requests to the shell that owns the thread's group. When that shell shows what an agent asked for, the library makes it visible (`showShell()`).

## Step 3: the overlay (the switcher)

**Super+Tab** opens the switcher over whatever is in front, with the next shell selected. On the left is a sidebar, split in two, each half scrolling on its own: the shells at the top, every window and tab below. On the right, the main area shows the selected item's page. The search box filters both halves. Windows and the launcher's apps show their app's icon (the helper's `/v1/apps/<id>/icon`, a window by its app id; PNG or SVG, decoded in a background `about:blank` WebContents as Chrome's Almanac icon loader does, since an SVG needs a renderer; `PlutoniumAppIcons`).

- **Left click** acts: a shell is shown; a window or tab is shown in its shell (the one its group belongs to, else the visible one), maximized the shell's way, as Super+F does ([CONTROLS.md](CONTROLS.md), "Maximize"). Real fullscreen is a button on its page.
- **Right click** only selects, so the item's page opens in the main area.
- **Keys:** ↑/↓ (or Super+Tab again) move the selection and show its page. Enter acts as a left click does. Tab moves into the page's buttons and fields, and Escape goes back to the list, or closes the switcher from there. Ctrl+O starts or stops a shell, Ctrl+R reloads it, Ctrl+N adds one, Ctrl+W closes a window or tab, and Ctrl+P pops a window out.

**A shell's page** shows its state (visible, running, loading, crashed, starting or off, polled every second), its address, the page it shows, its title, the origin with shell rights, the groups it described and how many windows it shows. From there you can:
- switch to it, or bring it to the front;
- start or stop it (the last running shell can't be stopped);
- reload it, or reload it from the network;
- open its DevTools, docked in its window;
- move it up or down (Super+Tab's order);
- change its name and address (a new address loads in place);
- remove it, once it's off, with a second click to confirm.

Starting a shell from here keeps the switcher open.

**Built in**, below the shells:
- **Add a shell…**: what a shell is and how shells work, what the address must say (`?helper=` or `?plutoniumHelper=`, with this session's helper URL), and a form.
- **Backup terminal**: the helper's terminal page (`/v1/terminal/`, see the helper README) in a maximized app window. Each tab is your `$SHELL` on this machine, in the thread `plutonium:terminal`, so the apps it starts show up as windows. Ctrl+Shift+T opens a tab, Ctrl+Shift+W closes one, Ctrl+PageUp/PageDown switch between them, and Ctrl+Shift+C/V copy and paste. Sessions survive a reload of the page, and the helper hangs up a session nobody has watched for 30 s.
- **Backup browser**: Chrome's own tabbed browser window (address bar, tab strip, Chrome's tabs, not the shells' tabs), maximized.
- **Launch an app…**: the helper's desktop apps (over its Unix socket, so no shell is involved), with a filter. The app starts in the thread `plutonium:switcher`. Its first window opens fullscreen, and the switcher names that window's origin tag if the browser couldn't.

Neither backup window is a shell. They sit above the shells until one is shown. Ash learns where the helper is from `--plutonium-helper-url` and `--plutonium-helper-socket`, which `lib/session.sh` passes.

**Settings**, below the built-ins: the desktop's settings, for any shell or none. Each row has a live summary ("HomeNet", "Volume 64%", "Battery 80%, charging", "2 displays · 1280×800"):
- **Quick settings**: Wi-Fi, Bluetooth and Do not disturb toggles, the volume and brightness sliders, mute, lock, suspend, restart, power off and log out, and buttons to the other pages.
- **Wi-Fi and network**: Wi-Fi on and off, the networks (a password field for a new one), connect, disconnect, forget; wired and VPN connections.
- **Bluetooth**: on and off, find devices, pair, connect, disconnect, forget.
- **Sound**: volume and mute, the outputs (pick the default), the microphone's level, what's playing.
- **Displays**: the display configuration tool (below).
- **Power**: the battery, brightness, the idle times (screen off, lock), and lock, suspend, restart, power off and log out. Restart, power off and log out take a second click.
- **Notifications**: do not disturb, and the notifications, to dismiss.

The pages drive the helper's desktop services ([DESKTOP_SERVICES.md](DESKTOP_SERVICES.md)) over its Unix socket (`GET /v1/system/services`, `POST /v1/system/services/<name>/<action>`), the same services the shells' bars use, polled every second while the switcher is open. A slider sends one request at a time (the latest value next) and isn't moved by the state while you hold it.

**Displays** draws the displays as they're arranged. Drag one into place (it goes against the nearest edge of one already placed, and an edge within 48 DIPs of lining up with another's lines up), or put it left of, right of, above or below the primary with a button. For the display chosen below the drawing: its resolution, refresh rate, size (Ash's zoom levels), rotation, primary, mirroring, and the built-in panel off while a monitor is on. A new mode, size, rotation, mirroring or the panel off goes back after 15 s unless you click Keep in the banner, since shell mode never shows Ash's own confirmation. It's Ash's `CrosDisplayConfig`, as ChromeOS's Settings uses (`PlutoniumDisplayConfig`, `plutonium_display_config.cc`), and the helper's `display` service reads and changes the same configuration. A shell opens any of these pages through that service (`open-settings {page}`), which is how the shells' bars reach Displays:
- **GNOME:** a display button in quick settings' top row, and a Displays page in its own Settings app (GNOME's arrangement, resolution, refresh rate, scale and orientation, primary, mirroring, with GNOME's "Keep Display Changes?" dialog).
- **niri** and **plain:** a display indicator in the bar or tray (`display.js`) showing how many displays there are. Its popover lists them, turns mirroring on and off, and has "Display settings…" and "All settings…".
- **Hydra:** Displays and All settings rows in the status cluster's quick settings (T3 patch 0049).

**A window's page:**
- Show maximized (what a left click does), Open fullscreen, or Leave fullscreen.
- Pop out to the desktop.
- Close.
- **In the shells:** each running shell, whether it shows the window (has a `<native-window>` attached to it), and "Focus it in <shell>". That shows the shell and sends it a `windowfocusrequest`; a shell that doesn't listen gets the window popped out instead.
- **Inspect:** a snapshot (taken even while the window is hidden; "New snapshot" takes another), the window and process ids, app id, size and scale, keyboard focus, where it was started, and its tags with their labels.
- **Groups:** a toggle per group (the origin group can't be left).

**A tab's page:** show it maximized (what a left click does), open it fullscreen (or leave fullscreen), show it in its shell, load its address in the backup browser, reload or close it, open its DevTools (a tab beside it), a snapshot, its details, and the same group toggles.

**Open fullscreen** (`exo::EmbeddedWindows::Present()`, EXO-PRESENT) puts the window on the desktop, fullscreen and active, even while shells' elements show it. Until it ends, those elements keep their attachments but don't park, size, focus or send input to the window. It ends:
- with **Super+F**, which returns to the visible shell;
- when a shell is shown (`PlutoniumShells::Show()`), or a backup window opens;
- with Leave fullscreen or Focus it in….

The window then goes back to its elements, at the size they last asked for. With `--plutonium-hide-windows` and no element, it leaves the desktop. One window is presented at a time.

While presented, the window has Ash's backdrop (`WindowBackdrop`, black, taking no activation). Fullscreen is the window's own size, which an app with a fixed size (a dialog) keeps at the top left. Before 2026-11-07 the visible shell's window showed around it, and a click there activated the shell's window, which then covered the presented one and got the click. Reproduced on Xvfb (zenity's entry dialog, 300×260, presented over plain): a click beside the dialog, and the dialog was gone.

**A tab, fullscreen** (`PlutoniumTabs::Present()`) is the tab's own page, with its state, not its address loaded again. Its `<embed>` lets go of it but keeps wanting it, and no `<embed>` can take it (a SurfaceEmbed child filter) until the presentation ends. Meanwhile Ash shows it in a fullscreen window of its own (`PlutoniumTabPresenter`, a `views::WebView`), with the keyboard. It ends the way a window's does, and then the visible shell's `<embed>` takes it back. One window or tab is presented at a time.

Shells that the overlay adds aren't on the helper's command line. Each shell page reports the browser's shell origins to the helper (`POST /v1/shell/origins`, after `shellschanged`), and the helper then accepts them too.

### Verified: the switcher (2026-10-19, Xvfb `:99`, niri at startup, plain second, dev build)

| Check | |
|---|---|
| Sidebar: shells and built-ins on top, windows and tabs grouped below; search filters both, "No shell matches" when none does | ✓ |
| Left click on a foot window that no shell showed: fullscreen, typing reaches it; Super+Tab opens the switcher over it | ✓ |
| Right click: the window's page with its snapshot, ids, size and tags; "Focus it in Plain" ends fullscreen and Plain shows it | ✓ |
| A window Plain embeds, opened fullscreen, then Super+F: back in Plain's element at Plain's size | ✓ |
| Shell page: stop (Ctrl+O), start again (Loading, then Running); the switcher stays open | ✓ |
| Add a shell from the form: it runs hidden; stop it, Remove asks for a second click, then it's gone | ✓ |
| Backup terminal: tabs of login shells in `plutonium:terminal` at the window's size; Ctrl+Shift+T opens one tab; after a reload both tabs come back with their scrollback | ✓ |
| Backup browser: Chrome's tabbed window with its new tab page | ✓ |
| Launch an app: the helper's apps, filtered; Foot starts in `plutonium:switcher` and opens fullscreen, listed under "Started from the switcher" | ✓ |
| App icons (2026-10-27, Xvfb): foot's SVG icon on its window's row; the launcher's apps with their PNG and SVG icons | ✓ |
| A tab's page: snapshot, details, group toggles | ✓ |
| No DCHECKs in Ash's log | ✓ |
| Left click on a tab: the page itself fullscreen; a click in it navigates it | ✓ |
| A tab Plain showed, opened fullscreen, then Super+F: back in Plain's `<embed>`, painting | ✓ |

Not tried: the tab page's DevTools and backup-browser buttons, and a shell's DevTools button.

**On DRM** (2026-10-26, tty5, niri and plain, two monitors, the user driving): Super+Tab, search, a window fullscreen and back with Super+F, the backup terminal and launching an app all work, with no DCHECKs. Three things fixed after it (patch "the switcher's text fields…"): the search field's text was dark on the dark panel (the overlay's widget now takes the dark theme's colors); a GTK Demo window showed above the backup terminal (the active backup window now goes above floating windows, such as a parked window's popups, and back once something else is active); and a row's hover went off over its labels and didn't come back on a rebuilt list (enter/exit on children, and a check when a row is laid out). Rechecked on DRM the same day (tty5, the user driving): the search text is light, hover is steady, nothing shows over the backup terminal, and no "unsupported command-line flag" infobar.

### Verified: settings and Displays (2026-11-01, X11 slot 37, Xvfb 2560×1000, two host displays 1280×800 with several modes each, dev build)

Display 1's modes were 1280×800 at 60 and 75 Hz, 1024×768 and 800×600, display 2's 1280×800, 1280×720 and 1024×768 (`BOUNDS=…#1280x800%60|…`, `--plutonium-test-displays`).
- Every settings page drew the real state: the laptop's Wi-Fi networks, Bluetooth, volume, brightness, battery and the displays. The volume slider set the real volume (put back after), and the page followed a change made outside it. A new network's password field took focus, masked what was typed and kept it through live updates (nothing was connected). Do not disturb turned on and off. Restart armed on the first click and wasn't confirmed.
- Displays: display 2 set to 1024×768 and 1280×720 from its resolution buttons. The banner counted down, and the mode went back by itself after 15 s, or stayed after Keep. Dragging display 2 below display 1, then "Right of 1", moved it there and back. Over the service: 30 and −20 DIP offsets snapped to 0, while 300 stayed. Rotation to 90° (from GNOME's page, then Revert Settings), mirroring on and off, and size 125% (desktop width 1280 → 1024 DIPs) all applied and went back. The shells came back on display 2 after mirroring.
- From the bars: niri's and plain's display indicators opened their popovers, and "Display settings…" / "All settings…" opened the switcher on those pages. GNOME's (Charon's) quick-settings display button opened its Settings → Displays page. Hydra's quick settings had the two rows, and each opened its page.
- Found and fixed in that run: on X11 a host window never resizes for its mode, so going back to the native mode was reported as a failure ("couldn't put it back") though it applied; it now counts as done when the active mode is the one asked for. A mode with no refresh rate read "at 0 Hz". Narrow boxes in the drawing clipped their text (they drop the detail line now). Hydra's two buttons had widened its quick-settings popover past the screen's edge, so they're rows now.
- Not checked on X11 (it can't be): the built-in panel off, real refresh rates and DRM rotation, hotplug while the page is open, and Wi-Fi connect or Bluetooth pairing from the switcher. Those need real hardware.

### Verified (steps 2–4, Xvfb `:99` and DRM, plain shell at startup, T3 second)

| Check | |
|---|---|
| foot started in a plain thread arrives tagged with that thread (in the container, named by the library from the helper) | ✓ |
| T3 adds `t3:thread/x` and `wm:workspace/2`; `a b` is skipped; removing the origin does nothing; both pages see the same tags | ✓ |
| The helper lists the window for both threads; removing a tag works; `updateWindowTags` on a missing window rejects (NotFoundError) | ✓ |
| A tab tagged `wm:workspace/1`: its child (`window.open`) starts with the opener's tags | ✓ |
| Groups: each shell's labels are listed with its id, and T3 couldn't take the plain shell's tag; `groupschanged` fires | ✓ |
| An agent's focus request for a plain-thread window, with T3 visible, went to the plain shell, which showed it and came to the front | ✓ |
| Overlay: open, Escape, Enter on a shell switches; searching "foot" and pressing Enter shows it in its owner shell | ✓ |
| Overlay: Ctrl+N adds a shell (URL `http://localhost:8770/…`); its window runs, and its page connects to the helper with the origin reported at runtime | ✓ |
| Overlay: Ctrl+O turns that shell off (window closed), Ctrl+Delete removes it and its groups | ✓ |
| Overlay: Ctrl+T on a window lists the groups with checkmarks; Enter takes it out of / adds it to one | ✓ |
| Plain shell: a T3 tab in group "X" is listed under Elsewhere labelled "X"; a click adds the current thread's tag, and "Remove from thread" appears | ✓ |
| T3: the Apps panel's Elsewhere lists the plain shell's windows and tabs, labelled by group | ✓ |
| T3: opening a plain-shell tab there adds the thread's tag and shows that same tab (same page, no reload) as a browser panel tab | ✓ |
| T3: closing that panel tab takes the thread's tag off; the tab stays open, still in the plain shell's thread | ✓ |
| T3: after a reload of T3 (browser panel tabs don't survive one), the imported tab is back under Elsewhere, and reopening it shows it again | ✓ |
| Plain shell: threads with old ids (`plain-<id>`) are dropped on load | ✓ |
| DRM (tty2, uinput): origin tags of windows and tabs, groups, the overlay (open, Esc, switch, search + Enter), owner routing from the helper | ✓ |
| DRM: T3 imports a plain-shell tab, shows it, and closing the panel tab untags it; a new T3 browser tab still opens one tab | ✓ |

Fixed along the way: the browser couldn't read app environments from inside the container (the fallback above); a views DCHECK (`SetMaximumWidth` on a single-line label); the overlay's list not painting after a rebuild, because the scroll view doesn't resize its contents. The overlay's empty "Shells" heading when a search matches no shell. On DRM, T3's first import opened a blank tab instead: T3 closes a preview's tab and creates it again once the server's epoch is known, so the preview bridge now hands the tab to the re-created preview (same thread and server tab), and an imported tab whose preview closes waits 2 s to be taken back before it is untagged.

## Step 4: frontends

- **Plain shell.**
  - New threads are `plain:thread/<id>`. Older `plain-<id>` threads keep working.
  - It describes its threads with `setGroups`.
  - Its app row has an **Elsewhere** list: windows and tabs that carry none of its threads' tags, labelled with their group. Clicking one adds it to the current thread and opens it.
  - An item that was brought in gets a "Remove from thread" action.
  - A focus request for an item in none of its threads adds the item to the current thread.
- **T3.**
  - A thread's tag is `t3:thread/<id>`. The server passes it to the helper as the thread id, so agents and terminals carry it.
  - T3 describes its threads (with their titles) with `setGroups`.
  - The Apps panel's "Other windows" list is now **Elsewhere**: windows and browser tabs in no T3 thread, labelled with their group. Opening a window adds it to the thread. Opening a tab adds the thread's tag and opens a browser panel tab that shows that same tab (`importBrowserTab`: the preview bridge has the thread's next new preview adopt it). Closing the panel tab takes the tag off again instead of closing the tab. An imported tab no panel tab shows (after a reload of T3) is listed under Elsewhere again.
  - A window's thread is the first `t3:thread/` tag it has.

### Not done in steps 2–4

- The switcher shows only on the display where new windows open.

### Not done in step 1

- ~~No way to manage shells~~ (the overlay, step 3). A command-line shell still comes back on the next start.
- ~~No per-shell routing in the helper~~ (step 2). "Show this window" from an agent goes to the visible shell, even when another shell owns the window's thread. Step 2's group table says which shell owns what.
- ~~The helper takes its shell origins from the command line~~ (pages report the browser's list, step 3). A shell added at runtime (step 3) would also have to be added to the helper. Either the browser tells the helper its list, or the helper asks the browser.
- A shell's renderer crashing leaves a sad page in its window; the overlay's Ctrl+R reloads it.
- **Hidden pages are throttled.** Timers in a hidden shell run at most once a second, as in a background tab. That's fine for event-driven shells. One that needs to animate in the background would not be.
- Only Super is seen by the pages around a switch: the press goes to one page and the release to the other.
- Not tested in the `:0` X11 session (Plasma might grab Super+Tab).
