# Wayland protocols Plutonium adds to Exo

Exo is ChromeOS's Wayland server, so it speaks what Chrome, ARC and Crostini need. Desktop apps expect more. These are the ones Plutonium has added, beyond embedding (`BROKER.md`), capture (`CAPTURE.md`) and input methods (`IME.md`).

## `xdg_activation_v1`: apps raise their windows

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

## `wp_cursor_shape_v1`: cursors by name

GTK 4.16+, Qt 6.8+ and foot ask for a cursor by name, rather than drawing it from their own theme. So their cursors match the page's, at its scale.
- **Mapping:** shapes map to Chrome's cursor types the way Ozone's Wayland client maps them the other way.
- **Path:** they go through `Pointer::SetCursorType()`, as Chrome's own `zcr_cursor_shapes_v1` does, so an embedded window's cursor reaches the page.
- **Scope:** version 1, pointers only (Exo has no tablet tools).

**Tested** on X11: foot binds it and sends `set_shape(serial, text)`. With the pointer over foot, the X cursor was the I-beam (25×25, hotspot 12,12). Over the page it was the page's own cursor (read with XFixes).

## `ext_idle_notify_v1`: apps hear when the user is idle

Discord's and chat apps' away status, swayidle. Version 2.
- **Idle:** a notification goes idle after its timeout without a key, pointer move or touch (Ash's `ui::UserActivityDetector`, which the lock's idle uses too), and resumes at the next one.
- **Inhibitors:** those from `get_idle_notification` are also held off while anything inhibits idle, and count again from when the last one goes. The helper's session service knows every inhibitor (shells', apps' over D-Bus and the portal, the browser's wake locks, Wayland apps' `zwp_idle_inhibit`; `DESKTOP_SERVICES.md`, "session") and says whether there are any at each look (`Plutonium.setIdleInhibited`; back to false when its DevTools client goes). So a new browser wake lock counts within the helper's poll (up to 30 s), and one going within 5 s. As in wlroots, an inhibitor that comes while a notification is idle leaves it idle. Those from `get_input_idle_notification` ignore inhibitors.
- **Tested** on X11 (slot 18, `swayidle -d timeout 3`, input from `xdotool` on the slot's Xvfb): idle 3 s after start, resumed at a pointer move, idle again 3 s after a key. With a Screen Wake Lock in the shell page (seen by the helper), no idle for 10 s; after releasing it, idle 8 s later. `get_input_idle_notification` wasn't tried (swayidle doesn't use it). `helper/test/session.test.ts`: the browser told of a shell's inhibitor and its going.

## `ext_data_control_v1`: the clipboard for clipboard managers

Clipboard managers and wl-copy and wl-paste read and set the clipboard without focus, and hear of every change.
- **Offers:** a device gets the clipboard when made and on each change, as a focused app gets it through `wl_data_device` (the same types: text, HTML, RTF, images, files).
- **Setting:** `set_selection` reads the source into the clipboard as `wl_data_device`'s does (only the types Chrome keeps); a null source clears it.
- **Who may:** any client. Anything running as the user can read and set the clipboard some other way (the browser's DevTools, driving an app), so a check here would hold nothing back (`TAB_FEATURES.md`, no fake restrictions).
- **No primary selection** (Exo has none): wl-copy says so; a source given to `set_primary_selection` is cancelled.
- **Tested** on X11 with wl-clipboard 2.3 (`WAYLAND_DEBUG` showed `ext_data_control_device_v1`): wl-copy then wl-paste; `wl-paste --watch` saw wl-copy's copies and the shell page's `navigator.clipboard.writeText()`; a wl-copy replaced by the next one exited (cancelled); `wl-copy --clear` emptied it. The page reading wl-copy's text with `navigator.clipboard.readText()` waited on a permission and wasn't checked; the watch saw the copy go through the browser's clipboard (its types).

## `xdg_toplevel_icon_v1`: apps' window icons

An app names its window's icon or gives its pixels (Qt 6.7+, SDL 3): for an app without a desktop entry, or windows with icons of their own.
- **Pixels:** Exo asks for 128 px (`icon_size`). Square wl_shm buffers are copied when added (the client may destroy them after `set_icon`, as Qt does). The smallest at least 128 px, else the biggest, scaled down to 128, becomes a PNG data URL.
- **To the shells:** the name and URL go with the window (`EmbeddedWindows::Info`, the broker's `WindowInfo`, `NativeWindowEntry`'s `iconName` and `icon`, "" if none). The shell library's `windowIcon(window)` looks the name up as app icons are looked up (the helper's `GET /v1/apps/<id>/icon`), else uses the pixels, else the window's app id's icon. The GNOME shell uses it for windows without a desktop app; niri's minimap for every window. The switcher's window rows look the name up first (not the pixels).
- **Tested** on X11 with kwrite: it named `kwrite` and added 16–256 px buffers (ARGB8888); the window's entry had `iconName: "kwrite"` and a 128 px PNG that decodes to kwrite's icon. `windowIcon()` gave the helper's icon for the name, the pixels for an unknown name, and the app id's icon without either. The shells' and switcher's rows weren't looked at; resetting an icon (`set_icon` with null) wasn't tried.

## Still missing

Explicit sync (`linux-drm-syncobj`) (`BACKLOG.md`).
