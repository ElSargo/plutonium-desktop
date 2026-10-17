# linux-chromeos on its own VT (Ozone DRM): report

Date: 2026-10-15. Same machine, Chromium revision (`9f2eedcd653d`) and branch (`exo-viability`) as `VIABILITY_REPORT.md`. The run was unattended on tty2 from 12:38 to 13:30. The display went back to Plasma via `loginctl activate 3` at the end.

## 1. Verdict

**It works.** After six small changes, linux-chromeos runs as a standalone desktop on KMS, drives the panel directly (2560×1600 @ 180 Hz) and hosts every test client through Exo with **no GPU crashes**. This configuration also fixes most of what was broken on the X11 path:

- **Zero-copy all the way to the display works.** An opaque fullscreen client's dmabuf was **scanned out on its own hardware plane** in about 91% of frames (2,088 of 2,296), via the underlay strategy.
- **The AB30 (10-bit) crash is gone** on the production-like GL path.
- **NV12 hardware video imports and plays**, though it still isn't promoted to a plane.
- The dmabuf feature flags from X11 aren't needed: native pixmaps are always on under DRM.

What still needs work:

- **Windowed clients are always composited.** Ash's rounded-corner windows and every other strategy failure apply, so this is by ChromeOS design.
- **The fullscreen ("no primary composite at all") strategy trips over a placeholder primary plane.** It's a DCHECK in this build; I'm guessing it's silently skipped in release builds.
- **NV12 promotion fails at the native-pixmap lookup.**

Nothing here was observed on screen; the user was away. All claims come from logs, histograms, DevTools/UI-DevTools and Wayland protocol traces.

## 2. Setup

- **Container `cros-tty`.** It's a commit of `cros-build` (image `localhost/cros-build-img:tty`) plus `--device /dev/input`, `-v /run/udev:/run/udev:ro`, `--group-add keep-groups` (video, input and render GIDs were checked on the process). `card1`, `renderD128` and evdev nodes all open inside it. `cros-build` is untouched.
- **Launcher.** `tools/launch-cros-drm.sh` re-execs itself with a `--killswitch-tag=out/Cros/chrome` argument so the kill switch matches it (checked with `killswitch.py --fire --dry-run`).
  - Before every launch it checks that `exo-killswitch` is active and its last state is `listening on /dev/input/event17`, that Plasma session 3 is inactive, and that the active VT isn't tty3. There's also a 15-minute deadline.
  - Presets `gl`, `vk`, and `custom` (`$CHROME_EXTRA`). `base:steps` runs a subset of client steps.
  - `NOVT=1` is the unattended mode used here. The interactive mode (run from a VT login) also sets `KD_GRAPHICS` + `K_OFF` via `tools/tty_vt.py`, so keystrokes don't reach the VT's shell. Chrome itself never touches VT modes.
- **Clients.** `tools/tty-clients.sh` is a timed client sequence. It takes per-step histogram snapshots via `tools/cdp_hist.py`, which opens `chrome://histograms` because that syncs GPU-process histograms (`Browser.getHistograms` doesn't).
- **Ash introspection.** `tools/uidevtools_*.py` read the window tree and properties over `--enable-ui-devtools=9223`.
- **Unexpected VT change.** Once, around 12:54, the active VT briefly showed tty1 and then tty2 again. There was no new logind session. That launch didn't get DRM master (`Failed to authenticate /dev/dri/card1 after 10 attempts`); later launches did. Cause unknown; my guess is a key combination.

Final working launch (inside `cros-tty`):

```
out/Cros/chrome --ozone-platform=drm --use-angle=gles-egl \
  --enable-wayland-server --wayland-server-socket=wayland-cros \
  --exo-viability-real-displays --disable-features=Forest \
  --disable-sync --exo-viability-no-signin-error \
  --user-data-dir=/tmp/cros-tty-custom --remote-debugging-port=9222
```

gn args are unchanged from the X11 work (`use_system_minigbm=true`). Ozone DRM was already compiled in.

## 3. What blocked DRM, in order

1. **linux-chromeos throws away the DRM display delegate.** `DisplayManager`, `DisplayConfigurator`, `Shell::InitializeDisplayManager` and `DisplayConfigurationController` only configure real displays when `base::SysInfo::IsRunningOnChromeOS()`. Otherwise `DisplayConfigurator::Init` bails out and destroys the unregistered `DrmNativeDisplayDelegate`, which aborts with `DCHECK failed: delegate_ == delegate` in `drm_display_host_manager.cc:374`. Setting `LSB_RELEASE`/`LSB_RELEASE_TIME` would flip that globally, including login and real D-Bus clients. Instead I gated those four places on a new switch, **`--exo-viability-real-displays`**. Result: `Modeset succeeded` on connector 100 / CRTC 86 at `2560x1600p@180`.
2. **DRM master works.** It was obtained on the first attempt whenever Plasma's VT was inactive (`Succeeded authenticating /dev/dri/card1 in 0 ms`). No root needed: the user is in `video`, and logind drops KWin's master on VT switch.
3. **ANGLE defaults to its desktop-GL backend even on DRM.** `ANGLE_OPENGL` exposes 23 EGL extensions, none of them for dmabuf import. The DRM GL path (`GLOzoneEGLGbm::CanImportNativePixmap`) needs `EGL_EXT_image_dma_buf_import`, so Viz couldn't allocate its own 2560×1600 scanout buffers. Result: `Context was lost`, 6 GPU restarts, `GPU process isn't usable. Goodbye.`
   - `--use-angle=gles` didn't help.
   - **`--use-angle=gles-egl`** gives `ANGLE_OPENGLES_EGL`, with `EGL_EXT_image_dma_buf_import` and `_modifiers` present and Skia on GaneshGL, i.e. the production ChromeOS shape. Everything below uses this.
   - `--enable-features=Vulkan` also brings Ash up (Skia GaneshVulkan), but the AB30 Skia crash remains on that path.
4. **The stub account's "Sign-in error" notification** (`AshNotificationView` in `SettingBubbleContainer`, text read via UI DevTools) sits above fullscreen windows. That prevents fullscreen and single-on-top promotion. It isn't removed by `--disable-sync`; I added the `--exo-viability-no-signin-error` switch.
5. **XKB keymap missing.** Input-method setup uses `FakeImeKeyboard` unless `IsRunningOnChromeOS()`, so the evdev keyboard path had no XKB keymap: 69,501 `No current XKB state` errors at every startup. Gated `ImeKeyboardImpl` on `--exo-viability-real-displays`; the errors went to 0. Keyboard input itself was **not tested** (no input injection without root).

## 4. Results (final config, run `logs/tty-20261015-132613/custom-all`)

Exo advertised `wl_compositor` v4 (patch) and **`zwp_linux_dmabuf_v1` v4 with feedback**: main device `card1`/`renderD128`, 60 format/modifier entries including AMD GFX11 DCC, DCC_RETILE and LINEAR. Unlike X11, this works with Skia on GL. GPU-process exits: **0**. Import failures: **0**.

| Client | Buffer path | Frames | Promoted to plane | Overlay strategy result |
|---|---|---|---|---|
| weston-simple-shm | shm | 1541 | 0 | no candidate |
| weston-simple-egl (windowed) | dmabuf | 1521 | 0 | proposed, all fail |
| weston-simple-dmabuf-egl (windowed) | dmabuf | 2237 | 0 | proposed, all fail |
| foot | shm | 163 | 0 | no candidate |
| gtk4-demo | dmabuf (Vulkan WSI) | 150 | 0 | no candidate |
| kcalc (Qt 6) | shm | 174 | 0 | no candidate |
| mpv gpu-next (windowed) | dmabuf | 959 | 0 | proposed, all fail; 13 s, 0 drops |
| mpv dmabuf-wayland + VA-API, fullscreen | **NV12** dmabuf | 970 | 0 | proposed, all fail; 13 s, 0 drops |
| simple-dmabuf-feedback (fullscreen, AB30) | dmabuf | 572 | 0 | no candidate; got a **scanout tranche** |
| simple-egl -f (fullscreen, alpha) | dmabuf | 2295 | 0 | proposed, all fail (alpha blocks underlay) |
| **simple-egl -f -o (fullscreen, opaque)** | dmabuf, DCC_RETILE | 2296 | **2088 (91%)** | **underlay** |
| simple-dmabuf-egl -f AB30 (10-bit) | dmabuf RGBA_1010102 | 1517 | 0 | no candidate; **no crash** |

Frame counts and strategies come from `Compositing.Display.OverlayProcessorUsingStrategy.NumOverlaysPromotedV2` and `Viz.DisplayCompositor.OverlayStrategy` (1 = no strategy used, 4 = underlay, 6 = all failed), as deltas between per-step synced snapshots. `MaxPlanesSupported` = 4.

### The zero-copy-to-display chain, step by step

1. When a surface goes fullscreen, Exo sends a per-surface dmabuf feedback with a **scanout tranche**: target `card1`, only displayable modifiers (DCC_RETILE, 64KB_R_X, LINEAR, …) (`client-feedback-fs.log`).
2. Mesa EGL follows it: `tranche_flags(1)` received, then it allocates `0x0200000018667b04` (GFX11 DCC_RETILE, 3 planes) (`client-egl-fs*.log`).
3. Exo imports the buffer as a native pixmap with `Scanout` usage. The aggregated root pass holds it as a single texture quad (`m9:0,0 2560x1600`, resource 2556×1598), and the candidate factory accepts it (`status=0`).
4. Fullscreen and single-on-top fail (see §5), and **underlay succeeds**: the client buffer goes on its own DRM plane, and Ash's primary plane (with a transparent hole) composites only the UI on top.

## 5. Remaining problems

| Problem | Evidence | Estimate |
|---|---|---|
| Fullscreen strategy (no primary composite) never wins | For fullscreen, Viz sends DRM a **placeholder primary candidate** (0×0, no pixmap). `DrmOverlayManager::CanHandleCandidate` rejects it (`buffer_size=0x0`), and `DCHECK(can_handle \|\| plane_z_order != 0)` aborts the GPU process in this DCHECK build. I replaced the DCHECK with a log. | Small. Probably treat the placeholder as handled. Guess: release builds skip it and still fall back to underlay. |
| NV12 not promoted to a plane | The video quad is a valid candidate (`status=0`, display 0,80 2560×1440), but `OverlayProcessorOzone` blanks it (`buffer_size=0x0` reaches DRM at z=1). Colour-space rules pass for BT.709 limited, so the remaining branch is `GetNativePixmap(mailbox)` failing for the multi-planar SharedImage (inferred; that path only `DLOG`s). | Small to medium. |
| Windowed clients never promoted | Ash windows have rounded corners and sit inside render passes or under shadows. ChromeOS by design only promotes fullscreen video or overlay-priority surfaces. | Design limit. Would need Exo to request overlay priority, or square corners. |
| AB30 + Skia Vulkan crash | Same `GrTextureProxy.cpp:239` texture-type check as on X11, but only with `--enable-features=Vulkan`. Fine on the GL path. | Avoid by using `gles-egl`; the Vulkan fix is still open. |
| Keyboard and pointer input untested on DRM | No input injection without root. The XKB keymap is now loaded. | Needs a user session at the keyboard. |
| Fixed DSF | The panel came up at device scale factor 1.777… (configure 1440×900 logical). Fullscreen clients therefore allocate 2556×1598, not 2560×1600. | Cosmetic; it didn't block underlay. |

## 6. Patches added in this phase (on `exo-viability`; `~/projects/plutonium/patches/exo-viability.patch` now covers 20 files, +173/−18)

| Change | Files | Kind |
|---|---|---|
| `--exo-viability-real-displays` switch: drive real displays and use the real ImeKeyboard on linux-chromeos | `ui/display/manager/display_manager.cc`, `display_configurator.cc`, `ash/shell.cc`, `ash/display/display_configuration_controller.cc`, `chrome/browser/ash/input_method/input_method_configuration.cc` | functional |
| Try `gbm_bo_import` even when `gbm_device_is_format_supported()` says no (makes NV12 import work) | `ui/gfx/linux/gbm_wrapper.cc` | functional |
| Default YUV Exo buffers with RGB-matrix colour spaces to BT.709. Previously a hard CHECK: `ToSkYUVColorSpace called on RGB color space` | `components/exo/buffer.cc` | functional (Exo bug fix) |
| `--exo-viability-no-signin-error` (suppress the stub-account popup) | `chrome/browser/ash/login/signin/signin_error_notifier.cc` | test-environment only |
| Primary-placeholder DCHECK replaced with a log | `ui/ozone/platform/drm/gpu/drm_overlay_manager.cc` | diagnostic / workaround |
| Candidate-status, render-pass and rejection logging (`EXO-DIAG`) | `overlay_candidate_factory.{h,cc}`, `overlay_processor_using_strategy.cc`, `drm_overlay_manager.cc` | diagnostic only |

## 7. Recommended next steps

1. **Use DRM, not X11, as the host path.** It removes the double composite and the GLX/ANGLE limitations, and promotes buffers to hardware planes. Make `gles-egl`, `--exo-viability-real-displays` and `use_system_minigbm=true` the default "linux-chromeos on KMS" recipe.
2. **Small follow-ups,** each probably hours to a day:
   - accept the fullscreen placeholder in `DrmOverlayManager`, so fullscreen clients skip Ash's composite entirely;
   - find the NV12 native-pixmap lookup failure;
   - upstream-quality versions of the GBM and colour-space fixes.
3. **Interactive session.** A user at the keyboard checks input, focus, popups and VT behaviour on DRM, using `launch-cros-drm.sh` in interactive mode (it sets `KD_GRAPHICS`/`K_OFF`).
4. **Root-only confirmation, optional.** `sudo cat /sys/kernel/debug/dri/1/state` during an `egl-fs-opaque` run would show the client framebuffer on a non-primary plane directly at the kernel level. I didn't do this (no sudo in scope).

## Artefacts

- `~/projects/plutonium/logs/tty-20261015-*/`: one directory per launcher run. Each has `launcher.log`, plus per-preset `chrome.log`, `steps.log`, `wayland-info.txt`, `gpu-info*.json`, `hist-*.txt`/`.json` and `client-*.log`. The final run is `tty-20261015-132613/custom-all`; the first promoted run is `tty-20261015-131340`.
- `~/projects/plutonium/tools/`: `launch-cros-drm.sh`, `tty-clients.sh`, `tty_vt.py`, `cdp_hist.py`, `uidevtools_tree.py`, `uidevtools_attrs.py`, `uidevtools_labels.py`.
- Containers: `cros-build` (unchanged) and `cros-tty` (new, holds nothing unique). Image: `localhost/cros-build-img:tty`.
