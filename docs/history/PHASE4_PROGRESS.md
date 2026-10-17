# Phase 4 progress: shell substrate on DRM

Tracks Phase 4 of [OPTION2_PLAN.md](OPTION2_PLAN.md). Chromium changes are in `~/chromium/src` (branch `t3-shell-test`, uncommitted on top of `0fbff284ba`, build `out/Cros`), tagged `EXO-BOOT` (shell mode), `EXO-GPU` (display planes) and `EXO-DIAG` (diagnostic logs). The diff is in `patches/exo-phase4.patch` (against `0fbff284ba`, so it goes on top of `exo-phase3.patch`).

Status: ✅ done and verified · 🟡 built, partly verified · ⬜ not started

| # | Item | Status | Evidence / notes |
|---|------|--------|------------------|
| 1 | Boot straight into the shell: Ash on DRM, the frontend's page fullscreen, Ash's shelf, tray, desks and frames hidden | ✅ | The plain shell on the panel (2560×1600 @ 180 Hz, scale 1.78), started on tty2 (`shots/phase4-drm-boot.png`). There's no boot-time autostart yet: it's started from a logged-in VT |
| 2 | Embedding on the GPU path (dmabuf in the page, planes, the TTY report's open items) | ✅ | dmabuf apps render in the page. A fullscreen embedded window goes on a display plane (underlay at scale 1.78; no composite at all at scale 2). NV12 video goes on a plane. Three Chromium fixes, see below |
| 3 | Real input on the TTY (evdev) | ✅ with a caveat | Keyboard and mouse through Ozone's evdev path into the page and into embedded apps (foot, KCalc, its menu, pop out). Driven by virtual uinput devices, not by hand. Found and fixed the hit-test bug behind "mouse on `:0`" |

All of it ran unattended on tty2 (2026-10-16, 18:56–19:24), with the user logged in there and away. Screens were captured from KMS (`tools/kmsshot.sh`), plane use read from the kernel (`/sys/kernel/debug/dri/1/state`).

## Item 1: boot straight into the shell

### Shell mode (`--plutonium-shell-url=<url>`)

One switch turns Ash into a single-page desktop:

- **The page is the only window.** At startup, before the startup browser is created (`ChromeBrowserMainExtraPartsAsh::PreProfileInit`), the URL is opened as `--app=<url> --start-fullscreen`. That gives an app window (no tab strip or omnibox), with no session restore and no new-tab window.
- **Plain fullscreen, which it can't leave.** These checks treat shell mode like kiosk:
  - no immersive mode, so no frame slides down at the top edge (`BrowserFrameViewChromeOS`, `BrowserView`);
  - no "Press F11 to exit" bubble (`ExclusiveAccessManager`, `FullscreenController`);
  - no round exit button at the top edge (`FullscreenControlHost`);
  - `ExitFullscreenModeInternal` is a no-op, so F11 does nothing.
- **Ash runs in app (kiosk) mode.** Chrome reports `is_running_in_app_mode` to Ash in shell mode (`SessionControllerClientImpl`). Ash's existing kiosk code then does the rest:
  - the shelf and status area are always hidden, even when a popped-out window is active;
  - notifications are blocked, including the stub account's "Sign-in error";
  - only the app-mode accelerators work (brightness, volume, media keys, IME switching, accessibility toggles, UI scale, …). Overview, launcher, desks, Alt+Tab, lock and window snapping are off;
  - there is no desktop context menu and no back-gesture minimise.
- **What stays:** DevTools and `--remote-debugging-port`, page context menus, and the frontend's own keyboard shortcuts. Chrome's own `--kiosk` would block DevTools and change much more, so it isn't used. Chrome's `IsRunningInAppMode()` is unchanged; shell mode only touches the checks listed above.
- **Shell origin:** the URL's origin, unless `--plutonium-shell-origin` is also given. A URL that isn't http(s) on https, localhost or loopback is refused, as for the origin.
- **Popped-out windows fit on screen.** `EmbeddedWindows::ActivateOnDesktop` now fits the window into the work area. Before, a window popped out of a large tab kept wherever Ash had first parked it, partly off the screen. With no shelf or window management there was no way to move it back. This applies to every mode; it's an Exo change, not a shell-mode one.

About 110 lines across 10 Chromium files.

### Verified on Xvfb

Private instance (`:99`, `wayland-cros2`, CDP 9223, helper 3781), plain shell, `SHELL_MODE=1`:

| Check | Result | Evidence |
|---|---|---|
| Only the shell page opens, fullscreen | ✅ One page target, window 1600×1000 | `shots/phase4-shell-mode-embed.png` |
| No shelf, tray or notifications | ✅ The sign-in error notification shown without shell mode is gone | `phase4-before-immersive.png` (before) vs `phase4-shell-mode-embed.png` |
| Top edge: no frame reveal, no exit button | ✅ Pointer at y = 1: nothing appears. Before, the app window's frame with caption buttons slid down | `phase4-shell-mode-top-edge.png`, `phase4-before-immersive.png` |
| F11, Alt+Tab | ✅ Do nothing; the shell stays fullscreen | |
| Launch foot from the shell, embed it in a tab, type into it | ✅ `echo shell-mode-ok` ran | `phase4-shell-mode-embed.png` |
| Pop out | ✅ foot appears over the shell, inside the screen, with Ash's frame. The shelf stays hidden while it's active | `phase4-shell-mode-popout.png` |
| No DCHECKs | ✅ No `FATAL`, `DCHECK` or `Check failed` in `logs/shell-wayland-cros2.log` | |

### Launchers

- **`tools/launch-drm-shell.sh`** boots a session on KMS/DRM. It starts the helper, then Ash in `cros-drm` with:
  - the TTY report's recipe (`--ozone-platform=drm --use-angle=gles-egl --exo-viability-real-displays --disable-sync --exo-viability-no-signin-error`);
  - the shell flags (`--plutonium-shell-url`, `--plutonium-shell-origin`, `--plutonium-hide-windows`) and the embed input logs.

  Safety, carried over from `launch-cros-drm.sh`:
  - it refuses to start unless the kill switch is listening, Plasma is inactive and stdin is the active VT;
  - it re-execs with `--killswitch-tag=out/Cros/chrome` so the side button kills it too;
  - it turns the VT's keyboard off (`KD_GRAPHICS` + `K_OFF`) while Ash runs.

  `NOVT=1` is the unattended mode, which stops Ash after `HOLD_S` seconds.

  Its defaults (socket `wayland-drm`, CDP 9224, helper 3782, profile `/tmp/cros-drm-shell`) differ from the X11 launchers', so it never removes the socket of an X11 session left running in Plasma.
- **`DRM=1`** on `launch-plain-shell.sh` or `launch-t3-shell.sh` uses it. For T3, start the server with `PLUTONIUM_WAYLAND_DISPLAY=wayland-drm`.
- **`SHELL_MODE=1`** on `launch-shell.sh` and its wrappers runs shell mode on X11 (Xvfb or `:0`), for testing without a VT.
- **`tools/start-helper.sh`:** the helper start, now shared by both launchers.
- **Container `cros-drm`:** `cros-tty`'s image (`cros-build-img:tty-v2`) with `--pid=host`, so Exo reports host pids and the helper's thread binding works. It also has `/dev/dri`, `/dev/input` and `/run/udev`. The command is in the launcher's header. `/dev/input` is bind-mounted rather than passed with `--device`: `--device` fixes the device list at creation, so the container failed to start once an input device (`event25`) had gone. Checked: pid 1 is the host's systemd, `card1` is read-write, and all 25 evdev nodes are readable.

### Running it

From a text VT (Ctrl+Alt+F2, log in), with the kill switch armed:

```
DRM=1 ~/projects/plutonium/tools/launch-plain-shell.sh
```

Or from any other shell (e.g. an agent's) against a VT someone is logged in on, with passwordless sudo: `VT=tty2 DRM=1 PM=tools/pm.sh tools/launch-plain-shell.sh`. The VT check and the `KD_GRAPHICS`/`K_OFF` switch then go through `sudo tty_vt.py … < /dev/tty2`, and the VT is restored when Ash exits.

The kill switch button returns to Plasma. The kill switch SIGKILLs the launcher too, so the VT's keyboard mode isn't restored; on that VT, run `python3 ~/projects/plutonium/tools/tty_vt.py restore` (or log out and in again). Logs: `logs/drm-shell-wayland-drm.log` (launcher), `logs/shell-wayland-drm.log` (Ash), `logs/helper-wayland-drm.log`.

### Verified on the panel

| Check | Result | Evidence |
|---|---|---|
| Comes up on the panel | ✅ DRM master on the first attempt, modeset 2560×1600 @ 180 Hz, the shell page as the only target, 1440×900 CSS px at device scale 1.78 | `shots/phase4-drm-boot.png` |
| No shelf, tray or notifications | ✅ | same |
| Launch foot from the launch box | ✅ Embedded in a tab | `shots/phase4-drm-foot.png` |
| Type into foot | ✅ after the hit-test fix (item 3) | `shots/phase4-drm-foot-typed.png` |
| KCalc: buttons, File menu | ✅ 7 × 6 = 42 by mouse; the menu opens in place | `shots/phase4-drm-kcalc-menu.png` |
| Pop out | ✅ KCalc over the shell with Ash's frame, inside the screen, and clickable. Scale is right everywhere | `shots/phase4-drm-popout.png` |
| No DCHECKs | ✅ No `FATAL` or `Check failed` in the final runs | `logs/shell-wayland-drm.log` |

The white strip at the right and bottom of foot is the page's background: foot sizes itself in whole character cells (1215×763 in a 1220×778 element).

### Known limits

- **Every browser window is locked in fullscreen in shell mode**, not just the shell's: a window the shell opens can't leave fullscreen once it's in. This is how kiosk does it. Scope it to the shell window if that ever matters.
- **No way out but the kill switch** on DRM: app mode blocks sign-out and lock accelerators, and the shell has no "quit". A frontend could add one later; the kill switch stays the safety net (plan, item 3).
- **Ash's kiosk mode was designed for one app.** Its side effects beyond the ones above (e.g. the a11y tray item for reduced animations, floating a11y menu behaviour) aren't reviewed one by one.
- **No autostart at power-on.** The session starts from a logged-in VT. A getty autologin plus a unit running the launcher would close the gap; not done.

## Item 3: real input on the TTY

### How it was driven

Nobody was at the keyboard, so `tools/uinput.py` (root) created a virtual keyboard and mouse through `/dev/uinput` and took commands (`type`, `key`, `move`, `click`, …) from a FIFO. They're ordinary evdev devices: Ash opens them through Ozone's evdev backend like the built-in keyboard and touchpad (it had all 25 host evdev nodes open). With small relative steps, one mouse count was one CSS pixel; `home` moves far up-left to calibrate. A page-side listener (`isTrusted` events) confirmed what reached the page.

What this doesn't cover: the physical keyboard (the same code path, but not pressed by a person), the touchpad (a multitouch device, a different path; without libgestures in this non-device build it may not work as a pointer), pointer acceleration feel, and cursor drawing (the cursor is on its own plane and isn't in KMS captures). The mouse wheel didn't work at all on DRM; it was fixed during the tab work (`TABS_PROGRESS.md`, "Wheel fix").

### Results

- **Page input:** clicks land at the right coordinates (200 counts → x = 200), typing into the launch box works, Enter launches.
- **Embedded apps:** after the fix below, clicking foot focuses it and typing runs commands (`echo drm-input-ok $((6*7)) | tr a-z A-Z` → `DRM-INPUT-OK 42`). KCalc takes clicks on its buttons and opens its File menu in place; Escape closes it.
- **Popped-out windows** take clicks directly (Ash's own input path).
- **The VT stays quiet:** with `K_OFF` on tty2 the keystrokes didn't reach the VT's shell.

### Bug found: clicks never reached embedded windows (also the "mouse on `:0`" bug)

At first every click on foot went to the page (`EXO-EMBED down hit FrameSinkId(6, 3) … foreign 0`). The aggregated hit-test tree, dumped at each press (new `VLOG(2)` in the input router), showed the page's region with **no children**: the region for foot's window was missing.

The cause was in Phase 1's aggregator rewrite (`hit_test_aggregator.cc`):

- viz's `HitTestManager` rewrites client id 0 in a renderer's regions to the renderer's own client id. So the page (FrameSinkId(6, 3)) embedding foot's Exo window (0, 3) submits a region for (6, 3).
- The aggregator maps such regions back to the browser-owned sink, but did so after the cycle check. (6, 3) is the page itself, so the cycle check dropped the region silently.

It only happens when the Exo window's sink id equals the page's, which is why it never showed on `:99` but did on `:0` (BACKLOG "Mouse in the right panel on `:0`": "viz said the window, the renderer said page" matches a missing region). **Fix:** do the rewrite first, then the cycle check. After it the same press hits (0, 3), foreign and embedded here.

### Bug found: hotplugged input devices aren't seen

Devices that appear after Ash starts (the uinput ones, and so presumably a USB mouse plugged in later) are never opened. `cros-drm` is a rootless container: the host's udev events reach it (host network namespace), but their sender is root on the host, which is `nobody` in the container's user namespace, and libudev ignores netlink messages from senders other than uid 0. Inferred from the behaviour and libudev's sender check; not traced further. Workaround here: start the devices before Ash. A fix needs Ash outside the user namespace or a small udev relay.

## Item 2: embedding on the GPU path

### Results

The checks were made in the plain shell. An app was launched from the launch box, then its `<native-window>` was either left in its tab or given `position: fixed; inset: 0` to cover the screen. Plane use comes from the kernel's atomic state (`tools/kms-planes.sh`, 6–12 samples per case), and strategy outcomes from new `EXO-DIAG` logs.

| Case | Before | After the fixes |
|---|---|---|
| weston-simple-egl (dmabuf) in a tab | Renders in the page; composited | Same (windowed clients get no scanout tranche, as on ChromeOS) |
| …covering the screen, scale 1.78 | Composited: every strategy failed | **Underlay**: the client buffer (2556×1598 XR24, DCC_RETILE) on plane 3, Ash's frame (AR24 with a hole) on plane 4 |
| …covering the screen, scale 2 | (not tried) | **Fullscreen strategy**: the client buffer is the only plane; Ash composites nothing |
| mpv, VA-API NV12 (`--vo=dmabuf-wayland`), covering the screen | Composited (never tested as an underlay) | **Underlay**: NV12 1920×1080 on plane 3, scaled by the display, UI on plane 4. Same at scale 1.78 and 2 |
| …the same video in a tab | Composited | Underlay at scale 2; composited at 1.78 (fractional position, see limits) |

### What blocked it, and the fixes

1. **No scanout tranche for embedded windows.** Exo sends the scanout tranche of dmabuf feedback (displayable modifiers) only to windows that Ash itself has in fullscreen. The page shows a parked window, so the client allocated `0x02000000186abb04` (GFX11 DCC with pipe-align), which the display can't scan out. The window got no KMS framebuffer, and the validator answered "not able" without even testing. **Fix (`shell_surface_base.cc`):** a parked window that the page sizes to at least the display's size counts as fullscreen for dmabuf feedback (`UpdateEmbedCoversDisplay`). The client then reallocates with `0x0200000018667b04` (DCC_RETILE).
2. **The topmost-plane rule on AMD.** AMD has no separate cursor plane, so viz's `OverlayProcessorOzone` blanks the topmost candidate if it is translated or scaled. This is the TTY report's "placeholder primary plane": the fullscreen candidate's buffer is 2556×1598 for a 2560×1600 rect, so it was blanked, and DRM saw an empty z=0 candidate. The 4 px come from fractional scaling: Exo sends `preferred_scale(213)` (1.775), the nearest 1/120 step to the panel's 16/9, so a 1440×900 window can't get a 2560×1600 buffer. At scale 2 (`preferred_scale(240)`) the sizes match and the fullscreen strategy wins. Not changed; see limits.
3. **Underlay was never tried for video.** The video quad is scaled, so the rule above always blanks its single-on-top candidate. With several overlays allowed, viz's `OverlayCombinationCache` considers one candidate per quad (the highest power gain, i.e. single-on-top), and when every combination has failed it retries that one forever. **Fix (`overlay_processor_ozone.cc`):** without an independent cursor plane, drop single-on-top and fullscreen proposals that would be blanked anyway (an override of `SortProposedOverlayCandidates`, made protected for it). The underlay for the same quad is then tested.
4. **NV12 buffers never got a framebuffer.** Mesa's `gbm_device_is_format_supported()` says no to NV12 for every usage, so the TTY run's import fallback imported it with no usage flags, and `DrmThread` only adds framebuffers for `GBM_BO_USE_SCANOUT` buffers. **Fix (`gbm_wrapper.cc`):** import formats gbm doesn't report with `GBM_BO_USE_SCANOUT` first (the existing no-flags retry stays). `AddFB2` decides; NV12 with the AMD modifier works. This was the TTY report's "NV12 native-pixmap lookup" item.

### Diagnostics added (`EXO-DIAG`, ERROR level, rate-limited or logged once per distinct value)

- `proposed` and `outcome` (`overlay_processor_using_strategy.cc`): each strategy's candidates, the winning strategy and the primary plane's format.
- `multi tested` (the multiple-overlay path): each distinct combination and its result.
- `blanked (<reason>)` (`overlay_processor_ozone.cc`): no native pixmap, colour space, or the topmost-plane rule.
- `validated sync` (`drm_overlay_manager.cc`): GPU-side test results per candidate.
- `no compatible plane`, `SetPlaneData failed` (`hardware_display_plane_manager.cc`), plane-assignment failures during tests, and test commit failures (`hardware_display_plane_manager_atomic.cc`).
- `EXO-HIT invalid child` (`hit_test_aggregator.cc`), and the hit-test tree at each press (`render_widget_host_input_event_router=2`).

### Limits

- **Windowed embedded apps are always composited.** Only a window covering the display gets the scanout tranche. This matches ChromeOS, which advertises scanout only for fullscreen.
- **At the panel's default scale (1.78) a fullscreen app needs an underlay**, which still has Ash composite the UI plane (with a hole) every frame. Only scale factors that are exact in 1/120 steps and divide the panel, such as 1.6 (1600×1000) or 2 (1280×800), let the fullscreen strategy skip Ash's composite. Options: pick such a scale for the shell, or relax the topmost-plane rule for scale errors under a pixel or two (the cursor would be off by up to ~4 px at the far edge).
- **Elements at fractional device positions aren't promoted:** DRM takes only whole-pixel rects. The plain shell's tab area starts at x = 219.999 CSS px (391.1 device px) at scale 1.78. Frontends can snap elements to device pixels; `<native-window>` could do it itself.
- **Not measured:** frame timing and power. The evidence is plane state and viz strategy outcomes, not frame pacing.

## Tools added

- `tools/launch-drm-shell.sh`: `VT=ttyN` mode (VT handling through sudo, for unattended runs).
- `tools/uinput.py`: a virtual evdev keyboard and mouse fed from a FIFO (root).
- `tools/kms-planes.sh`: which planes scan out what (format, modifier, size), from the kernel's atomic state (sudo).
- `tools/kmsshot.sh`: a screenshot straight from KMS. It goes through ffmpeg's `kmsgrab` and VA-API, since the framebuffers are tiled, and needs sudo. It captures one plane only, so it misses the cursor and underlays.
- `tools/cdpx.sh`: runs `tools/cdp*.py` inside a container that has Python `websockets`.
- `tools/tty_vt.py`: keeps its state file next to the repo's `logs/`, so it works as root too.

## Next

- Autostart at power-on (getty autologin and a launcher unit), and a way out other than the kill switch.
- The hotplug fix (udev relay, or Ash outside the user namespace).
- A device scale for the shell that makes fullscreen buffers exact, or the relaxed topmost rule; pixel-snapping for `<native-window>`.
- T3 Code as the frontend on DRM (`DRM=1 launch-t3-shell.sh`, with the server's `PLUTONIUM_WAYLAND_DISPLAY=wayland-drm`). Not run yet.
- A unit test for the aggregator fix (`hit_test_aggregator_unittest.cc`: a renderer region whose rewritten id equals the submitter's).
