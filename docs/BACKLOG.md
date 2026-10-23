# Backlog

Everything known to be not done yet. Roadmap phases refer to
[OPTION2_PLAN.md](OPTION2_PLAN.md); Phase 1 details are in
[PHASE1_REPORT.md](PHASE1_REPORT.md).

Phase 2 details are in [PHASE2_REPORT.md](PHASE2_REPORT.md), Phase 3 in
[PHASE3_REPORT.md](PHASE3_REPORT.md).

Note: the phase numbers on the section headings below are the original ones.
The roadmap was reordered since: DRM is now Phase 4, threads and agents
Phase 3 (done) and 5.

Each item has a rough size, the phase it belongs to, and a few lines on what
we know. Sizes: **S** ≈ hours, **M** ≈ a day, **L** ≈ several days.

## Finish Phase 1

- [ ] **Re-run Phase 1 and 2 on the real GPU path (DRM/dmabuf).** M · Phase 1/3
  Partly done in Phase 4: foot, KCalc (menus) and dmabuf clients embedded and
  driven on DRM. Still to do: the full exit test on the
  TTY setup (`TTY_REPORT.md`): three apps side by side, typing, menus,
  resize, scroll, flicker. Includes trying GTK with its Vulkan renderer.
- [x] **One client's failing buffers stall the whole display.** M · Phase 1
  gtk4-demo (Vulkan, dmabuf) on Xvfb: buffers can't be imported (no native
  pixmaps), the GPU process logs ~80k shared-image failures and stops
  presenting for everyone. (The trigger is gone since GPU_X11.md: Xvfb
  sessions import dmabufs now and gtk4-demo runs. The missing guard stays.) Exo should reject or drop a buffer that fails to
  import (and tell the client), not keep retrying. The `EXO-DIAG` error
  logging from the viability work may make it worse; demote it.
  Done 2026-10-20 (`chromium/patches/0028`, GPU_X11.md): kwrite's XRGB8888
  shm buffers on Xvfb were the trigger. The GPU process reports which shm
  formats it can import, Exo imports XRGB as ARGB with padding alpha or
  refuses the format (`wl_shm.invalid_format`), and never sends one that
  would stop the GPU channel. `EXO-DIAG` is `VLOG(1)`. Failing dmabuf
  imports aren't guarded the same way.
- [x] **Modal dialogs: page shows the wrong window as focused.** S · Phase 1
  While a GTK modal dialog is open, keys go to the dialog but the parent's
  element still reports `windowFocused`. Embedded focus should follow the
  client's own redirection (or the page should be told).
  Done 2026-10-20 for GTK 4 and Qt 6 (`xdg_dialog_v1`, `chromium/patches/0030`,
  CONTROLS.md): focus on the parent goes to its modal dialog while a page
  shows it. Still open: GTK 3 (only `gtk_shell1` says modal), and shells
  that don't show a dialog, where its keys are lost.

## Security and broker (Phase 2 follow-ups)

Done in Phase 2: window broker and grants, grant-checked embedding and input,
shell-only broker API (`--plutonium-shell-origin`), push events instead of the
JSON registry, viz hit-test rewrite limited to browser-linked children.

- [x] **Unit and browser tests for the broker and grant checks.** M · Phase 2
  Done 2026-10-20 (`chromium/patches/0032`, `features/BROKER.md`): unit
  tests, not browser tests. `plutonium_unittests` is a target of its own
  (about 800 build steps from a built chrome; `unit_tests` would be about
  8,800 and `browser_tests` 8,100): `ExoWindowBroker` grants and revocation,
  `IsShellDocument`, the binder, attach refusals, and an unattached host
  given `Focus`/`SetSize` over raw Mojo. The input router's
  `IsForeignFrameSinkEmbeddedHere` is in `content_unittests`. What needs a
  real Exo window or shell mode is in the live checks below instead.
- [x] **Exercise the untested shell-exclusion cases live.** S · Phase 2
  Done 2026-10-20: `tools/shell-checks/run.sh [--forced]`, 39 checks, all
  passing (`features/BROKER.md`). No holes. Found and fixed on the way:
  `revokeGrant()` crashed the dev build (re-entrant observer list,
  `chromium/patches/0031`). A `javascript:` URL's document keeps the
  previous document's grants: the browser sees no new document, and only
  the shell's own script can make one, so it is not a hole. A compromised
  renderer is covered by the unit test, not live.
- [x] **Forward `OnGrantRevoked` to the shell.** S · Phase 2
  Done 2026-10-20 (`chromium/patches/0031`): the `grantrevoked` event, for
  the document's own grants. The shell library drops a revoked cached grant.
- [x] **Unsubscribe from broker events when the last listener goes.** S
  Done 2026-10-20 (`chromium/patches/0031`): for every kind of broker
  event; listening again replays the current state.
- [x] **`NativeWindowEvent` script constructor.** S
  Done 2026-10-20 (`chromium/patches/0031`). `BrowserTabEvent` has none
  yet.
- [ ] **An activated prerender of the shell has no `navigator.windowBroker`.**
  S · Phase 2. The origin trial is only force-enabled for primary-main-frame
  navigations, so a shell page that prerenders its own next page would lose
  the API on activation (the browser would bind it: the activated page is
  the shell). Not a hole; no shell prerenders today.
- [ ] **Allow an isolated web app origin as the shell** (widen the
  `--plutonium-shell-origin` scheme check) when the real shell is ported. S · Phase 5

## Shell substrate on DRM (Phase 3)

- [x] **Boot straight into the shell.** Done (`PHASE4_PROGRESS.md`):
  `--plutonium-shell-url` opens the page as the only, fullscreen window, with
  Ash in kiosk app mode; `plutonium run` boots it on DRM. Verified on
  the panel (tty2, 2026-10-16).
- [ ] **Autostart at power-on.** Today the session starts from a logged-in VT.
  Getty autologin plus a unit that runs the launcher. S
- [x] **Hotplugged input devices are ignored in the container.** Done: host
  root shows up in the container as uid 65534, which keep-id mapped, so
  libudev dropped the host's events ("Sender uid=65534, message ignored").
  `--userns=keep-id:size=65534` leaves it unmapped, and libudev trusts senders
  from outside its user namespace. No relay. Existing containers must be made
  again (`plutonium doctor` says so).
- [x] **Fullscreen for embedded apps and tabs; keys that work everywhere.**
  Done (`CONTROLS.md`): Super+F, apps' and pages' own fullscreen, shell
  shortcuts, the helper's app list and launcher.
- [x] **Pointer capture for embedded apps** (lock + relative motion,
  confinement, Super+Escape). Done (`CONTROLS.md`). Still to do: a real game,
  confinement regions, X11-hosted sessions.
- [ ] **Super+F on X11-hosted sessions** (Plasma `:0`) not pressed for real;
  KWin may take Super combinations. S
- [ ] **A popped-out foot looked more translucent than its alpha** (DRM,
  2026-10-17). Not investigated. S
- [ ] **Shell mode locks every browser window in fullscreen**, not just the
  shell's (as kiosk does). Scope it to the shell window if needed. S
- [x] **A way out of a DRM session other than the kill switch.** Done
  (`features/SEAT.md`): Ctrl+Alt+Backspace, and VT switching with
  Ctrl+Alt+Fn. Ash is a logind session controller.
- [x] **Start a DRM session on a VT that isn't in front.** Done
  (`features/SEAT.md`, patch 0033): the displays aren't configured until the
  session is in front, and Ash comes up when it is.
- [x] **App launching from the shell.** Done in Phase 3: the helper's
  `launch` (shell library `shell.launch()`, MCP `launch_app`).
- [x] **Zero-copy / display planes for embedded windows.** Done
  (`PHASE4_PROGRESS.md`, item 2): a fullscreen embedded window goes on a plane
  (underlay at scale 1.78, fullscreen strategy at scale 2); NV12 video goes on
  a plane. Fixed: scanout tranche for embedded windows covering the display,
  proposals the AMD topmost-plane rule always blanks, NV12 framebuffers.
- [ ] **Fullscreen apps still need Ash's composite at scale 1.78.** The panel's
  16/9 scale isn't a 1/120 step, so buffers are 4 px short and the topmost-plane
  rule (no cursor plane on AMD) rejects the fullscreen strategy. Pick a shell
  scale such as 1.6 or 2, or relax the rule for sub-pixel scale errors. S
- [ ] **Pixel-snap `<native-window>`.** Elements at fractional device positions
  can't be promoted to planes (DRM takes whole-pixel rects). S
- [x] **Real input on the TTY** (evdev keyboard/mouse). Verified with virtual
  uinput devices on the panel (`PHASE4_PROGRESS.md`, item 3); not yet pressed
  by hand.

## Threads and agents (Phase 4)

- [x] **Agent bridge and snapshots.** Done in Phase 3 (helper + MCP).
- [ ] **Per-thread Exo servers/sockets, tabs per thread.** L · Phase 5.
- [x] **Bridge: driving windows.** Click, type, keys, scroll and drag in
  windows, and Playwright on tabs, without a shell page
  (`features/AGENT_CONTROL.md`).
- [x] **Bridge: MCP for Codex and other T3 providers.** T3's own MCP server
  offers the helper's window tools to every provider.
- [ ] **Remote clients see native windows.** M · A T3 client away from the
  desktop has no Apps panel content. The helper has window screencasts
  (`Plutonium.startWindowScreencast`) and input; T3 would stream them
  (`/api/window-stream`) and draw them in the Apps panel.
- [ ] **Agents and popups.** M · Menus (`xdg_popup`) aren't in window
  snapshots and agent clicks don't reach them.
- [ ] **Agent typing beyond a US layout.** S · Map text through the
  session's keymap (xkb) instead of assuming US keycodes. Characters the
  layout lacks need the temporary keymap that password auto-type needs too
  (`PASSWORDS.md`, "Native windows"); build it once for both.
- [ ] **Bridge: the page learns the helper's URL by convention** (port 3780,
  or `?helper=` / `?plutoniumHelper=`). S · Could come from the launcher or
  the browser.
- [x] **Helper: no tests.** M · Unit tests for the resolver, relay and
  thread scoping; an end-to-end run against a fake shell.
  `cd helper && npm test` (`DEVELOPING.md`, "Helper tests"): also the X
  displays, D-Bus, accessibility (a fake AT-SPI bus) and the MCP server.
- [x] **Helper restarts forget thread X displays.** S · Processes started
  before keep a dead `DISPLAY`. Persist the mapping, or re-adopt live
  satellites. Both: the satellites outlive the helper, the next one takes
  them over from a saved map, and starts gone ones again on the same display
  for processes that still use it. `plutonium stop` stops them.

## App compatibility and features (Phase 5)

- [x] **Port the real shell web app** onto `<native-window>` and the broker.
  Done twice: T3 Code (`T3_SHELL_TEST.md`) and the plain shell (`shells/plain/`).
- [x] **Browser tabs as elements.** Real pages as SurfaceEmbed `<embed>`s,
  tagged with threads, driven through the broker and the agent bridge
  (`features/TABS.md`). Tested in the plain shell on Xvfb and on DRM.
- [x] **Tabs in T3 Code.** T3's Browser panel and agent automation run on
  Plutonium's tabs (`features/TABS.md`, "In T3 Code"), on Xvfb and DRM.
- [x] **Pass an embedded app's maximize/minimize requests to the shell.**
  Done (`WINDOW_SIZING.md`): `windowrequest`; niri and T3 map maximize.
- [ ] **Window sizing on real input.** S · Verify on DRM: the "last pressed"
  rule for several elements on one window, pointer input on a scaled
  (`object-fit: contain`) window, and the niri/T3 animations at full speed.
- [ ] **Shells use `windowrequest` move/resize.** M · An app's title-bar drag
  or edge resize could become niri's interactive move or column resize. The
  page would need the pointer for the rest of the drag.
- [ ] **Cross-fade on the compositor thread.** S · The old frame's opacity is
  stepped from the main thread each frame; a busy shell page makes it stutter.
  A cc opacity animation on its effect node (as LinkHighlightImpl does) would
  not.
- [ ] **T3 browser features still missing.** M · Zoom, color scheme, mute,
  element picker, screenshots to file, recording, PiP windows, DevTools
  window, console/network entries in snapshots. T3 doesn't draw Chrome's
  context menus itself yet (`CHROME_UI.md`): it gets Chrome's, filtered.
- [ ] **T3 sidebar: show a thread's open apps and tabs; decide what snooze and
  settle do to them.** M–L · Phase 5
  - Indicator: like the terminal one on a thread row (`Sidebar.tsx`,
    `terminalStatus`), with a count in the tooltip. Icons: a tab's
    favicon, or a generic browser icon; an app's desktop-file icon (from
    its app_id, or `xdg_toplevel_icon` once Exo has it), or a generic app
    icon. With several, show one or two and a count. The helper's icon
    lookup is shared with "Switcher: app icons".
  - Settle closes the thread's apps and tabs by default. First it asks
    for confirmation and lists what will close. The confirmation can be
    turned off globally, or for one app (by app_id) or one site (by
    origin). The same settings could also keep an app or site open.
  - Snooze needs a setting with the same global, per-app and per-site
    overrides: keep running (the default?), close, or close and reopen on
    wake (tabs only; apps can't be restored). Reopening a tab with its
    state needs the same work as "Tabs don't survive a browser restart".
  - Closing asks the app nicely (`xdg_toplevel.close`) and handles apps
    that refuse or ask to save. Un-settling doesn't reopen anything.
- [x] **Touchpad on DRM.** Through libinput (`use_libinput`), with scrolling
  into native windows fixed (`NIRI_SHELL.md`, "Scrolling in apps").
- [ ] **Chrome UI still in the shell** (`CHROME_UI.md`). S–M · Ash's
  tooltips for `title`; a shell page's own `alert()`, permission bubbles
  and file pickers; the system clipboard read before a context menu stalls
  an X11 session's menu until the next X event (seen once in four on
  Xvfb).
- [ ] **Tabs don't survive a browser restart.** M · Session restore.
  Not needed yet (2026-10-20). Also
  what "close and reopen on wake" for a snoozed thread needs (the T3
  sidebar item).
- [x] **Drag and drop** between native apps, tabs and pages
  (`DRAG_AND_DROP.md`). Tested on DRM in the niri shell.
- [x] **Clipboard** between page content and native apps
  (`wl_data_device.set_selection`). Works in daily use (the user,
  2026-10-20); an automated check in both directions is part of the DRM
  verification pass. The primary selection (middle-click paste) isn't a
  requirement.
- [ ] **text-input-v3 (IME for GTK 4, Qt, foot).** L · Phase 5
  Exo only has text-input-v1. With v1, activation and focus handoff to and
  from the page work (`weston-editor`).
- [ ] **Test real IME composition.** S · Phase 5
  No IME engine runs on the Xvfb Ash, so pre-edit/commit was never
  exercised. Needs a session with a ChromeOS IME available.
- [ ] **Other missing Wayland protocols** as apps need them: `xdg_activation`,
  `wp_cursor_shape_v1`, `xdg_toplevel_icon`, explicit sync,
  `ext_data_control`. M each · Phase 5
- [x] **X11 apps** via rootless Xwayland as an Exo client. Done
  (xwayland-satellite per thread, now in the helper).
- [ ] **Our own portal backend for the rest** (`org.freedesktop.impl.portal.*`
  behind `xdg-desktop-portal`). L · Phase 5
  Builds on the helper's capture backend (ScreenCast, Screenshot and
  GlobalShortcuts are in "Capture and sharing" below), using the same
  `plutonium.portal` and `plutonium-portals.conf`, which then prefer us for
  more interfaces. The UI is drawn by the shell rather than GTK or KDE
  dialogs: FileChooser, OpenURI (Flatpak link opening, see
  `features/OPENING_LINKS.md`), Settings (color scheme, accent),
  Notification, Inhibit, Print, Account, Access and Background. A
  FileChooser dialog should open over its parent's element (see "Where do
  dialogs go?") and uses the same picker as tabs' file inputs (`TAB_FEATURES.md`). Needs
  the parent window handle mapped to Exo windows, which the capture picker
  needs too.
- [ ] **Password manager adapter** (`features/PASSWORDS.md`). L · Phase 5
  One adapter for the user's manager (Bitwarden first, then 1Password,
  KeePassXC, `pass`). Logins are auto-typed into tabs (origin-checked) and
  native windows (by app id), with the clipboard as a fallback. Agents can
  ask for a fill through an Ash-drawn prompt and never see the secret.
  Native typing needs an Exo patch (key events with a temporary keymap).
- [ ] **Accessibility and HiDPI polish.** L · Phase 5 (Several monitors has
  its own section below.)
- [ ] **Packaging:** reproducible build that runs on NixOS outside the dev
  container. L · Phase 5
  Running is done for release builds: `HOST=1`, `plutonium host build`
  (`nix/chrome.nix`, the release binary autoPatchelf'd against nixpkgs).
  Verified on X11 (Xvfb :99, GPU, embedded foot); DRM not yet. Still to do:
  building Chromium itself as a Nix derivation, and dev builds on the host.

## Browser features for tabs (`TAB_FEATURES.md`)

In the suggested order. Tabs have no `Browser` behind them, so these were
missing. Decided (2026-10-20): attach tab helpers rather than host tabs in a
hidden `Browser`. Passwords don't wait on this (`PASSWORDS.md`). Each feature attaches its helpers to the registry's
`WebContents` (not `TabFeatures`, which needs a `TabInterface`), asks the shell
showing the tab with a cancelable event, and falls back to Chrome's UI.

- [ ] **Tab request plumbing, and zoom.** S–M · `plutonium_tab_requests`
  (one request, answer and fallback path, generalising the context menu's),
  `pending` on `BrowserTabEntry`, the new `tabCommand`s and keys, the
  library's `connect()` options and dialog styles. Zoom: `ZoomController`,
  `ContentsZoomChange`, `BrowserTabEntry.zoom`, `setTabZoom`; T3's zoom.
- [ ] **File pickers for tabs.** L · `RunFileChooser` through
  `FileSelectHelper`, and a `SelectFileDialog` factory that sends registry
  tabs' pickers (inputs, File System Access, Save As) to the shell as
  `filechooserrequest`. The library's picker over the helper's file listing.
  Container sessions mount the user's home at the same path until Ash runs
  outside the container (decided). Uploads are cancelled in every tab today.
- [ ] **Permission prompts for tabs.** M–L · `PermissionRequestManager`,
  `PageSpecificContentSettings`, the media delegate methods (`getUserMedia`
  fails in tabs today), `permissionrequest`/`answerPermission`, devices in
  use on the tab. Fallback when no shell takes it: dismiss, and
  mark the request blocked on the tab.
- [ ] **Per-thread permission grants.** M · Scopes once, this thread and
  everywhere; a (thread, origin, permission) store and a check in
  `PermissionContextBase`. Default "this thread". Grants survive settling and go on archive or
  delete. Agents can deny; to grant they ask the user (also
  `Browser.grantPermissions`).
- [ ] **Downloads in threads.** M · A download observer that records the
  tab's thread, `download*` events to every shell, `downloadCommand`, open
  and show through the helper in the thread's environment, closing the empty
  tab a download leaves. Files go to `~/Downloads` by default, with options
  for a `.downloads` in the thread's working directory or
  `~/Downloads/<thread>/`.
  `list_downloads` for agents; Playwright's download events in the relay.
- [x] **Find in page.** S–M · `FindTabHelper`, `findrequest`, `find`,
  `stopFind`, `findresult`, and the library's find bar.
- [ ] **Printing from tabs.** M–L · `PrintViewManager`, `printrequest`,
  `printToPdf` for the shell's preview, host printers and jobs through the
  helper (CUPS); agents may print. Chrome's preview over the shell's window as the fallback.
- [ ] **FileChooser and Print portals on the same picker and dialog.** M ·
  Part of "Our own portal backend for the rest": the same
  `filechooserrequest` and print dialog for native apps.
- [ ] **Form autofill in tabs.** S–M to L · Not now (decided 2026-10-23).
  Later: identities and cards through the password adapter.

## Capture and sharing (`CAPTURE.md`)

In order. The design and the decisions behind it are in `features/CAPTURE.md`.

- [ ] **Shell capture API and screenshots.** M · `shell.capture()` →
  MediaStream and `shell.screenshot()` → PNG for outputs, windows, tabs and
  regions, on the snapshot and capturer code from patches 0005 and 0007.
  niri's Print key with a region/window selector, saving to
  `~/Pictures/Screenshots`. The global recording and screenshot switches, enforced in
  Ash. Copying to the clipboard waits on the clipboard item.
- [ ] **Capture requests to the focused shell; events to every shell.** M ·
  `capturerequest`/`answerCapture`, `capturestart`/`capturestop`,
  `stopCapture`. Ash's fallback picker, and its own indicator when the
  focused shell doesn't acknowledge a capture.
- [ ] **Resizing a window for capture.** M · A capture size that overrides the
  element's in `configure`. The element shows the frame with `object-fit`, and
  the stream letterboxes when the app picks another size. Check that a parked
  window gets steady frame callbacks while it's captured.
- [ ] **PipeWire output from Ash.** L · A producer of our own (WebRTC's
  `rtc_use_pipewire` is off for `target_os = "chromeos"`, and its code is
  consumer-only): dmabuf with modifiers, a shared-memory fallback, the three cursor
  modes. libpipewire in the container image.
- [ ] **Portal backend in the helper.** L · `impl.portal.ScreenCast` and
  `Screenshot`, `plutonium.portal`, `plutonium-portals.conf`,
  `XDG_CURRENT_DESKTOP=Plutonium`, restore tokens that name stable things.
  Test with OBS and native Discord.
- [x] **`ELECTRON_OZONE_PLATFORM_HINT=wayland` in the thread environment.** S ·
  The XWayland Discord can't share a screen: its rootless Xwayland holds
  only its own windows. With `XDG_SESSION_TYPE=wayland`, which Electron 38+
  goes by instead; the helper resolves the apps it launched by pid, as
  Electron 43 blanks its environ.
- [ ] **GlobalShortcuts portal.** M · The helper answers it; the focused shell
  binds keys through `setShellShortcuts`. Discord push-to-talk, OBS hotkeys.
- [ ] **`ext-idle-notify-v1` in Exo.** S–M · Exo has `zwp_idle_inhibit` only.
  Discord's away status.
- [ ] **getDisplayMedia from tabs through the shell picker.** M · Replace
  Ash's `DesktopMediaPicker` with `capturerequest`.
- [ ] **Agent recording over MCP.** M · Records the agent's own thread's items to a file, with no
  dialogs. It goes to every shell as `capturestart` and honours the global switch.
- [ ] **Discord screen-share audio.** S to test, M to fix · If Discord wants a
  per-app node, publish one from the shared window's pid (as venmic does).
- [ ] **`ext-image-copy-capture-v1` in Exo,** for grim, wf-recorder and obs-wlrobs.
  M · Later.

## Several shells (`SHELLS.md`)

- [x] **Several live shells, Super+Tab** (step 1). Shared windows and tabs,
  the visible shell drives them.
- [x] **Tags and group labels** (step 2). M–L · Namespaced tags on windows
  and tabs, a group table (tag → label, owner), agent access by tag,
  helper routing to the owning shell.
- [x] **Native overlay** (step 3). L · Ash views: shells (switch, add, edit,
  turn off, reload), every window and tab by group, search, actions.
  Replaces Super+Tab cycling. The helper must learn shells added at runtime.
- [x] **The switcher** (the overlay, reworked). L · A sidebar of shells over
  windows, and a page for each: shell status and management, a window's
  shells, fullscreen (EXO-PRESENT), snapshot and details. An add-shell guide,
  a backup terminal (the helper's page) and browser (Chrome's), and launching
  an app fullscreen.
- [ ] **Switcher: app icons** in the window list and the launcher (the helper
  serves them; SVG needs decoding in the browser process).
- [ ] **Switcher on DRM**: verify it there (only Xvfb so far).
- [x] **Frontends** (step 4). M · T3 and the plain shell register threads,
  tag what they open, show an "Elsewhere" area with import.

## Several monitors (`MULTI_MONITOR.md`)

In order. A shell window per display, each with its own shell instances;
shells that want to span monitors run on each and sync themselves.

- [ ] **Displays in the broker; a shell per display.** M–L · A display list
  and events, one shell window per display, a shell choice per display,
  Super+Tab and the switcher on the focused display, agent routing to the
  set of visible shells. Hotplug moves an unplugged display's windows to
  Elsewhere.
- [ ] **One window, one place.** M · Replaces "only the visible shell
  drives": the newest claim on a window wins and the loser gets
  `windowtaken`. Tabs already work this way.
- [ ] **Show on display N.** S · Routed like focus requests, for the
  switcher, shortcuts and agents.
- [ ] **Drag windows between shells.** M · `application/x-plutonium-window`
  carrying the window id; the drop asks the broker to take it. Check that
  Ash's drag controller already carries ordinary data across displays.
- [ ] **Linked documents** (a shell's second display as a same-origin child
  document). Only if a shell needs shared in-page state; T3 shouldn't.

## Design questions

- [ ] **Where do dialogs go?** Today a dialog (e.g. GTK About) becomes its own
  embeddable window and needs its own element. Options: auto-show it over its
  parent's element, or hand it to the shell to place.
- [ ] **Page zoom.** Zooming the page gives the app more DIPs (bigger
  logical size) rather than bigger content. Decide which is wanted.
- [ ] **Apps with a minimum size larger than the element** (Firefox: 500 px
  wide) get clipped. Options: let the element grow, scale down, or show it
  as-is.

## Known quirks (not ours, or low priority)

- **Firefox's cursor sometimes lags one move** (new image with the previous
  hotspot). Happens with Firefox as a plain Ash window too.
- **Firefox gets no TILED states** (binds an older xdg-shell), so it keeps
  its client-side shadow; handled by the geometry offset.
- **Xvfb sometimes drops or delays synthetic input** (xdotool). Test helpers
  add a 1 px nudge; don't mistake it for an embedding bug. Seen again on
  2026-10-20: after a click, the next input event (a move, a key release)
  reaches Ash only with the one after it, on page content too.

## T3 shell test (2026-10-16)

- [x] **Mouse in the right panel on `:0`.** Root cause found on DRM, where it
  reproduced every time (`PHASE4_PROGRESS.md`, item 3): when an Exo window's
  frame sink id equals the page's (e.g. (0, 3) and (6, 3)), viz's hit-test
  aggregator dropped the window's region in its cycle check before mapping it
  back to the browser-owned sink. Fixed in `hit_test_aggregator.cc`. Not
  re-checked on `:0` itself.
- [ ] **Ash crash (DCHECK_ALWAYS_ON)** in the user's `:0` session at 19:50:51Z (`logs/t3-shell.log` line 1975): `nine_patch_generator.cc:95 output_occlusion_.Contains(border_rect)`, border 964x856 vs occlusion 952x844, while drawing a window shadow. The cause is unknown; parked-window shadows are a suspect.
- [ ] **T3 page froze, then its renderer crashed (shell mode on `:0`, 2026-10-16 14:37 local).** Seconds after start, the page stopped presenting frames; presses still reached the page (`EXO-EMBED … here 0`). 12 s later the renderer hit `layer_tree_view.cc:554 callbacks.size() <= kMaxBufferSize (61 vs. 60)`: presentation callbacks queued with no presentation feedback, fatal only because DCHECKs are on. The cause of the stall is unknown, and an earlier freeze that day lost its log to the relaunch. A relaunch came up fine (about 177 frames/s). It froze and crashed again right after creating a session (01:41:42Z; Ash and the GPU process stayed fine, only the page died). The same check had fired before in a Phase 1 Xvfb run (`phase1-s.log`) and a TTY run, so it predates shell mode. Now:
  - both checks (`layer_tree_view.cc`, `presentation_time_callback_buffer.cc`) log `EXO-STALL` instead of crashing, so the page can recover;
  - `tools/freeze-probe.sh` (research repo) compares the page's own latest frame with what the X window shows, plus rAF rate and process states. Run it while frozen;
  - `plutonium run` keeps the previous Ash log as `logs/ash-<socket>.prev.log`.
  Not reproduced by clicking through DevTools (new thread → No project), which bypasses Ash's input path; the cause is still unknown.
- [x] **No `wl_pointer.leave`** when the pointer leaves an embedded window (seen with wev). The common cases already worked. A drag that ended outside the window got its leave only at the next move. Now it comes with the release (`chromium/patches/0029`, CONTROLS.md).

## Shipping

- [x] **Reproducible setup:** this repository. The Chromium and T3 patch series
  apply to pinned upstream commits; the container, CLI and install guide are here.
- [x] **A release build and a prebuilt image** (`ghcr.io/elsargo/plutonium`),
  so users needn't build Chromium.
- [ ] **Build and push the image from CI** (GitHub Actions can't build Chromium
  in its time limits on free runners; a self-hosted runner could). M
- [ ] **Start from a display manager** (a Wayland session entry that runs
  `plutonium run`), instead of a logged-in text console. M
- [x] **A license:** MIT.
