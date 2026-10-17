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
3. **Chromium fix (`gpu/vulkan/vulkan_device_queue.cc`):** `InitializeFromANGLE` never set `drm_device_id_`, so with step 2 Exo fell back to dmabuf v3 again. It now copies it, as `Initialize` does. Patch: `chromium/patches/0009-*.patch`.

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
