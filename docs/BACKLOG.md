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
- [ ] **One client's failing buffers stall the whole display.** M · Phase 1
  gtk4-demo (Vulkan, dmabuf) on Xvfb: buffers can't be imported (no native
  pixmaps), the GPU process logs ~80k shared-image failures and stops
  presenting for everyone. (The trigger is gone since GPU_X11.md: Xvfb
  sessions import dmabufs now and gtk4-demo runs. The missing guard stays.) Exo should reject or drop a buffer that fails to
  import (and tell the client), not keep retrying. The `EXO-DIAG` error
  logging from the viability work may make it worse; demote it.
- [ ] **Modal dialogs: page shows the wrong window as focused.** S · Phase 1
  While a GTK modal dialog is open, keys go to the dialog but the parent's
  element still reports `windowFocused`. Embedded focus should follow the
  client's own redirection (or the page should be told).

## Security and broker (Phase 2 follow-ups)

Done in Phase 2: window broker and grants, grant-checked embedding and input,
shell-only broker API (`--plutonium-shell-origin`), push events instead of the
JSON registry, viz hit-test rewrite limited to browser-linked children.

- [ ] **Unit and browser tests for the broker and grant checks.** M · Phase 2
  Everything was verified by hand on Xvfb (`phase2-grant-checks.js` in the research repo).
  Cover `ExoWindowBroker` grants/revocation, `IsShellDocument`, attach
  refusals and the input router's `IsForeignFrameSinkEmbeddedHere`.
- [ ] **Exercise the untested shell-exclusion cases live.** S · Phase 2
  Popup / `window.open()` from the shell, `<webview>`/guest at the shell
  origin, prerendered shell, cross-site iframes, same-RFH cross-document
  grant reuse, and a compromised renderer calling `Focus`/`SetSize` without
  attaching. All are excluded by construction; none were run.
- [ ] **Forward `OnGrantRevoked` to the shell.** S · Phase 2
  Only the element's `windowclose` reports revocation today.
- [ ] **Unsubscribe from broker events when the last listener goes.** S
- [ ] **`NativeWindowEvent` script constructor.** S
- [ ] **Allow an isolated web app origin as the shell** (widen the
  `--plutonium-shell-origin` scheme check) when the real shell is ported. S · Phase 5

## Shell substrate on DRM (Phase 3)

- [x] **Boot straight into the shell.** Done (`PHASE4_PROGRESS.md`):
  `--plutonium-shell-url` opens the page as the only, fullscreen window, with
  Ash in kiosk app mode; `plutonium run` boots it on DRM. Verified on
  the panel (tty2, 2026-10-16).
- [ ] **Autostart at power-on.** Today the session starts from a logged-in VT.
  Getty autologin plus a unit that runs the launcher. S
- [ ] **Hotplugged input devices are ignored in the container.** Devices that
  appear after Ash starts are never opened: in the rootless container libudev
  drops the host's udev events (sender uid isn't 0 in the user namespace;
  inferred). Needs Ash outside the user namespace or a udev relay. M
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
- [ ] **A way out of a DRM session other than the kill switch** (sign-out is
  blocked in app mode). S
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
- [ ] **Bridge: driving windows.** M · Agents can list, launch, snapshot,
  focus and close, but not type or click into a window.
- [ ] **Bridge: MCP for Codex and other T3 providers.** S · Only Claude
  sessions get the helper's MCP server.
- [ ] **Bridge: the page learns the helper's URL by convention** (port 3780,
  or `?helper=` / `?plutoniumHelper=`). S · Could come from the launcher or
  the browser.
- [ ] **Helper: no tests.** M · Unit tests for the resolver, relay and
  thread scoping; an end-to-end run against a fake shell.
- [ ] **Helper restarts forget thread X displays.** S · Processes started
  before keep a dead `DISPLAY`. Persist the mapping, or re-adopt live
  satellites.

## App compatibility and features (Phase 5)

- [x] **Port the real shell web app** onto `<native-window>` and the broker.
  Done twice: T3 Code (`T3_SHELL_TEST.md`) and the plain shell (`shells/plain/`).
- [x] **Browser tabs as elements.** Real pages as SurfaceEmbed `<embed>`s,
  tagged with threads, driven through the broker and the agent bridge
  (`features/TABS.md`). Tested in the plain shell on Xvfb and on DRM.
- [x] **Tabs in T3 Code.** T3's Browser panel and agent automation run on
  Plutonium's tabs (`features/TABS.md`, "In T3 Code"), on Xvfb and DRM.
- [ ] **T3 browser features still missing.** M · Zoom, color scheme, mute,
  element picker, screenshots to file, recording, PiP windows, DevTools
  window, console/network entries in snapshots.
- [x] **Touchpad on DRM.** Through libinput (`use_libinput`), with scrolling
  into native windows fixed (`NIRI_SHELL.md`, "Scrolling in apps").
- [ ] **Browser features tabs lack** (no `Browser` behind them). M–L ·
  Shortcuts, find-in-page, printing, zoom, permission prompts, downloads,
  file pickers, autofill/passwords, fullscreen; the context menu's
  navigation items. Attach tab helpers, or host tabs in a hidden `Browser`
  (which would also allow popping a tab out to a normal window).
- [ ] **Tabs don't survive a browser restart.** M · Session restore.
- [x] **Drag and drop** between native apps, tabs and pages
  (`DRAG_AND_DROP.md`). Tested on DRM in the niri shell.
- [ ] **Clipboard** between page content and native apps
  (`wl_data_device.set_selection`). Untested. M · Phase 5
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
- [ ] **Accessibility, multi-monitor, HiDPI polish.** L · Phase 5
- [ ] **Packaging:** reproducible build that runs on NixOS outside the dev
  container. L · Phase 5

## Several shells (`SHELLS.md`)

- [x] **Several live shells, Super+Tab** (step 1). Shared windows and tabs,
  the visible shell drives them.
- [x] **Tags and group labels** (step 2). M–L · Namespaced tags on windows
  and tabs, a group table (tag → label, owner), agent access by tag,
  helper routing to the owning shell.
- [x] **Native overlay** (step 3). L · Ash views: shells (switch, add, edit,
  turn off, reload), every window and tab by group, search, actions.
  Replaces Super+Tab cycling. The helper must learn shells added at runtime.
- [x] **Frontends** (step 4). M · T3 and the plain shell register threads,
  tag what they open, show an "Elsewhere" area with import.

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
  add a 1 px nudge; don't mistake it for an embedding bug.

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
- [ ] **No `wl_pointer.leave`** when the pointer leaves an embedded window (seen with wev).

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
