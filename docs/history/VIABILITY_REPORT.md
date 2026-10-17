# Exo on a Linux desktop — viability report

Date: 2026-10-15. Chromium revision `9f2eedcd653d4c17fd6aa06fd3f4699d7af7b2e1` (2026-10-14, Chrome 158.0.8106.0), branch `exo-viability`.

## 1. Verdict

**Partly works — better than expected, with a short, well-understood list of blockers.** A linux-chromeos build hosts ordinary native Wayland apps (foot, GTK4, Qt 6, mpv, weston demos) as Ash windows, with working keyboard/mouse input, resize, close, popups and HiDPI/fractional scaling. **Zero-copy dmabuf works end to end** — client GPU buffers (including AMD DCC‑compressed ones) are imported as Vulkan images with no CPU copy — but only after three flag/build changes and a one-line GBM fix. Out of the box (stock flags) dmabuf is advertised but every import fails, and Mesa clients silently fall back to software rendering. Remaining real gaps: 10‑bit dmabufs crash the GPU process, hardware-video NV12 dmabufs are rejected, and Ash always composites client buffers itself (no passthrough to the host compositor).

## 2. Environment

| | |
|---|---|
| Machine | An x86-64 laptop with an AMD integrated GPU |
| Host OS | A Linux desktop: KDE Plasma Wayland session (KWin), Xwayland on `:0` |
| Host Mesa | 26.2.2 (radeonsi) — used by the **test clients** |
| Build/run env | Rootless podman container `cros-build`, Ubuntu 24.04 (NixOS can't run Chromium's prebuilt toolchain). Mounts: `~/chromium`, `~/depot_tools`, `/tmp/.X11-unix`, `/dev/dri`, `/run/user/1000`. Chrome therefore uses the **container's Mesa 25.2.8** in its GPU process. |
| depot_tools | `9aff0ca8234542479dc8d15c14d63b82da630e59` |
| Checkout | `fetch --nohooks --no-history chromium`, `.gclient` + `target_os = ['chromeos']`, `gclient sync --nohooks --no-history -j 4` (the default `-j 32` hit googlesource HTTP 429 "Short term server-time rate limit exceeded"), `install-build-deps.sh --no-prompt --no-arm --no-nacl` as container-root (no host sudo). `src/` = 48 GB incl. build output. |
| Initial gn args | `target_os="chromeos" is_component_build=true is_debug=false dcheck_always_on=true symbol_level=1` |
| Final gn args | same **+ `use_system_minigbm=true`** (see §5) |
| Build | `autoninja -j 16 -C out/Cros chrome`: **1h55m10s**, 68,335 steps, no errors. Incremental rebuilds for patches: 3–50 s. |

Launch (inside the container; full script in `tools/launch-cros.sh`):

```
out/Cros/chrome --enable-wayland-server --wayland-server-socket=wayland-cros \
  --use-system-clipboard --user-data-dir=/tmp/cros-exo-test \
  --enable-logging=stderr --v=0 --disable-features=Forest \
  # best config for zero-copy:
  --enable-native-gpu-memory-buffers --enable-features=Vulkan
```

`--disable-features=Forest` suppresses the first-run "Welcome Recap" dialog, which otherwise covers client windows.

## 3. Results per phase

### Phase 0–2
Covered above. Notable friction: NixOS needs a container (or FHS env); googlesource rate-limits anonymous clients at gclient's default parallelism.

### Phase 3 — launch
Works with **no graphics fallbacks**: hardware GPU via ANGLE→desktop GL (`gl=egl-angle,angle=opengl`, Skia GaneshGL). Full Ash desktop (shelf, launcher, tray) in a 1366×768 X11 window. `/run/user/1000/wayland-cros` created. Only Exo log noise: `server.cc:193 Group 'wayland' not found` (harmless; Exo just can't chgrp the socket).

### Phase 4 — globals (`logs/exo-wayland-info*.txt`)
`wl_compositor` v3, `wl_shm` v1, `wl_subcompositor` v1, `wl_output` v3, `wl_seat` v6, `wl_data_device_manager` v3, **`xdg_wm_base` v3**, `zwp_linux_dmabuf_v1` (see below), `wp_viewporter`, `wp_presentation`, `wp_fractional_scale_manager_v1`, `wp_single_pixel_buffer_manager_v1`, `wp_content_type_manager_v1`, `zxdg_output_manager_v1` v3, `zxdg_decoration_manager_v1`, pointer constraints/gestures/relative-pointer, idle-inhibit, keyboard-shortcuts-inhibit, `zwp_text_input_manager_v1`, `wl_shell` v1, plus Chromium-specific `zaura_shell` v65, `zcr_remote_shell_v1/v2`, `surface_augmenter` v13, `overlay_prioritizer`, `zcr_*` (stylus, gaming input, vsync feedback, notification shell, …).

Missing vs. a typical desktop compositor (seen as client warnings): `xdg_activation_v1`, `wp_cursor_shape_v1` (only `zcr_cursor_shapes_v1`), `xdg_toplevel_icon_v1`, `zwp_text_input_v3`, `ext_data_control_v1`, `zwp_linux_explicit_synchronization_v1` / `wp_linux_drm_syncobj_v1`.

**`zwp_linux_dmabuf_v1` by configuration:**

| Config | Version | Formats / modifiers | Main device |
|---|---|---|---|
| Stock (ANGLE-GL) | **v3** | 9 formats (AR24, XR24, AB24, XB24, AB30, AB4H, RG16, NV12, YV12), **implicit modifier only** (`INVALID`) | none (no feedback) |
| `--enable-features=Vulkan` | **v4** | same 9 formats, real AMD GFX11 modifiers incl. DCC, 64KB_R_X, 64KB_D, LINEAR (60 entries) | `0xE280` = `renderD128` |

### Phase 5 — clients
See §4.

### Phase 6 — zero-copy
See §5.

## 4. Client compatibility

Final config = Vulkan flags + all patches in §6. Input/resize/close/popup columns were driven with XTest on a private Xvfb display inside the container (XTest into KWin's Xwayland is not honoured, even after granting the remote-input prompt). Xvfb has no DRI3, so those runs used shm; input handling is independent of the buffer path.

| Client | Stock build/flags | Final config | Input | Resize / close | Popups | HiDPI |
|---|---|---|---|---|---|---|
| `weston-simple-shm` | ✅ | ✅ | – | – | – | – |
| `weston-simple-egl` | ⚠️ renders, but **llvmpipe + wl_shm** (`MESA-LOADER: failed to get driver name for fd -1`) | ✅ GPU, DCC dmabufs (~178 commits/s) | – | – | – | – |
| `weston-simple-dmabuf-egl` | ❌ empty window; GPU: `Could not find SharedImageBackingFactory … BGRX_8888` ×3,700+ | ✅ animates; DCC modifier `0x02000000186abb04` | – | – | – | – |
| `simple-dmabuf-egl -f AB30` (10‑bit) | ❌ | ❌ **GPU process crash** (Skia `GrTextureProxy.cpp:239` texture-type check) | – | – | – | – |
| foot 1.27 | ❌ `wl_compositor: need interface version 4` | ✅ (patches A+B) | ✅ keyboard incl. shifted symbols | ✅ maximise/restore/drag-resize (tput tracks size), ✅ close → client exits | – | – |
| GTK4 4.22 `gtk4-demo` (Vulkan renderer) | ⚠️ renders via dmabuf only if dmabuf works | ✅ CSD drawn correctly | ✅ | – | ✅ popover opens, anchored correctly (`xdg_popup.configure(558,40,209,122)`), grab + dismiss OK | ✅ 2× crisp; ✅ 1.25× via `preferred_scale(150)` + viewporter |
| Qt 6 KDE `kcalc` 26.08 | ✅ renders (shm), server-side Ash frame | ✅ | ✅ clicks (7+3= → 10) | – | ❌→✅ menus never open (Qt: `There are no outputs - creating placeholder screen`) until patch D | ✅ 1.25× via fractional-scale |
| mpv `--vo=gpu` (EGL) | ❌ needs `wl_compositor` v4 | ❌ **AB30 swapchain → GPU crash** (same as above) | – | – | – | – |
| mpv `--vo=gpu-next --gpu-context=waylandvk` | ❌ v4 | ✅ client stats 0 drops/10 s (client-side metric only) | – | – | – | – |
| mpv `--vo=dmabuf-wayland --hwdec=vaapi` (NV12) | ❌ v4 | ❌ blank; `CanCreateNativePixmapForFormat false for (Y_UV, 420, 8unorm, ExtSamplerOn)`; no crash | – | – | – | – |

Notes:
- Ash's allowed device scale factors are a fixed list; `--ash-host-window-bounds=…*1.5` aborts (`Received a DSF not on the list: 1.5`). 1.25 and 2 work.
- Exo sends frame callbacks faster than display refresh (~175/s for simple clients). Not investigated.
- When a GPU import fails, the whole Ash window flashes white while the GPU channel churns, and recovers after the client exits.
- Screenshot sampling of the Xwayland window (`import`/XGetImage) is irregular, so no frame-pacing claims are made from captures.

## 5. Zero-copy findings

### Why it fails out of the box (stock flags), in the order the gates were hit
1. **No native-pixmap SharedImage factory.** `OzoneImageBackingFactory` is only registered when the X11 Ozone platform reports `supports_native_pixmaps` (`ui/ozone/platform/x11/ozone_platform_x11.cc:219`), which needs a GBM device created in the GPU process, which only happens with **`--enable-native-gpu-memory-buffers`** (`InitializeGPU`). Real ChromeOS gets this from session_manager; linux-chromeos doesn't.
2. **Bundled minigbm has no GPU backends.** With `target_os="chromeos"`, `is_linux` is false, so `use_system_minigbm=false` and every `use_*_minigbm` is false. `gbm_create_device()` on the DRI3-provided AMD fd fails (`EXO-DIAG CreateGbmDevice FAILED`). **Fix: gn `use_system_minigbm=true`** (links Mesa libgbm). Verified: DRI3Open + Mesa GBM work fine from inside the container.
3. **ANGLE-on-GLX lacks every dmabuf EGL extension.** On X11, Ozone only allows `egl-angle` (`X11SurfaceFactory::GetAllowedGLImplementations`). ANGLE's OpenGL backend on X11 exposes none of `EGL_EXT_image_dma_buf_import(_modifiers)`, `EGL_EXT_device_query`, `EGL_EXT_device_drm(_render_node)`. Consequences: `PopulateDRMCapabilities` returns early → dmabuf **v3, no feedback, implicit modifiers only** → host Mesa clients can't discover the GPU and fall back to llvmpipe; GL import falls back to a DRI3 X‑pixmap path that only accepts `BGRA_8888` (`native_pixmap_egl_x11_binding.cc:27`). `--use-angle=vulkan` crash-loops on X11 (`No suitable EGL configs found`). **Fix: `--enable-features=Vulkan`** (Skia GaneshVulkan). Caps then come from `PopulateVkDrmFormatsAndModifiers` → v4 + feedback + real modifiers, and import goes dmabuf → VkImage.
4. **SCANOUT-only GBM import.** With system GBM, Chrome imports every client dmabuf with `GBM_BO_USE_SCANOUT` (`gbm_wrapper.cc`, non-`MINIGBM` `GetSupportedGbmFlags`). Mesa rejects SCANOUT imports of the 2-plane non-displayable DCC modifiers that Exo itself advertises (verified with a standalone test: `0x02000000186abb04` → SCANOUT FAIL, RENDERING/0 OK; single-plane tiled and LINEAR OK with any flag). **Fix: patch C** (retry import without usage flags).

### With the fixes
- `simple-dmabuf-egl`, `simple-egl`, GTK4 (Vulkan WSI) and mpv gpu-next render via dmabuf; zero import failures, zero crashes in the final regression run.
- **No CPU copy, by code path:** for `gmb_type=platform`, `SharedImageFactory::CreateSharedImageWithBuffer` picks `OzoneImageBackingFactory` → `OzoneImageBacking` (dmabuf imported as a VkImage), then `CompoundImageBacking::WrapExternalBacking` wraps it as a single element with **no shared-memory element**. Before the factory existed every one of these buffers failed outright, so there is no silent copy fallback for dmabufs. (By contrast `wl_shm` buffers go through `CompoundImageBacking::Create` = shm + GPU upload, i.e. a copy, as expected.) No GPU-timeline trace was taken; "zero-copy" here means no CPU readback/upload of client pixels, not zero GPU work.

### Still broken
| Problem | Evidence | Estimated fix |
|---|---|---|
| 10‑bit (AB30) dmabufs crash the GPU process | `GrTextureProxy::onValidateSurface` check `textureType()` mismatch from `SkiaOutputSurfaceImplOnGpu::FinishPaintRenderPass`; reproduced with `simple-dmabuf-egl -f 0x30334241` | Guess: Viz promises a 2D texture but the Vulkan import of RGBA_1010102 yields an external/YCbCr-sampler texture (or vice versa). Small-to-medium; a stopgap is to drop AB30/XB30 from the advertised list. |
| NV12/YV12 (hardware video) rejected | `CanCreateNativePixmapForFormat false`; Mesa `gbm_device_is_format_supported(NV12, *) = 0` for every usage on this GPU, although EGL/Vulkan can import NV12 | Medium (~50–150 lines): stop routing client dmabufs through GBM for validation in `X11SurfaceFactory::CreateNativePixmapFromHandle`/`CanCreateNativePixmapForFormat`; wrap the fds in `NativePixmapDmaBuf` directly and gate on Vulkan format support. |
| No passthrough to the host compositor | X11 Ozone leaves `supports_overlays=false`; Viz composites every client buffer into Ash's single X11 swapchain, which KWin then composites again (one extra full-window GPU composite per frame) | Needs Ash on Wayland Ozone (delegated compositing / subsurfaces, as Lacros used). **Blocked:** `ui/ozone/platform/wayland/BUILD.gn` has `assert(is_linux)`; `ozone_platform_wayland=true` fails at gn time for a ChromeOS build. Large. |
| No explicit sync | `zwp_linux_explicit_synchronization_v1` / `wp_linux_drm_syncobj_v1` absent; clients use implicit sync | Medium; matters for NVIDIA and for latency. |

## 6. Patches on branch `exo-viability` (`~/projects/plutonium/patches/exo-viability.patch`, 9 files, +70/−8)

All marked `EXO-VIABILITY` or `EXO-DIAG` in the source.

| | File | Purpose |
|---|---|---|
| A | `components/exo/wayland/wl_compositor.{h,cc}` | Advertise `wl_compositor` v4; `damage_buffer` treated as full-surface damage (protocol-legal over-damage). Unblocks foot, mpv. |
| B | `gpu/command_buffer/service/shared_memory_region_wrapper.cc` | Honour client `wl_shm` stride (padded rows) and non-zero pool offsets; previously the GPU side assumed tight rows (DCHECK; without DCHECKs this would probably render sheared — **inferred, not tested**) and asserted offset 0 although the mapping code already handles offsets. Unblocks foot. |
| C | `ui/gfx/linux/gbm_wrapper.cc` | Retry `gbm_bo_import` without `GBM_BO_USE_SCANOUT` (DCC modifiers). |
| D | `components/exo/wayland/wayland_display_observer.cc` | Send `zxdg_output_v1.name` (since v2, never sent). Without it Qt never registers the output and QMenu popups never open. |
| diag | `ozone_image_backing_factory.cc`, `shared_image_factory.cc`, `gbm_support_x11.cc`, `ozone_platform_x11.cc` | Logging only (`EXO-DIAG`); safe to drop. |

Plus gn `use_system_minigbm=true` and runtime flags `--enable-native-gpu-memory-buffers --enable-features=Vulkan`.

## 7. Phase 7 pointers (read-only, rough)

**Where toplevels become Ash windows.** `components/exo/wayland/xdg_shell.cc` → `exo::Display::CreateXdgShellSurface` (`display.cc:129`) → `XdgShellSurface`/`ShellSurfaceBase::CreateShellSurfaceWidget` (`shell_surface_base.cc:~1784`): builds a `views::Widget` (`TYPE_WINDOW`/`POPUP`/`MENU`) parented into an Ash desk container via `ash::Shell::GetRootWindowForNewWindows()` / `ash::desks_util`. The pixels live in a separate object: each `exo::Surface` is an `aura::Window`, and `SurfaceTreeHost` submits its **own viz CompositorFrame via its own frame sink, with its own `viz::SurfaceId`** (`surface_tree_host.h:104`). `WMHelper` (`wm_helper.cc`) is the thin Ash shim for activation, containers, tablet mode and frame throttling.

**Hosting one in a browser tab** (guess): the cheapest route is to skip the Widget and embed the `SurfaceTreeHost`'s `viz::SurfaceId` in the tab, as a `cc::SurfaceLayer` inside a custom `views::View`/`WebContentsView`, or as a renderer-side SurfaceLayer like an OOPIF — and forward input and size from the tab to `xdg_toplevel.configure`/`wl_seat`. That means a custom `ShellSurfaceBase`-like delegate that doesn't create a Widget. Rough: **medium–large** (weeks), mostly in input routing, focus and popup positioning, since xdg_popups also expect a Widget.

**Entanglement with Ash.** `components/exo/BUILD.gn` asserts `is_chromeos` and `use_ozone`, and depends on `//ash`, `//ash/public/cpp`, `//ash/keyboard/ui`, `//chromeos/ui/frame`, `//chromeos/dbus/power`, `//ui/base/ime/ash`, etc. 36 of 75 `components/exo/*.cc` files include `ash/` headers (175 includes). The protocol and buffer core (`surface.cc`, `buffer.cc`, `surface_tree_host.cc`, `wayland/server.cc`, `zwp_linux_dmabuf.cc`) depends mainly on aura/viz/ui. Shell surfaces, WMHelper, frames, desks, IME and display are Ash-bound. Porting Exo to desktop (non-ChromeOS) Chrome: **large** — stub or replace roughly a dozen Ash services behind `WMHelper`-style interfaces, and fix the `is_chromeos` gates in exo, minigbm and Ozone. The protocol layer itself would port with moderate effort.

## 8. Recommended next step

Decide between two directions:

1. **Keep using linux-chromeos as the host** (fastest path to "web + native apps in one program"): upstream-quality versions of patches A–D, fix AB30 (or stop advertising it) and NV12 (drop the GBM validation), make `--enable-native-gpu-memory-buffers`, `--enable-features=Vulkan` and `use_system_minigbm` the defaults for linux-chromeos, then prototype the SurfaceId-in-a-tab embedding from §7. Weakness: always one extra full composite through X11/Xwayland, and the ChromeOS session baggage (stub login, sync errors, Forest dialog).
2. **Lift Exo's protocol/buffer core into your own compositor or desktop Chrome**, which avoids the double composite (Ash as a Wayland client with delegated compositing is blocked by `assert(is_linux)`). Much more work (§7), but it is the only path to true end-to-end passthrough.

Suggested immediate experiment (about a day): fix the AB30 crash and the NV12 path, then measure GPU time per frame with mpv hwdec under the Vulkan config, to quantify what the extra composite costs on this machine.

## Artefacts
- `~/projects/plutonium/logs/` — Chrome logs per configuration (`cros-exo-*.log`), wayland-info dumps, client `WAYLAND_DEBUG` logs, GPU info JSON.
- `~/projects/plutonium/shots/` — screenshots referenced above.
- `~/projects/plutonium/tools/` — `launch-cros.sh`, `relaunch.sh`, `try-client.sh`, `cdp.py`, `weston-simple.nix` (weston with the demo clients enabled), `dri3test/` (DRI3/GBM probes: `dri3test.c`, `gbmimport.c`, `fmtq.c`).
- `~/projects/plutonium/patches/exo-viability.patch` — all source changes.
- Container `cros-build` is still present (`podman stop cros-build` / `podman rm cros-build` to remove; it holds no unique data).
