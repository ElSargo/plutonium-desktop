# Several shells in one session

Switch between shells (frontends such as T3 Code and the plain shell) without losing apps or tabs. Every app window and browser tab can be shown by any shell.

Plan, agreed on 2026-10-17:

1. **Browser: several live shells** (done, below). Steps 2–4 are done too. Every enabled shell's page runs all the time, one is visible, and switching is instant.
2. **Tags and group labels.** Every window and tab gets a set of namespaced tags (`t3:thread/<id>`, `plain:thread/<id>`, `wm:workspace/2`, …), and a table of groups (tag → label, owning shell). Items with the same tag belong together, so a workspace window manager and a thread-based shell can understand each other's grouping. Importing an item into a thread adds the thread's tag. The thread an app was started in stays as a fixed tag. Only shells and the native UI may set tags, and a tag also gives that thread's agent access.
3. **Native overlay** (Ash, views): Super+Tab opens it, arrows move, Enter acts. It lists the shells: switch, add, edit, turn off. It also lists every window and tab grouped by label, with search, and actions: focus in its shell, pop out, add to thread, close.
4. **Frontends:** T3 and the plain shell register their threads, tag what they open, and get an "Elsewhere" area for importing items from other shells.

## Step 1: several live shells

Tested on 2026-10-17. On Xvfb (`:99`) the plain shell was the startup shell, with T3 second. On DRM (tty2) T3 was the startup shell, with the plain shell second.

### Using it

```
# DRM: T3 at startup, the plain shell second
plutonium run t3 plain

# Xvfb: the plain shell at startup, T3 second
plutonium run --x11 plain t3
```

**Super+Tab** shows the next shell and **Super+Shift+Tab** the previous one. These are stand-ins until the overlay (step 3) exists.

`SHELLS` is `<name>=<url>|<name>=<url>`. The launchers pass it to the browser as `--plutonium-shells`. They also add its origins to the helper's `--shell-origin`, which now takes a comma-separated list. Each URL has to name the session's helper: `?helper=` for the plain shell, `?plutoniumHelper=` for T3.

### How it works

- **The list** lives in local state (`plutonium.shells`: id, name, URL, enabled). The startup shell (`--plutonium-shell-url`) and the `--plutonium-shells` entries are added to it when it doesn't have them yet. An entry it has is one with the same URL but for the fragment (where the launcher puts T3's one-time pairing token), or the same name on the same origin; it takes the new URL. The startup shell is always enabled.
- **Windows.** The startup browser (`--app`) becomes the startup shell's window. Once it exists, every other enabled shell gets its own fullscreen app window, opened hidden. Switching shows and activates the target window and hides the previous one. A hidden page reports `document.visibilityState === "hidden"` and is throttled like a background tab, but it keeps running: its WebSocket, its EventSource and its broker events all carry on.
- **Who is a shell.** A shell document has to be in its own shell's window and on that shell's origin. A shell's origin in another shell's window doesn't count. Outside shell mode nothing changed: there's one `--plutonium-shell-origin`, in any top-level page. Renderers get the list of origins (comma-separated `--plutonium-shell-origin`), so the SurfaceEmbed plugin loads in every shell.
- **Only the visible shell drives.** Every shell gets the full broker: windows, tabs, grants and events. Only the visible one decides how windows and tabs are shown (with several monitors this becomes one visible shell per display, `MULTI_MONITOR.md`):
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
- **When the browser can't read the environment** (Ash in a container with its own user namespace, as in all our test setups), the window arrives with no tags. The shell library asks the helper (on the host) for the pid's thread and names the origin once, with `setWindowOriginTag`. From then on it's fixed like any other origin. A browser on the host reads it itself.
- **Shells add and remove the others** with `updateWindowTags(id, add, remove)` and `updateTabTags(…)`. So does the browser's overlay. Removing the origin does nothing. The helper and agents can't change tags.
- **A thread's id is its tag.** The helper gives an agent every window and tab that carries its thread's tag: the ones its processes started, plus the ones a shell added to the thread.

### Groups

A group is a tag that a shell has described: `{tag, label, shellId}`.
- Each shell replaces its own groups with `setGroups([{tag, label}])`. A tag another shell already owns stays with that shell.
- `getGroups()` and the `groupschanged` event return every shell's groups.
- The table is kept in local state (`plutonium.groups`), so items keep their labels while their shell is off. Removing a shell drops its groups.

**Routing.** A page's request stream says which shell it is (`shell=<id>`, from `getShellId()`). The helper asks the browser for the groups (cached for 2 s) and sends a thread's requests to the shell that owns the thread's group. When that shell shows what an agent asked for, the library makes it visible (`showShell()`).

## Step 3: the overlay (the switcher)

**Super+Tab** opens the switcher over whatever is in front, with the next shell selected. On the left is a sidebar, split in two, each half scrolling on its own: the shells at the top, every window and tab below. On the right, the main area shows the selected item's page. The search box filters both halves.

- **Left click** acts: a shell is shown, a window or tab opens fullscreen.
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

**A window's page:**
- Open fullscreen, or Leave fullscreen.
- Pop out to the desktop.
- Close.
- **In the shells:** each running shell, whether it shows the window (has a `<native-window>` attached to it), and "Focus it in <shell>". That shows the shell and sends it a `windowfocusrequest`; a shell that doesn't listen gets the window popped out instead.
- **Inspect:** a snapshot (taken even while the window is hidden; "New snapshot" takes another), the window and process ids, app id, size and scale, keyboard focus, where it was started, and its tags with their labels.
- **Groups:** a toggle per group (the origin group can't be left).

**A tab's page:** open it fullscreen (or leave fullscreen), show it in its shell, load its address in the backup browser, reload or close it, open its DevTools (a tab beside it), a snapshot, its details, and the same group toggles.

**Open fullscreen** (`exo::EmbeddedWindows::Present()`, EXO-PRESENT) puts the window on the desktop, fullscreen and active, even while shells' elements show it. Until it ends, those elements keep their attachments but don't park, size, focus or send input to the window. It ends:
- with **Super+F**, which returns to the visible shell;
- when a shell is shown (`PlutoniumShells::Show()`), or a backup window opens;
- with Leave fullscreen or Focus it in….

The window then goes back to its elements, at the size they last asked for. With `--plutonium-hide-windows` and no element, it leaves the desktop. One window is presented at a time.

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
| A tab's page: snapshot, details, group toggles | ✓ |
| No DCHECKs in Ash's log | ✓ |
| (patch 0024) Left click on a tab: the page itself fullscreen; a click in it navigates it | ✓ |
| (patch 0024) A tab Plain showed, opened fullscreen, then Super+F: back in Plain's `<embed>`, painting | ✓ |

Not tried: DRM, the tab page's DevTools and backup-browser buttons, and a shell's DevTools button.

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

- The switcher shows no app icons, and only on the display where new windows open.

### Not done in step 1

- ~~No way to manage shells~~ (the overlay, step 3). A command-line shell still comes back on the next start.
- ~~No per-shell routing in the helper~~ (step 2). "Show this window" from an agent goes to the visible shell, even when another shell owns the window's thread. Step 2's group table says which shell owns what.
- ~~The helper takes its shell origins from the command line~~ (pages report the browser's list, step 3). A shell added at runtime (step 3) would also have to be added to the helper. Either the browser tells the helper its list, or the helper asks the browser.
- A shell's renderer crashing leaves a sad page in its window; the overlay's Ctrl+R reloads it.
- **Hidden pages are throttled.** Timers in a hidden shell run at most once a second, as in a background tab. That's fine for event-driven shells. One that needs to animate in the background would not be.
- Only Super is seen by the pages around a switch: the press goes to one page and the release to the other.
- Not tested in the `:0` X11 session (Plasma might grab Super+Tab).
