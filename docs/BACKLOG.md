# Backlog

Everything known to be not done yet. Roadmap phases refer to
[OPTION2_PLAN.md](history/OPTION2_PLAN.md); Phase 1 details are in
[PHASE1_REPORT.md](history/PHASE1_REPORT.md).

Phase 2 details are in [PHASE2_REPORT.md](history/PHASE2_REPORT.md), Phase 3 in
[PHASE3_REPORT.md](history/PHASE3_REPORT.md).

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
- [x] **Autostart at power-on.** S · A display manager's automatic login
  with the session entry below, or getty autologin and `plutonium session
  start` from the login shell (INSTALL.md, "From the login screen"). Not yet
  tried on the panel.
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
- [x] **Shell mode locks every browser window in fullscreen**, not just the
  shell's (as kiosk does). Scope it to the shell window if needed. S · Done
  2026-10-27 (`features/CHROME_UI.md`, "Fullscreen"): only the shells'
  windows are held fullscreen without exit UI; other windows behave as usual.
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
- [x] **Pixel-snap `<native-window>`.** Elements at fractional device positions
  can't be promoted to planes (DRM takes whole-pixel rects). S · Done
  2026-10-26 (patch 0058, `WINDOW_SIZING.md`): the surface layer goes at whole
  device pixels on screen; verified on Xvfb (crisp under a fractional
  `translate()`), planes not yet checked on DRM.
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
- [x] **Agents had to guess program names for `launch_app`.** `find_apps`
  lists the launcher's apps with an argv for `launch_app`, where each is
  installed from, and matching programs on PATH; a program not on PATH
  points to it (`features/AGENT_CONTROL.md`, "Finding apps").
- [x] **`find_apps` shows one install per desktop id.** S · Every install
  is listed; one the launcher doesn't show names the one it does
  (`launcherShows`). Apps with no desktop file still show only as programs
  on PATH (`features/AGENT_CONTROL.md`, "Finding apps").
- [x] **A Flatpak's window never reaches its thread.** S · Ash can't read a
  sandboxed client's environment (another user namespace), so the window
  comes untagged, and the helper's pid fallback ran only when there was no
  tag list at all. The helper now gives an untagged window to the thread
  that started its client, and logs launches and each new window's
  attribution (`features/AGENT_CONTROL.md`, "Which windows are a thread's").
  The live run's window was never seen in a log, so whether it was mapped
  isn't known: the next run's helper log says.
- [x] **The browser can't name an untagged window's origin itself.** S · The
  tag the helper finds by pid is used by the helper only. The shells' panels
  rely on a shell calling `setWindowOriginTag`. A DevTools command
  (`Plutonium.setWindowOriginTag`) would let the helper name it once for all.
  Done 2026-10-27 (`features/SHELLS.md`): the helper calls it as the window
  arrives.
- [ ] **One LibreOffice for every thread.** M · A second start of the
  Flatpak LibreOffice hands its arguments to whichever instance owns
  `org.libreoffice.LibreOfficeIpc0` on the session bus, in any session, and
  exits 0. The window opens in that instance's session and thread. If the
  owner doesn't answer, the new one waits on D-Bus with no window (seen
  2026-10-24 between test slots). `-env:UserInstallation` doesn't separate
  them; a private session bus does. `launch_app` could say who has it, or
  give each thread's LibreOffice its own bus.
- [x] **`read_window` crashed LibreOffice Calc.** S · `GetAll` on an
  element includes `Locale`, which aborts Calc on its defunct cell and input
  line objects. The reader skips defunct elements and never asks for
  `Locale`. A sheet's visible cells are listed, and an app that doesn't
  answer stops the read with a message that says whether it's still
  running (`features/AGENT_CONTROL.md`, "Accessibility").
- [x] **`read_window`/`act_window` follow-ups from the Calc runs.** S ·
  A Flatpak's untitled windows are found (its a11y connection is its
  sandbox proxy's), with points that leave out a GTK frame's shadow;
  `select` on a cell of a GTK 3 list of several columns selects its row,
  else clicks it; a stale ref says it's gone; Calc lost the second of two
  Tabs, so typing pauses after Tab and Enter (`features/AGENT_CONTROL.md`).
- [x] **Action results could name new windows.** S · Window actions return
  the windows that opened or closed since the agent last heard
  (`new window #9 ("Character", 982×615)`) and the window's open menus
  (`features/AGENT_CONTROL.md`, "Popups").
- [x] **`launch_app` returned no windows when its first one closed.** S ·
  The wait ended at the first window: a splash or recovery dialog gone by
  then gave `[]`. It now waits for the windows to settle.
- [x] **Tab recordings on NixOS.** M · `preview_recording_start` needed T3's
  downloaded headless shell, which NixOS can't run. The encoder now runs in a
  hidden page of Plutonium's browser (`features/AGENT_CONTROL.md`).
- [ ] **T3's headless shell on NixOS.** S · Without a Plutonium helper (T3
  Code alone), headless tabs and recordings still launch T3's download, which
  NixOS refuses; the agent now gets NixOS's message. Point Playwright at a
  Chromium that runs here (the way Plutonium finds its own) if that case
  matters.
- [x] **Idle agent tabs a shell shows.** S · The idle sweep and
  `latestThreadTab` count a shell showing the tab (`embedded`).
- [x] **The floating preview doesn't follow the tab an agent drives.** S ·
  It switches to the tab whose cursor the agent moves.
- [x] **Nothing marks a private tab as private.** S · A mask in its panel
  tab, a "Private" badge in the floating preview.
- [x] **A hidden background embed may count as `visible`.** S · Checked: an
  agent's actions make none (`preview_open {open:false}`, actions, then
  `preview_status`: `visible:false`). Only a recording the user starts in
  the panel embeds a tab nobody looks at, and counts as `visible` while it
  runs.
- [x] **A path drag on a hidden tab times out.** S · On a tab no page shows
  (`preview_open {open:false}`), `preview_drag` with a path timed out after
  15 s while `preview_press` and `preview_click` worked; the same drag on
  the tab shown worked (X11 test session, 2026-10-26). Done 2026-10-27: T3
  waits for each 8 px move to reach the page, which takes the tab's next
  frame, and a hidden tab hardly draws (5 s a move here). The helper keeps a
  server tab awake from its first `Input.*` until 60 s without one, as the
  agents' relay does (`AGENT_CONTROL.md`, "Tabs").
- [x] **`preview_press` and `preview_drag` say nothing back.** S · They
  return `done` ("Pressed Tab.").
- [x] **Calc test runs start in crash recovery.** S · `run.sh` kills the
  tester's LibreOffice with unsaved documents, and the recovery list is in the
  user's own Flatpak profile. `run.sh` now drops the entries a run added
  (`tools/agent-tests/lo-recovery.py`). A recovered window has come back at
  1×28 px twice; why isn't known.
- [x] **Tab recordings have no duration.** S · The server writes the length
  into the header (WebM Duration; MP4 mvhd/tkhd/mdhd/mehd): ffprobe gave
  17.02 s for a 17.3 s MP4 recording.
- [x] **`preview_evaluate` isn't in a snapshot's `actionTimeline`.** S ·
  It is now.
- [x] **`preview_navigate` lists itself as busy.** S · Its status leaves
  out the running navigate.
- [x] **A snapshot's `[active]` means focused; nothing says so.** S · It
  reads `[focused]`, and `preview_snapshot`'s description says so.
- [ ] **Agent tool paths no run has reached yet.** S · Scenarios to write: a
  stuck action (a long drag while the session's display is paused); the side
  panel open on a resized tab (its cursor, the narrow viewport); in Calc, a
  menu and a hover with the window shown and hidden, `act_window` `select` on
  the chart type list, the untitled "discard?" box, and a stale ref.
- [x] **Agents drawing in tabs** (`excalidraw-cloud` run 2026-10-24).
  `preview_drag` drags along a path of points; snapshot images are in click
  coordinates on desktop tabs without flashing on screen; the panel's and the
  floating preview's cursor follow a resized tab; `preview_resize` answers
  with the new size
  (`features/AGENT_CONTROL.md`, "In T3 Code").
- [ ] **Agent input while the display is off.** M · When logind pauses
  the session (VT switch), Ash stops presenting, so tabs stop drawing.
  Mouse moves then never reach the page, because it takes them with its
  next frame. The tools now fail within 5 s and don't wedge the tab
  (`features/AGENT_CONTROL.md`). Making the input go through would need
  Ash to keep producing frames (or acking presentation) while paused.
  Seen in run `20261024-145112-excalidraw-spiral-sized` (`EXO-STALL`).
- [x] **Incognito agent tabs on the desktop.** `profileId: "incognito"`
  was ignored for desktop-rendered tabs (shared storage). Now a throwaway
  off-the-record profile per tab (Chromium patch 0045).
- [ ] **The panel's cursor and desktop zoom.** S · Plutonium's preview bridge
  reports `zoomFactor: 1`, so a zoomed desktop tab would place the agent's
  cursor off by the zoom. Not seen yet.
- [x] **Agents and popups.** M · Window snapshots draw the window's open
  menus (and say where they are); agent clicks and hovers reach them, and a
  press outside closes them (patch 0060; `features/AGENT_CONTROL.md`,
  "Popups").
- [x] **Popups of windows no panel shows covered the shell.** An agent's
  menus and tooltips showed over the shell (and other threads) while no
  page showed the window. Now they show only at the element showing the
  window (`WINDOW_SIZING.md`, "Popups").
- [ ] **Agent typing beyond a US layout.** S · Map text through the
  session's keymap (xkb) instead of assuming US keycodes. Characters the
  layout lacks need the temporary keymap that password auto-type needs too
  (`PASSWORDS.md`, "Native windows"); build it once for both.
- [ ] **Usage-limit warnings in `orchestrator_capabilities`.** S · Agents
  choosing a provider instance for a new thread or child task can't see
  which ones are close to their limits. T3 already tracks session and weekly
  usage per Claude instance (`provider/claudeUsageLimits.ts`), but only the
  UI gets it. Add a warning field to each instance in the list (e.g. near or
  at a limit, and when it resets), not the full usage data. Asked for
  2026-10-23.
- [x] **Bridge: the page learns the helper's URL by convention** (port 3780,
  or `?helper=` / `?plutoniumHelper=`). S · Could come from the launcher or
  the browser. Done 2026-10-27 (`features/BROKER.md`): the browser hands a
  shell the launcher's `--plutonium-helper-url` (`windowBroker.getHelperUrl()`);
  the bundled shells use it when the URL has no `?helper=`. T3's web app still
  reads `?plutoniumHelper=`.
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

- [x] **Web pages should see generic Linux Chromium, not ChromeOS.** S ·
  High priority: some sites already break. The user wants no ChromeOS
  fingerprint (`ARCHITECTURE.md`, "ChromeOS is an implementation detail").
  In `components/embedder_support/user_agent_utils.cc`, the `IS_CHROMEOS`
  branches give:
  - the user agent `X11; CrOS x86_64 14541.0.0` (`GetUnifiedPlatform()`,
    and `BuildOSCpuInfoFromOSVersionAndCpuType()`);
  - `Sec-CH-UA-Platform` / `userAgentData.platform` `"Chromium OS"`
    (`GetPlatformForUAMetadata()`);
  - a non-empty `platformVersion` (`GetPlatformVersion()`).

  Linux gives `X11; Linux x86_64`, `"Linux"` and `""`. `navigator.platform`
  is already `Linux x86_64`. Then compare the remaining fingerprint with
  Linux Chromium on the same machine, using a fingerprinting test page:
  ChromeOS-only web APIs, fonts and WebGL strings. Done 2026-10-26 (patch
  0055, `LINUX_COMPAT.md`): verified on Xvfb, a tab sees `X11; Linux x86_64`,
  `userAgentData.platform` `"Linux"`, `platformVersion` `""`.
- [x] **Audit what still behaves like ChromeOS.** S–M · Grep the patched
  tree for `IS_CHROMEOS` / `IS_LINUX` gates in the areas we use: media and
  WebRTC (`rtc_use_pipewire`), printing (Linux's CUPS backend instead of
  Ash's printer manager), IME, notifications, branding strings, web APIs.
  Turn what we find into items here, each saying whether to switch on the
  Linux path or patch the ChromeOS one out. Done 2026-10-25
  (`LINUX_COMPAT.md`): a Plutonium tab against Linux Chromium; the timezone,
  languages and ChromeOS-only web APIs fixed, the rest below.
- [x] **H.264 and AAC in tabs.** M (a big rebuild) · High priority: no
  proprietary codecs, so `canPlayType` says no to `avc1` and `mp4a`.
  `proprietary_codecs = true` and `ffmpeg_branding = "Chrome"` in
  `chromium/args.gn` (and the release args), as nixpkgs' Chromium.
  Done 2026-10-26 (`LINUX_COMPAT.md`): verified on Xvfb, an H.264/AAC mp4
  plays in a tab.
- [x] **Pages use the host's fonts.** S–M · Ash in the container renders
  with its 135 fonts (DejaVu Sans), not the host's (Noto Sans and the
  user's). Mount the host's font directories and fontconfig into the
  container, or wait for Ash on the host. Done 2026-10-27 (`LINUX_COMPAT.md`):
  the host's `/etc/fonts` and font dirs mounted by `container create`, the
  user's fonts through the session's `FONTCONFIG_FILE`; existing containers
  need making again.
- [x] **Web notifications from tabs.** M · A granted `new Notification()`
  goes to Ash's message center, which shell mode blocks, so nothing shows.
  Hand them to the shell (a tab request kind) or to the desktop's
  `org.freedesktop.Notifications` through the helper, as Linux Chromium.
  Done 2026-10-27 (`DESKTOP_SERVICES.md`): the Plutonium domain lists the
  message center's web notifications; the helper's notifications service
  shows them (the site as app), a click runs the page's handler and shows its
  tab.
- [ ] **Tabs' media sessions over MPRIS.** M · Linux Chromium exposes a
  page's media session on D-Bus for media keys and desktop widgets; ours go
  to Ash's media controls.
- [ ] **Speech synthesis voices.** S–M · `speechSynthesis.getVoices()` is
  empty (ChromeOS's voices are TTS extensions); Linux Chromium uses
  speech-dispatcher.
- [x] **Dark mode from the host.** S · `prefers-color-scheme` follows Ash's
  setting, not the desktop's (the portal's `color-scheme`). Done 2026-10-27
  (`LINUX_COMPAT.md`): the portal's setting, else GNOME's dconf key, watched
  and set as Ash's dark mode.
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
- [x] **Shells use `windowrequest` move/resize.** M · An app's title-bar drag
  or edge resize could become niri's interactive move or column resize. The
  page would need the pointer for the rest of the drag. Done 2026-10-26
  (`WINDOW_SIZING.md`, patch 0057): the browser hands the rest of the drag to
  the page; niri's move verified on X11 with two displays. Plain ignores both.
- [ ] **CSD edge resize in shells.** S–M · GTK 4's resize edges are in its
  shadow, outside the geometry, where `<native-window>` clips the surface, so
  they never get a press. Let presses within a few pixels outside the
  content box reach the app (floating windows), or tell apps they're tiled.
- [x] **Cross-fade on the compositor thread.** S · The old frame's opacity is
  stepped from the main thread each frame; a busy shell page makes it stutter.
  A cc opacity animation on its effect node (as LinkHighlightImpl does) would
  not. Done 2026-10-27 (`features/WINDOW_SIZING.md`, "Cross-fade").
- [ ] **T3 browser features still missing.** M · The panel's zoom buttons
  (zoom itself works, `TAB_FEATURES.md`), color scheme, mute,
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
- [x] **Tabs don't survive a browser restart.** M · Session restore.
  Done 2026-10-26 (patch 0056, `TABS.md`, "Surviving a restart"): addresses
  and tags, through a clean stop and a kill -9; not history. Also
  what "close and reopen on wake" for a snoozed thread needs (the T3
  sidebar item).
- [x] **Drag and drop** between native apps, tabs and pages
  (`DRAG_AND_DROP.md`). Tested on DRM in the niri shell.
- [x] **Clipboard** between page content and native apps
  (`wl_data_device.set_selection`). Works in daily use (the user,
  2026-10-20); an automated check in both directions is part of the DRM
  verification pass. The primary selection (middle-click paste) isn't a
  requirement.
- [x] **text-input-v3 (IME for GTK 4, Qt, foot).** Done (patch 0061,
  `features/IME.md`). foot and gtk4-demo bind it, get enter/leave and
  enable, and take pre-edit and commits. Qt 6 is untested.
- [x] **Test real IME composition.** Done on Xvfb with a test extension IME
  (`tools/ime-test.sh`). It showed that no IME text had ever reached an
  embedded window, over v1 or v3 (fixed in 0062), and that keys an IME passes
  on were dropped (fixed in 0065).
- [ ] **Choosing an input method.** M · Phase 5
  Shell mode has no IME menu or language settings, so a user can't pick or
  install an IME. That needs shell UI over `inputMethodPrivate`, or the
  settings page (`features/IME.md`, "What's missing").
- [ ] **Other missing Wayland protocols** as apps need them:
  `xdg_toplevel_icon`, explicit sync, `ext_data_control`. M each · Phase 5
  `xdg_activation_v1` and `wp_cursor_shape_v1` are done (0063, 0064,
  `features/WAYLAND_PROTOCOLS.md`).
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
  Notification, Inhibit, Print, Account, Access and Background.
  FileChooser and Print are built (below, "The FileChooser portal on the
  same picker", "The Print portal on the same dialog"); FileChooser's dialog opens over the app's window, found by the request's
  pid (the parent window handle, an XID or an xdg-foreign handle, isn't
  mapped to Exo windows).
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

- [x] **Tab request plumbing, and zoom.** S–M · `plutonium_tab_requests`
  (one request, answer and fallback path, generalising the context menu's),
  `pending` on `BrowserTabEntry`, the new `tabCommand`s and keys, the
  library's `connect()` options and dialog styles. Zoom: `ZoomController`,
  `ContentsZoomChange`, `BrowserTabEntry.zoom`, `setTabZoom`; T3's zoom.
  Done (2026-10-23): see `TAB_FEATURES.md`, "As built" and Zoom. T3 has zoom
  through the keys, the wheel and the toast; its panel's own zoom controls
  are still ignored (its bridge, patch 0012).
- [x] **File pickers for tabs.** L · `RunFileChooser` through
  `FileSelectHelper`, and a `SelectFileDialog` factory that sends registry
  tabs' pickers (inputs, File System Access, Save As) to the shell as
  `filechooserrequest`. The library's picker over the helper's file listing.
  Container sessions mount the user's home at the same path until Ash runs
  outside the container (decided). Done 2026-10-23 (`TAB_FEATURES.md`,
  "File pickers"). Pickers from hidden tabs are cancelled by content, as in
  Chrome; the user is fine with that (2026-10-24).
- [x] **Permission prompts for tabs.** M–L · `PermissionRequestManager`,
  `PageSpecificContentSettings`, the media delegate methods (`getUserMedia`
  fails in tabs today), `permissionrequest`/`answerPermission`, devices in
  use on the tab. Fallback when no shell takes it: dismiss, and
  mark the request blocked on the tab.
  Done 2026-10-23 (TAB_FEATURES.md, "Permission prompts", "As built"): a
  `permission` tab request with the library's prompt, `blocked` and
  `inUse` on the tab, `answer_permission` for agents (deny or dismiss
  only), and the File System Access write prompt. Not done: geolocation in
  `inUse`, and the restore-permissions bubble.
- [x] **Per-thread permission grants.** M · Scopes once, this thread and
  everywhere; a (thread, origin, permission) store and a check in
  `PermissionContextBase`. Default "this thread". Grants survive settling and go on archive or
  delete. Agents can deny; to grant they ask the user (also
  `Browser.grantPermissions`).
  Done 2026-10-23 (same section): grants live in local state, and
  `request_permission` and `grantPermissions` ask the user. Grants go when
  a shell calls `forgetThreadPermissions(thread)` (broker
  `permissionCommand`). T3's side is its own item below.
- [x] **Downloads in threads.** M · A download observer that records the
  tab's thread, `download*` events to every shell, `downloadCommand`, open
  and show through the helper in the thread's environment, closing the empty
  tab a download leaves. Files go to `~/Downloads` by default, with options
  for a `.downloads` in the thread's working directory or
  `~/Downloads/<thread>/`.
  `list_downloads` for agents. (Done 2026-10-23, patch "downloads for the
  shells' tabs"; `TAB_FEATURES.md`, "Downloads".)
- [x] **Playwright's download events in the relays.** S–M · Pass
  `Browser.downloadWillBegin` and `downloadProgress` for a relayed tab's
  downloads (from `Plutonium.downloadAdded/Changed`), and link the finished
  file where `setDownloadBehavior` asked for it (`<downloadPath>/<guid>`), so
  `waitForEvent("download")` and `download.path()` work. Done 2026-10-27
  (`helper/src/relayDownloads.ts`; `TAB_FEATURES.md`, "Downloads", "Agents").
- [x] **Find in page.** S–M · `FindTabHelper`, `findrequest`, `find`,
  `stopFind`, `findresult`, and the library's find bar.
- [x] **Printing from tabs.** M–L · `PrintViewManager`, `printrequest`,
  `printToPdf` for the shell's preview, host printers and jobs through the
  helper (CUPS); agents may print. Chrome's preview over the shell's window as the fallback.
  Done 2026-10-24 (`TAB_FEATURES.md`, "Printing", "As built").
- [x] **Printing: Save as PDF through the file picker.** S · The print
  dialog still has a path field (`~/Downloads/<title>.pdf`); the picker now
  exists (`fileChooser`, `save` mode). Done 2026-10-27 (`TAB_FEATURES.md`,
  "Printing", "As built", "Library").
- [ ] **T3 Code's agents get the tab tools.** S–M · T3 gives its agents only
  the helper's window tools (`WINDOW_TOOLS`), so `print_tab`, `choose_files`,
  `answer_permission`, `request_permission`, `list_downloads` and
  `find_in_tab` don't reach them (T3 repo).
- [ ] **T3 Code forgets a thread's permission grants on archive and delete**
  (`shell.forgetThreadPermissions(thread)`). S · T3 repo. Also
  `grantPermissions` from the frontend server's relay (`serverTabs.ts`),
  which still acknowledges it without asking.
- [ ] **Camera request in tabs still not right** (low priority). S–M · In
  the 2026-10-24 retest, after the container got the cameras, everything
  else passed but the camera's dialog still wasn't right. Ask the user what
  they saw (the shell's prompt, Chrome's own, or no picture), then fix.
- [ ] **Hands-on checks for the tab features.** S · What the workers
  couldn't test, part of the DRM verification pass:
  - find: F3 and Shift+F3 on a real keyboard;
  - permissions: a real camera and microphone (the container had no
    `/dev/video*` until 2026-10-24); the prompt's look in niri and T3;
  - downloads: open and show on a file in `~/Downloads` in a container
    session (needs the recreated container); keep and discard on a file
    Chrome flags as dangerous;
  - printing: a real printer through CUPS (two-sided, black and white);
    printing on DRM.
- [x] **The FileChooser portal on the same picker.** M · Built
  2026-10-26 (`TAB_FEATURES.md`, "One picker with the FileChooser
  portal"): OpenFile, SaveFile and SaveFiles on the library's picker, over
  the app's window. Left: a Flatpak app through the document portal, checked
  on a real session (the frontend exports the URIs itself; not tried on the
  private test bus, which would start a second document portal on the
  user's `$XDG_RUNTIME_DIR/doc`).
- [x] **The Print portal on the same dialog.** M · Built 2026-10-26
  (`TAB_FEATURES.md`, "The Print portal"): `printportal.py` serves it,
  since the document comes as an fd Node can't receive; the library's
  print dialog without a preview, then CUPS or Save as PDF. Left: a real
  printer, a Qt app and a Flatpak app, checked on a real session.
- [ ] **Form autofill in tabs.** S–M to L · Not now (decided 2026-10-23).
  Later: identities and cards through the password adapter.

## Capture and sharing (`CAPTURE.md`)

In order. The design and the decisions behind it are in `features/CAPTURE.md`.

- [x] **Shell capture API and screenshots.** M · `shell.capture()` →
  MediaStream and `shell.screenshot()` → PNG for outputs, windows, tabs and
  regions, on the snapshot and capturer code from patches 0005 and 0007.
  niri's Print key with a region/window selector, saving to
  `~/Pictures/Screenshots`. The global recording and screenshot switches, enforced in
  Ash. Copying to the clipboard waits on the clipboard item. Done
  (`features/CAPTURE.md`, "How it's built"); a shell's MediaStream of a
  window only covers what fits on the screen (PipeWire captures don't).
- [x] **Capture requests to the focused shell; events to every shell.** M ·
  `capturerequest`/`answerCapture`, `capturestart`/`capturestop`,
  `stopCapture`. Ash's fallback picker, and its own indicator when the
  focused shell doesn't acknowledge a capture.
- [x] **Resizing a window for capture.** M · A capture size that overrides the
  element's in `configure`. The element shows the frame with `object-fit`, and
  the stream letterboxes when the app picks another size. Check that a parked
  window gets steady frame callbacks while it's captured.
- [x] **PipeWire output from Ash.** L · A producer of our own (WebRTC's
  `rtc_use_pipewire` is off for `target_os = "chromeos"`, and its code is
  consumer-only): dmabuf with modifiers, a shared-memory fallback, the three cursor
  modes. libpipewire in the container image. Done with shared memory (dmabuf
  below); a window's frames are its own copies, so it can be parked, off the
  screen, or bigger than it.
- [x] **Portal backend in the helper.** L · `impl.portal.ScreenCast` and
  `Screenshot`, `plutonium.portal`, `plutonium-portals.conf`,
  `XDG_CURRENT_DESKTOP=Plutonium`, restore tokens that name stable things.
  Test with OBS and native Discord. Done and checked with a real portal
  client (`tools/portal-screencast.py`); OBS and Discord themselves not yet.
- [x] **`ELECTRON_OZONE_PLATFORM_HINT=wayland` in the thread environment.** S ·
  The XWayland Discord can't share a screen: its rootless Xwayland holds
  only its own windows. With `XDG_SESSION_TYPE=wayland`, which Electron 38+
  goes by instead; the helper resolves the apps it launched by pid, as
  Electron 43 blanks its environ.
- [x] **GlobalShortcuts portal.** M · The helper answers it; the focused shell
  binds keys through `setShellShortcuts`. Discord push-to-talk, OBS hotkeys.
- [ ] **`ext-idle-notify-v1` in Exo.** S–M · Exo has `zwp_idle_inhibit` only.
  Discord's away status.
- [x] **getDisplayMedia from tabs through the shell picker.** M · Replace
  Ash's `DesktopMediaPicker` with `capturerequest`.
- [ ] **Agent recording over MCP.** M · Records the agent's own thread's items to a file, with no
  dialogs. It goes to every shell as `capturestart` and honours the global switch.
- [ ] **Discord screen-share audio.** S to test, M to fix · If Discord wants a
  per-app node, publish one from the shared window's pid (as venmic does).
- [ ] **dmabuf for Ash's PipeWire nodes.** M · Built (linear GBM buffers written
  through their mapping, shared memory after); not yet tried with a consumer
  that takes dmabufs (OBS). Still a CPU copy per frame: no copy at all needs
  buffers Ash allocates and the capturer renders into, rather than viz's pool.
- [x] **A shell's MediaStream of a window bigger than the screen.** S–M ·
  From the window's own frame sink (patch 0054), not a subtree of the
  screen's frame. A parked window that nothing shows still gives no frames;
  PipeWire captures cover that.
- [x] **The portal's `PickColor`.** S · The focused shell's picker over a frozen screen.
- [x] **`ext-image-copy-capture-v1` in Exo,** for grim (wf-recorder only speaks
  wlr-screencopy). M · Output sources, shared memory.
- [ ] **dmabufs for `ext-image-copy-capture-v1`.** M · wl-screenrec takes only
  dmabufs, and allocates them from its VAAPI encoder with the GPU's tiled
  modifier whatever modifiers are offered (an AMD one, seen on X11), so a CPU
  copy can't fill them: it needs a GPU copy (a CopyOutputRequest blitted into
  the buffer's shared image).

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
- [x] **Switcher: app icons** in the window list and the launcher (the helper
  serves them; SVG needs decoding in the browser process). Done 2026-10-27
  (`SHELLS.md`): decoded in a background WebContents; windows by app id.
- [x] **Switcher on DRM**: verify it there (only Xvfb so far). Done 2026-10-26
  (`SHELLS.md`): works; its text field colour, hover and the backup window's
  stacking fixed after it.
- [x] **Frontends** (step 4). M · T3 and the plain shell register threads,
  tag what they open, show an "Elsewhere" area with import.
- [x] **Shells as installed packages** (`SHELL_PACKAGES.md`). L · Shipped
  shells installed in `~/.pluto/shells/<name>` as git repositories with a
  `shell.json`; static ones served by the helper on `<name>.localhost`,
  servers (T3 Code) run and supervised by the helper; `shells.json` follows
  the switcher; `plutonium shells install|update|list`; Customize (an agent
  or a terminal in the folder), edits committed and rolled back when the
  shell doesn't come up; safe mode; adding from a folder, git or an address.
- [x] **Installed shells: check the switcher's parts in a session** (Customize,
  server controls, a rolled back change's notice, Add a shell turning one on).
  Done 2026-10-26 on Xvfb (`SHELL_PACKAGES.md`).
- [ ] **Installed shells on DRM**, and an agent's edit end to end.
- [x] **Installed shells: notices outside the switcher.** A rollback shows in
  the switcher's status line and the shell's page; the visible shell isn't
  told (a `shellnotice` event in the library for shells to show).
- [x] **Installed shells: a renderer crash** of a shell after an edit isn't
  noticed (only "no page connected in time"): watch the shell's contents
  over DevTools (`Inspector.targetCrashed`) and roll back. Both done
  2026-10-27 (`SHELL_PACKAGES.md`): `shellnotice` events and a notification;
  `Target.targetCrashed` rolls back an edit from the last five minutes. A crashed
  shell page that showed a tab took the browser down (fixed, patch 0073).
- [x] **Installed shells: agents.** Decided (2026-10-26): no "ask an agent"
  buttons. The switcher and the shells page copy a prompt that points the
  user's own agent at the Plutonium skill (`skill/SKILL.md`, written to
  `~/.pluto/SKILL.md`). New shell… / `plutonium shells new` make a shell
  from a copy.
- [ ] **Installed shells: the T3 checkout as part of the T3 shell.** Its
  manifest runs `plutonium t3 serve` from the checkout Plutonium runs from
  (`T3CODE_DIR`); a T3 install could live in the shell's folder instead.

## Several monitors (`MULTI_MONITOR.md`)

In order. A shell window per display, each with its own shell instances;
shells that want to span monitors run on each and sync themselves.

- [x] **Displays in the broker; a shell per display.** M–L · A display list
  and events, one shell window per display, a shell choice per display,
  Super+Tab and the switcher on the focused display, agent routing to the
  set of visible shells. Hotplug moves an unplugged display's windows to
  Elsewhere. Done 2026-10-25 (MULTI_MONITOR.md, "As built", "Verified"),
  verified on X11 with two host displays and on DRM with a second monitor.
- [x] **One window, one place.** M · Replaces "only the visible shell
  drives": the newest claim on a window wins and the loser gets
  `windowtaken`. Tabs already work this way. Done 2026-10-25 (same).
- [x] **Show on display N.** S · Routed like focus requests, for the
  switcher, shortcuts and agents. Done 2026-10-25: the switcher's "Show on
  display N", Super+Ctrl+Shift+Left/Right, `focus_window`/`focus_tab`
  `display`, `showOnDisplay()`.
- [x] **Drag windows between shells.** M · `application/x-plutonium-window`
  carrying the window id; the drop asks the broker to take it. Check that
  Ash's drag controller already carries ordinary data across displays.
  Built 2026-10-25 (the library's `startItemDrag`/`itemFromDrop`, niri and
  Plain take drops, Plain's apps and tabs drag). Verified across displays on
  DRM with a real second monitor (on X11 the drag is cancelled at the host
  window's edge).
- [ ] **Dragging a tile out of niri** to another shell or display. M · niri
  takes drops but its tiles move by pointer drags of its own (Super+drag,
  the overview), not HTML drag and drop; one leaving the page would have to
  turn into a `startItemDrag()`. Plain's list drags today.
- [ ] **Linked documents** (a shell's second display as a same-origin child
  document). Only if a shell needs shared in-page state; T3 shouldn't.

## Desktop services for shells

What users expect of any desktop, for every shell to use. The helper does the
work over the host's usual services (D-Bus, PipeWire) and the shell library
exposes it, so a shell is only UI. ChromeOS's own system tray needs ChromeOS
daemons (cras, shill) that aren't there. A shell names what it uses in
`shell.json` (`"uses": ["audio", "network", …]`); the switcher shows it, and
a shell gets only what it names. Each one lands with its section in the
skill (`skill/SKILL.md`) and a page in `docs/features/`, so agents building a
shell find it.

- [x] **The services API** (`shell.system.<service>`: state, `change` events,
  actions). Done 2026-10-26: `helper/src/services.ts`, the `/v1/shell/system`
  routes, `uses` in `shell.json`, `shell.system` in the library
  ([DESKTOP_SERVICES.md](features/DESKTOP_SERVICES.md)).
- [x] **Audio.** M · Output/input devices, volume and mute per device
  (PipeWire via `wpctl`, or PulseAudio's D-Bus), per-app streams later.
  Volume and mute keys work without a shell asking. Done 2026-10-26:
  `services/audio.ts` (pw-dump, wpctl), the keys through the helper, niri's
  bar and plain's tray. Per-app streams still to do.
- [x] **Brightness and power.** S–M · Backlight through logind
  (`SetBrightness`, no root), brightness keys; battery and AC from UPower;
  suspend, restart, power off, log out through logind. Done 2026-10-26:
  `services/power.ts`; log out is `plutonium stop` for the session. Not yet:
  the keyboard backlight, the power button, lid actions (idle: the session
  service below).
- [x] **Network.** M · NetworkManager over D-Bus: state, Wi-Fi list, connect
  (with a password prompt from the shell), turn Wi-Fi off; VPNs later. Done
  2026-10-26: `helper/src/services/network.ts`, a NetworkManager secret
  agent whose requests the visible shell asks (`systemrequest`), the
  indicators in niri and plain. Later: a new 802.1X network, hidden
  networks, VPN secrets.
- [x] **Bluetooth.** M · BlueZ over D-Bus: on/off, devices, pair and
  connect; pairing PINs through the shell. Done 2026-10-26:
  `helper/src/services/bluetooth.ts`, an agent for its own pairings, the
  indicators in niri and plain.
- [x] **Media.** S · MPRIS players (now playing, play/pause, next), and the
  media keys. Done 2026-10-26: `services/media.ts`; the browser's own media
  session through the Plutonium domain (no MPRIS in a ChromeOS build). Not
  yet: a tab's artwork, seeking.
- [x] **Notifications.** Done 2026-10-26: the helper as
  `org.freedesktop.Notifications`, `shell.system.notifications`, the
  library's popups in the visible shell. Open: check the popups in a session;
  tabs' web notifications (the item above) to go the same way.
- [x] **Lock screen and idle.** M · Idle time, a lock that no shell can skip
  (Ash's own, or a locked page), inhibit while video plays. Done 2026-10-26:
  Ash's lock over every display (Super+L), the password through
  `unix_chkpwd`, `services/session.ts` (idle screen off and lock, inhibitors
  from apps, the portal, the browser's wake locks and shells; logind's Lock
  and the lock before sleep), Lock in niri's and plain's power menu
  ([DESKTOP_SERVICES.md](features/DESKTOP_SERVICES.md#session)). Not yet:
  dimming before the screen goes off, a lock on the lid closing (logind
  suspends, which locks first), other accounts than `/etc/shadow`'s.
- [x] **A native side and storage for shells.** Done 2026-10-26:
  `"native"` in `shell.json` (a module the helper runs, `shell.native.call`,
  its events), `shell.storage` in `~/.pluto/data/<name>/`
  ([DESKTOP_SERVICES.md](features/DESKTOP_SERVICES.md#a-native-side-and-storage)).
  Later: `plutonium shells new --native` to start one from a template.

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
- [ ] **Rebuild and push the prebuilt image.** S (hours of build) · It lacks
  patches 0031–0042 (broker follow-ups, DRM on a background VT, all the tab
  features): `plutonium chromium build --release`, `image build`,
  `image push`. Then recreate `plutonium-prebuilt` (`podman rm -f`, then
  `plutonium container create`) so the live desktop gets the same-path home
  mount that file pickers and downloads rely on.
- [ ] **Build and push the image from CI** (GitHub Actions can't build Chromium
  in its time limits on free runners; a self-hosted runner could). M
- [x] **Start from a display manager.** M · `plutonium session install`
  writes `/usr/share/wayland-sessions/plutonium.desktop`, which runs
  `plutonium session start`: the container and the kill switch first, then
  `plutonium run` in the display manager's logind session, and back to the
  login screen when it ends, with why in the journal (`journalctl -t
  plutonium-session`). Checked with dry runs and a session that fails to
  start; not yet tried with a real display manager (GDM, SDDM).
- [ ] **A login screen entry for every user.** S · The entry runs one
  checkout's `bin/plutonium`, so it's for the user who installed it.
- [x] **A license:** MIT.
