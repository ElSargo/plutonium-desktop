# Wayland protocols Plutonium adds to Exo

Exo is ChromeOS's Wayland server, so it speaks what Chrome, ARC and Crostini need. Desktop apps expect more. These are the ones Plutonium has added, beyond embedding (`BROKER.md`), capture (`CAPTURE.md`) and input methods (`IME.md`).

## `xdg_activation_v1`: apps raise their windows (patch 0063)

Apps use it to bring up a window:
- a terminal or chat app opens a link in a browser that's already running;
- a second launch of a single-instance app shows the first one's window;
- an app spawns another app and passes its token on (`XDG_ACTIVATION_TOKEN`).

**Tokens.**
- A token is **valid** if the client that committed it had keyboard focus at that moment. The surface and serial the client names aren't checked: what counts is that the user is in that app.
- Each token lasts 60 s and can be used once. Unknown, used, stale and invalid tokens are ignored.

**Activating.** `activate(token, surface)` with a valid token, on a toplevel:
1. Exo notifies `EmbeddedWindows` observers (`OnEmbeddedWindowActivationRequested`).
2. The broker asks a shell to show the window, with the `windowfocusrequest` event that the shells overlay uses (`SHELLS.md`). The shell is the one that owns the window's group, or else the visible shell. The browser doesn't switch to that shell.
3. The shell library's handler shows the window through the shell's `onFocus`. A shell without `onFocus` pops the window out onto the desktop.

**Tested** on X11 with a test client (two windows, A and B):
- **No keyboard focus:** a token taken then and used on B was refused (`EXO-ACTIVATION token not valid` with `--vmodule=xdg_activation=1`).
- **A focused:** a new token used on B gave `window #2 asked of its shell`. The plain shell switched to B, which got keyboard focus.
- **Real apps:** foot and GTK 4 bind it. Raising each other wasn't tested.

## `wp_cursor_shape_v1`: cursors by name (patch 0064)

GTK 4.16+, Qt 6.8+ and foot ask for a cursor by name, rather than drawing it from their own theme. So their cursors match the page's, at its scale.
- **Mapping:** shapes map to Chrome's cursor types the way Ozone's Wayland client maps them the other way.
- **Path:** they go through `Pointer::SetCursorType()`, as Chrome's own `zcr_cursor_shapes_v1` does, so an embedded window's cursor reaches the page.
- **Scope:** version 1, pointers only (Exo has no tablet tools).

**Tested** on X11: foot binds it and sends `set_shape(serial, text)`. With the pointer over foot, the X cursor was the I-beam (25×25, hotspot 12,12). Over the page it was the page's own cursor (read with XFixes).

## Still missing

`xdg_toplevel_icon`, explicit sync (`linux-drm-syncobj`) and `ext_data_control` (`BACKLOG.md`).
