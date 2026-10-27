# The GNOME shell

`shells/gnome`: a GNOME-like desktop. A top bar with Activities, the clock and quick settings; floating windows with edge tiling; dynamic workspaces, each one a thread; the Activities overview with a dash of pinned apps; and a Settings app. It's installed, off, like niri; turn it on from the switcher or `plutonium run gnome`.

## What it does

- **Workspaces are threads.** Workspaces come and go as needed, as in GNOME. Each has its own tag, `gnome:workspace/<id>`: apps, tabs and Claude Code started on a workspace belong to its thread, and moving a window moves it to that thread. A workspace you rename (right-click its thumbnail) is kept even when empty, and its name becomes the thread's label. A moved window can still be reached from the thread it started in, because a window's first tag can't be dropped.
- **Overview.** Tapping Super, Alt+F1 or the top-left hot corner opens it; Super+A opens the app grid. Workspaces side by side as thumbnails to drag windows onto, window titles and close buttons, and search across apps, open windows, Settings pages and the web.
- **Dash.** Pin from the right-click menu or by dragging an icon on; drag to reorder; drag off to unpin (with Undo). Super+1…9 open the pinned apps. Web, Claude Code and Settings can be pinned. Settings chooses whether the dash shows all the time or at the bottom edge.
- **Quick settings:** volume, microphone and brightness; Wi-Fi, Bluetooth, Do Not Disturb, Keep Awake and Airplane Mode, each with a menu; the power menu. **Date menu:** notifications, what's playing, a calendar. Notification banners at the top.
- **Settings:** Network, Bluetooth, Sound, Power, Screen Lock, Appearance, Multitasking, Keyboard Shortcuts, Apps, Notifications, Date & Time, About.
- **Tiling.** Drag a window to the top edge to maximize, to a side for half the screen, to a corner for a quarter, with a preview. Super+arrows from the keyboard. Two tiled windows share their edge when one is resized.
- **Keys:** GNOME's defaults (Alt+Tab, Alt+\`, workspace switching and moving, Alt+F2, Alt+Space, Super+D, the screenshot keys). Every shortcut can be changed in Settings → Keyboard, and custom commands added.
- **Touchpad swipes** (the shell library's `touchpadswipe`, DRM only): three or four fingers sideways switch workspaces; up opens the overview, up again the app grid, down goes back. The view follows the fingers, one step a swipe.

## Things to know

- With "Super opens the overview" on, the shell takes every Super combination, so apps see none (niri does the same). It's a switch in Settings.
- A keyboard whose F-keys Plutonium treats as a Chromebook top row sends F1–F4 as Back, Forward, Refresh and Zoom; those are bound too. F5 and up become brightness and media keys there, so Alt+F7, F8 and F10 may not work on such keyboards.
- A focused browser tab keeps the keyboard from the shell. To take it back the shell hides the tab for two frames.
- Storage keys must match `[\w.-]`; the per-session key is sanitized.

## Checked

In an X11 test session (2026-10-27), with real keys and clicks: Super tap, Alt+Tab and Alt+\`, tiling and the shared edge, moving windows between workspaces (the helper's thread lists match), dragging and pinning in the overview, search, rebinding a shortcut, the run dialog, a reload restoring the layout, and every Settings page without console errors. Swipes only with synthetic events.

Not checked: a real touchpad (DRM), Wi-Fi connect and disconnect, Bluetooth pairing, the power buttons, keyboard move and resize (Alt+F7/F8), the two dash modes.
