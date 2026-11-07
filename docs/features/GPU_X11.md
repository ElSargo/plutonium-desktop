# GPU for apps in X11-hosted sessions

Sessions hosted in Plasma (`:0`) or Xvfb (`:99`) now give apps the GPU, as DRM sessions already did.

## What was wrong

Apps run on the host, not in the container, with the host's Mesa. Mesa finds the GPU through Exo's `zwp_linux_dmabuf_v1` feedback, whose `main_device` names the render node. `launch-cros.sh` (used by `launch-shell.sh` and the T3 and plain shells) started Ash without the viability report's flags. So Exo offered dmabuf v3 with no device, and GL apps quietly fell back to llvmpipe and `wl_shm`. Vulkan apps happened to pick RADV anyway, which is why the fallback only showed up sometimes. The container was not involved: `/dev/dri` works in it.

## The fix, in three parts

1. **`--enable-native-gpu-memory-buffers --enable-features=Vulkan`** (from `VIABILITY_REPORT.md` §5). Exo then sends dmabuf v4 feedback naming `renderD128`.
2. **ANGLE on Vulkan, sharing Skia's device:** `--use-angle=vulkan --enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan`. With step 1 alone, every GL-backed canvas in Ash's own pages broke: WebGL was unavailable, 2D canvases showed a broken-image icon, and T3's terminal was blank. Canvas images need GL and Vulkan to share them:
   - ANGLE on GLX can't import dmabufs (`OzoneImageBackingFactory::IsSupported`: `CanImportNativePixmap false`).
   - ChromeOS builds leave out `ExternalVkImageBackingFactory`, which is `IS_LINUX` only.

   With ANGLE on the same Vulkan device, WebGL and canvases need no sharing at all.
3. **Chromium fix (`gpu/vulkan/vulkan_device_queue.cc`):** `InitializeFromANGLE` never set `drm_device_id_`, so with step 2 Exo fell back to dmabuf v3 again. It now copies it, as `Initialize` does. Patch: Chromium's DRM patch.

What else I tried:

| Flags | Apps | WebGL, canvas | Notes |
|---|---|---|---|
| Old (none) | llvmpipe, shm | ok | Exo: dmabuf v3, no device |
| Vulkan + native GMB | GPU | broken | No shared-image factory for GL users |
| + `--use-angle=gl-egl` | GPU | WebGL ok, canvases still broken | 2D canvases blank |
| `gl-egl` without Vulkan | – | – | `No suitable EGL configs found`, GPU process gives up |
| **ANGLE Vulkan + VulkanFromANGLE + fix** | **GPU** | **ok** | Used now |

## Results with the fix (T3 as the shell on `:0`)

| App | Path | Rate |
|---|---|---|
| weston-simple-egl | dmabuf, feedback names `renderD128` | 180/s |
| vkcube | dmabuf, RADV | 180/s |
| gtk4-demo shadertoy (Vulkan) | dmabuf, RADV | 540 commits/s |
| mpv `--vo=gpu-next` | dmabuf, RADV | 60 (the source) |
| Firefox (animated page) | dmabuf, plus shm for some surfaces | |
| glxgears (X, through xwayland-satellite) | radeonsi | 166 FPS |
| foot | shm (draws on the CPU by design) | |

- WebGL in T3's page and in a Browser-panel tab reports `ANGLE (AMD, Vulkan … RADV)`; tested with a colour-cycling WebGL canvas.
- T3's terminal renders.
- No GPU process exits.
- On Xvfb `:99`, apps get the GPU too: Ash's Vulkan reaches the GPU without DRI3. weston-simple-egl draws via dmabuf at 60/s, and gtk4-demo's Vulkan renderer no longer stalls the display.

## Telling at a glance

The helper asks Exo what a GL client would be told (`helper/src/gpu.ts`, a small Wayland client) once Exo is up, and when an app is launched:
- `GET /v1/status` → `gpu: {dmabufVersion, renderNode, accelerated}`.
- When `accelerated` is false, `plutoniumd: WARNING: … render in software` goes to the helper log.
- `plutonium run` prints `GPU: apps on <socket> render on the GPU` or a warning.

## Caveats

- **X screenshots of `:0` are stale.** `import`/`xwininfo` on KWin's Xwayland no longer see Ash's frames (Vulkan presents by flipping). Use `spectacle -b -n -f -o <file>` with `WAYLAND_DISPLAY=wayland-0`. On Xvfb, `import` still works.
- **Plasma throttles when off screen.** While another VT (e.g. a DRM session on tty2) is active, Ash on `:0` and its apps drop to about 1 frame/s. Measure with Plasma on screen.
- **Hidden windows are throttled** by Ash to a few frames a second (glxgears 4 FPS hidden, 166 shown). That is intended.
- **Still open from the viability report:** 10-bit (AB30) dmabufs crashed the GPU process on X11, NV12 hardware video is rejected, and Plasma composites Ash's window once more. These weren't re-tested with ANGLE on Vulkan.
- `components/exo/surface.cc:674 Client tried place a sub-surface below an invalid reference` is logged thousands of times by some client in this run (not investigated).

## Follow-ups found with games (2026-10-17)

- **Minecraft (SDL 3) failed with "No supported graphics backend".** Exo lacks `wp_fifo_v1`, so SDL 3 picks X (through xwayland-satellite), and Minecraft's GL setup fails there ("Could not retrieve OpenGL functions"). SDL itself makes a GPU context on both X and Wayland. The helper now sets `SDL_VIDEO_DRIVER` and `SDL_VIDEODRIVER` to `wayland,x11` for thread processes. Minecraft runs on Wayland with the GPU (confirmed by the user).
- **Extreme Tux Racer froze the shell's input.** It goes fullscreen while parked (hidden). Parked windows have opacity 0, but Exo still reported the client's opaque region for occlusion, and opaque regions count regardless of opacity. So Ash marked the shell's WebContents occluded: `document.visibilityState` was `hidden`, the page stopped painting and handling input, and only the cursor still changed. Fix: parked windows report no opaque regions (`patches/exo-parked-occlusion.patch`). A/B on `:99` with a hidden `weston-simple-egl -f -o`: the page went `hidden` without the fix and stays `visible` with it.

## Buffers the GPU can't import (2026-10-20)

**What happened.** In X11-hosted sessions (ANGLE on Vulkan), Qt apps such as kwrite draw into `wl_shm` buffers in `XRGB8888`, which Exo makes into `BGRX_8888` shared images. No backing on that GPU path can create `BGRX_8888` from shared memory. A shared image that fails to create makes the GPU process stop the client's whole GPU channel (`SharedImageStub::OnError()`), and that client is the browser: every context was lost, including the display compositor's, and rebuilt. Exo tried the same import again at the app's next commit. So one app stalled the whole display: other windows' snapshots and DevTools screenshots hung. Within a few minutes the Ash log had over 42,000 `Could not find SharedImageBackingFactory … format: BGRX_8888` lines.

**The fix** (Chromium's DRM patch, EXO-IMPORT):
- The GPU process says which 32-bit RGB formats it can import from shared memory (`SharedImageCapabilities::shared_memory_import_formats`). It finds them the way `SharedImageFactory::CreateSharedImage()` does: a backing factory that takes the buffer, or else a GPU backing for a `CompoundImageBacking`.
- Exo checks the list before creating a shared image. An `X` format the GPU can't import is imported as its `A` twin (`BGRX` as `BGRA`). The alpha byte is padding, so the surface counts as opaque (`Buffer::alpha_is_padding()`).
- A format with no importable twin isn't advertised by `wl_shm`. A client that uses it anyway gets a `wl_shm.invalid_format` error at `create_buffer`. Exo doesn't fail again on every commit.
- If something gets past that, `Buffer::Texture::Create()` drops the buffer before it reaches the GPU process, logging once.
- An empty list (a GPU process that doesn't say) changes nothing.

The `EXO-DIAG` logging from the viability work is now `VLOG(1)`. It was `LOG(ERROR)` on hot paths, such as overlay candidates per frame and `IsSupported` checks per shared image. Turn it back on with `--vmodule=*=1` or a narrower pattern.

**Verified** on the slot's Xvfb session, with foot and kwrite in the plain shell: kwrite draws, the page's screenshot returns at once, and the Ash log has none of the errors. kwrite still uses `XRGB8888` (`WAYLAND_DEBUG`).

## The GPU's PCI ids without libpci (2026-11-07)

Chromium learns the GPU's PCI vendor and device ids from ANGLE, which reads them with libpci, `dlopen()`ed (or, failing that, from Vulkan). A host without libpci, such as NixOS (nix-ld has none), left them 0. The GPU list for ChromeOS turns GPU rasterization off for every GPU except a few it names by vendor id (entry 137: Intel, AMD, ...), so with an id of 0 every page was rastered on the CPU: `gpu_compositing` enabled but `rasterization` `unavailable_off` in `SystemInfo.getInfo`, and Charon's overview at 20 to 30 fps on a 180 Hz display.

Where ANGLE finds no GPU or an id of 0, the GPU process now reads the ids from sysfs (`/sys/class/drm/cardN/device/{class,vendor,device,revision}`, display controllers only; the active GPU is the one with `boot_vga`, else the first), before its sandbox starts (patch 0005, `gpu/config/gpu_info_collector_linux.cc`). So neither the release nor the NixOS module needs libpci, a GPL library, which the bundle would otherwise have had to carry.

Checked in an X11 session in the build container with its libpci and Vulkan drivers moved away (so ANGLE could get the ids neither way): the GPU was `0x1002:0x1586` (the Radeon 8060S) and rasterization `enabled`; before, the same set-up gave 0 and `unavailable_off`.

