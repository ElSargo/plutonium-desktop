# Several monitors

**Status:** steps 1–3 below are built (displays and a shell per display, one window in one place, dragging windows between shells), and "show on display N" with them; "As built" says how. Linked documents aren't (no shell needs them yet).

Each display gets its own shell window, and the user picks a shell for each one. A shell that wants to span monitors (T3 with its sidebar on the second one, say) is built on top of that: it runs on both displays and keeps the two in sync itself.

## Why not one shell across both

Each display has its own compositor, vsync rate and device pixel ratio. A Chromium document has one viewport and one `devicePixelRatio`, so a page stretched across a 60 Hz 1× monitor and a 144 Hz 2× one would be wrong on at least one of them. Ash also shows a window on one display, not across two.

So "an element with a tag becomes the root of the other monitor" ends up as two documents anyway. The only question is how tightly they're linked:

- **Independent instances** (the default). The same shell, loaded once per display (`?display=2`). They coordinate over `BroadcastChannel` or the helper. If one crashes or janks, the other doesn't. This is how niri works: each monitor has its own workspace strip.
- **Linked documents** (only if a shell needs it). The primary opens the secondary as a same-origin child document, so the two share one JS heap and React can `createPortal` into the child's body. This is the pop-out-window pattern web apps already use. The costs: one main thread for both monitors, grants that the broker would have to accept across the pair, and stylesheets copied into the child.

T3 probably doesn't need linking. Its state lives on the server and reaches the page over the WebSocket, so a second instance at something like `?layout=sidebar` stays in sync for free. Linking is only for UI state that lives in the page, like a selection or a drag between panes.

Each display has its own shell instances. If T3 is on both monitors, that's two T3 pages, not one page moving between them. This keeps the ownership rules simple.

## What changes

The rule in `SHELLS.md` that **only the visible shell drives** becomes "the visible shell on each display drives":

- **One window, one place.** A surface has one size, so it can't be live on two displays. Tabs already allow only one `<embed>` at a time. Windows get the same rule: the newest claim wins, and the element that lost it gets a `windowtaken` event so it can show a placeholder.
- **Focus stays global.** One display has keyboard focus, and the visible shell on it gets the shortcuts.
- **Super+Tab acts on the focused display:** it switches that display's shell. The switcher already shows on one display only.
- **Agent routing.** "The visible shell" becomes a set. Routing by group owner (`SHELLS.md`, step 2) mostly covers this already.
- **Hotplug.** Windows and tabs are in one shared, tagged pool, so unplugging a monitor loses nothing. Its windows show up in the remaining shell's Elsewhere list.

## Between monitors

- **Moving things:** a "show on display N" action, routed like the existing focus requests, for the switcher, keyboard shortcuts and agents.
- **Drag and drop:** plain HTML drag and drop. Data between top-level windows on different displays should already work, since Ash's drag controller spans displays (not checked yet). Dragging a live window between shells uses a MIME type, `application/x-plutonium-window`, carrying the window id. The receiving shell asks the broker to take it on drop, so any ordinary drop handler can accept windows. A snapshot is the drag image to start with.
- **Messaging:** same-origin shells have `BroadcastChannel`. Between different shells (T3 on one monitor, niri on the other), tags and groups cover most needs. A general message bus waits for a real use.

## Order

1. A display list and display events in the broker. One shell window per display, a shell choice per display, Super+Tab on the focused display.
2. Ownership: one window in one place, the `windowtaken` event.
3. Dragging windows between shells with the MIME-type payload.
4. Linked documents, only if a shell turns out to need shared in-page state.

## As built

Patch "several displays, a shell per display, one window in one place" (Chromium), the shell library, the helper, niri, plain and T3.

### A shell per display

- **Pages.** `PlutoniumShells` opens every enabled shell's page on every display, each in a fullscreen app window there (`display::ScopedDisplayForNewWindows`). With two displays and three shells that's six pages. Pages on the startup display have the shell's URL as before; pages on the others get `display=<id>` in the query, which the frontends key their per-display state by.
- **Visible shells.** Each display has its own visible shell. "The visible shell" without a display (the overlay, keys, tab requests, where hidden tabs park) is the focused display's: the one with the active window. `Super+Tab` and the switcher act on the focused display; the switcher opens there.
- **The choice per display** is which shell is visible there: Super+Tab on that display, or the switcher's "Show on display N" on a shell's page. The last choice per display id is kept in local state (`plutonium.display_shells`) and comes back with the display. The startup display starts on the startup shell, as before.
- **Driving.** Only the visible shell on each display drives what it shows (sizes, focus, fullscreen). A switch on one display takes only that display's previous shell's elements out of fullscreen, and the new shell's `<embed>`s don't take tabs that another display's visible shell shows.
- **Hotplug.** A new display gets every shell's page. An unplugged display's shell windows are hidden before Ash moves them to another display, then closed. Everything they showed is still in the shared pool: windows the remaining shells' elements had shown go back to them (below), and the rest are in their Elsewhere lists.
- **Keyboard focus** stays global. `Super+Shift+Left/Right` move it to the display to the left or right (its visible shell's window); `Super+Ctrl+Shift+Left/Right` move the focused window or tab there. A shell that registers these keys (`setShellShortcuts`) gets them instead.

### The broker

- `getDisplays()` → `NativeDisplayEntry[]`: `id` (stable while plugged in), `index` (1-based, left to right: "display 2"), `label`, bounds and work area in DIPs, `scaleFactor`, `rotation`, `primary`, `internal`, `focused`, and `current` (the asking page's display). `displayschanged` fires on subscribing and after any change, focus moves included.
- `ShellEntry` gains `displays` (where the shell has a page) and `visibleOn`; `visible` means visible on the focused display.
- `showWindowOnDisplay(windowId, displayId)` and `showTabOnDisplay(tabId, displayId)` send a `windowfocusrequest` / `tabfocusrequest` to that display's visible shell and move the keyboard there; `focusDisplay(displayId)` only moves the keyboard.
- **Testing hotplug:** with `--plutonium-test-displays`, DevTools' `Plutonium.setDisplaysForTesting({specs})` replaces the displays with host windows (`--ash-host-window-bounds` specs; `"<id>:<spec>"` keeps a display's id).

### One window, one place

- A page's `<native-window>` attaching a window takes it from every other page's elements. Elements of the same page share it as before (the driver rule, `WINDOW_SIZING.md`), so a shell can still show a window twice, such as a thumbnail beside the real thing.
- The elements that lost it get `windowtaken` and `windowState` "taken": their window is no longer drawn there, gets no input from them, and isn't sized by them. They keep their grant.
- **Getting it back.** A taken element gets its window back, with a `windowchange` (state "attached"), when its shell becomes visible on its display and no other display's visible shell shows the window, or when no page shows the window any more (the newest such page in a visible shell). Setting the element's grant again is a new claim, which is what the shells' "Bring it back" does.
- **Hidden shells don't steal.** An element in a hidden shell attaching a window that a visible shell shows starts out taken, and gets it when its shell is shown. This replaces "the visible shell's size wins" from `SHELLS.md`: a window is in one page at a time.

### Show on display N

- **Switcher:** a window's and a tab's page have "Show on display N" for each display; a shell's page has "Show on display N" (or "Visible on display N").
- **Keys:** as above.
- **Agents:** `list_displays` (number, size, scale, primary, focused, the shell each shows), and a `display` argument on `focus_window` and `focus_tab`. The helper asks the owning shell's page, which asks the browser for that display's visible shell (`/v1/displays`; `display` in the focus requests' body).
- **Library:** `displays`, `display`, `displayParam`, `displayschange`, `showOnDisplay(windowId, indexOrId)`, `showTabOnDisplay()`, `focusDisplay()`. Each page tells the helper its display (`display=` on its request stream; `/v1/status` lists it).

### Dragging between shells

Plain HTML drag and drop, with `application/x-plutonium-window` and `application/x-plutonium-tab` carrying the item's id (the library's `startItemDrag(event, {windowId | tabId})` and `itemFromDrop(event)`). The drop target shows the item, with a grant (`grantFor`) or `tabElement`, and that claim takes it from where it was. The browser's default drag image (the dragged element) stands in for a snapshot.

### The frontends

- **niri:** each display's page is one of niri's outputs, with its own workspaces and its own stored layout. An item is on the output whose `niri:output/<display id>` tag it carries; new items, and those whose display went away, go to the focused display's page, which tags them. A window or tab focused or dropped on a page moves to its output. A tile whose window another page took shows a placeholder, and focusing it brings the window back.
- **Plain:** the threads are shared; each display has its own current thread and open tabs. A taken window shows "Shown on another display" with "Bring it back". Apps and tabs can be dragged (to another shell or display), the stage takes drops, and "To display N" sends the shown item to another display.
- **T3:** an app tab whose window another display took shows a placeholder with "Bring it back"; the app header has "To display N". T3's own state is on its server, so a T3 page per display stays in sync without more.
