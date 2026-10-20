# Several monitors

**Status: design. Nothing here is built yet.**

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
