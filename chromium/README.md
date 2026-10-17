# Plutonium's Chromium

Plutonium is a set of patches on Chromium's ChromeOS shell (Ash) and its Wayland server (Exo), built as a Linux ChromeOS (`target_os = "chromeos"`) that runs on an ordinary Linux machine.

- **`BASE`**: the upstream commit the patches apply to. It is `9f2eedcd653d` (2026-10-14, Chrome 158.0.8106.0).
- **`patches/`**: the patch series, in order (`git am`). Together they change 171 files (about 11,800 lines).
- **`args.gn`**: the build arguments.

`plutonium chromium fetch` checks out `BASE`, `plutonium chromium patch` applies the series on a branch `plutonium`, and `plutonium chromium build` builds `chrome`. See [INSTALL.md](../INSTALL.md).

## The patches

| # | What | Docs |
|---|---|---|
| 0001 | `<native-window>`: Exo windows embedded in a page as elements; the window broker (`navigator.windowBroker`), grants, and the shell origin (`--plutonium-shell-origin`) | [history/PHASE1_REPORT](../docs/history/PHASE1_REPORT.md), [PHASE2_REPORT](../docs/history/PHASE2_REPORT.md) |
| 0002 | The broker reports each window's Wayland client pid | [ARCHITECTURE](../docs/ARCHITECTURE.md) |
| 0003 | `windowBroker.showOnDesktop()`: pop an embedded window out | |
| 0004 | Windows stay off the Ash desktop unless popped out (`--plutonium-hide-windows`); `wl_output` v4 | [history/T3_SHELL_TEST](../docs/history/T3_SHELL_TEST.md) |
| 0005 | `windowBroker.close()` and `snapshot()`, for the agent bridge | [history/PHASE3_REPORT](../docs/history/PHASE3_REPORT.md) |
| 0006 | Shell mode (`--plutonium-shell-url`): the page is the whole desktop on DRM; evdev input fix; the display-plane path | [history/PHASE4_PROGRESS](../docs/history/PHASE4_PROGRESS.md) |
| 0007 | Browser tabs as elements (SurfaceEmbed), the tab registry and broker API; mouse wheel on DRM | [features/TABS](../docs/features/TABS.md) |
| 0008 | Tab automation over DevTools (`sendTabDevToolsCommand`); SurfaceEmbed under transforms | [features/TABS](../docs/features/TABS.md) |
| 0009 | The DRM device id for a Vulkan device shared with ANGLE (GPU for apps in X11-hosted sessions) | [features/GPU_X11](../docs/features/GPU_X11.md) |
| 0010 | Parked (hidden) windows don't occlude the shell page | [features/GPU_X11](../docs/features/GPU_X11.md) |
| 0011 | Fullscreen for embedded apps and tabs, Super+F; shell shortcuts | [features/CONTROLS](../docs/features/CONTROLS.md) |
| 0012 | Pointer lock and confinement for embedded apps, Super+Escape | [features/CONTROLS](../docs/features/CONTROLS.md) |
| 0013 | Several live shells (`--plutonium-shells`), Super+Tab | [features/SHELLS](../docs/features/SHELLS.md) |
| 0014 | Tags and groups on windows and tabs; the Super+Tab overlay | [features/SHELLS](../docs/features/SHELLS.md) |
| 0015 | Overlay fix: no empty "Shells" heading | |
| 0016 | Shell shortcuts beat Ash's accelerators; no Search+arrow rewriting; transparent gutter; touchpads through libinput and scrolling fixes; drag and drop; links from shell pages open as tabs | [features/NIRI_SHELL](../docs/features/NIRI_SHELL.md), [DRAG_AND_DROP](../docs/features/DRAG_AND_DROP.md), [OPENING_LINKS](../docs/features/OPENING_LINKS.md) |
| 0017 | The page alone sizes an embedded window: its maximize, minimize, move and resize requests are refused, and Ash's changes undone | [ARCHITECTURE](../docs/ARCHITECTURE.md) |

Where to look in the tree:
- **Exo:** `components/exo/` (`embedded_windows.*`, data device and drag and drop).
- **The broker, shell and tabs:** `chrome/browser/` (`exo_window_broker.*`, `exo_embedder.cc`, `plutonium_*`).
- **The elements and `navigator.windowBroker`:** Blink (`third_party/blink/renderer/core/html/`, `public/mojom/native_window/`).
- **Shell mode, several shells and the overlay:** `chrome/browser/ui/ash/main_extra_parts/`.

## Build arguments

```
target_os = "chromeos"      # Ash and Exo, as a Linux binary
is_component_build = true   # fast incremental builds
is_debug = false
dcheck_always_on = true
symbol_level = 1
use_system_minigbm = true   # the host's GBM: dmabuf import works (history/VIABILITY_REPORT §5)
use_libinput = true         # touchpads on DRM (features/NIRI_SHELL)
```

A first build takes about two hours on 32 threads, and incremental builds take seconds to minutes.

**Release build** (`args.release.gn`, `plutonium chromium build --release`, into `out/Release`): the same features, as one self-contained `chrome` with no assertions or symbols. It took 1 h 22 min on 32 threads (68,749 steps). `plutonium image build` stages it into the prebuilt image:
- what Chrome's Linux installer ships (`chrome/installer/linux/common/installer.py`), plus every top-level `.pak`, `.bin` and `.dat`, `locales/` and `resources/`;
- the binaries, stripped: 607 MB in all;
- Chromium's license notices (`LICENSES.chromium.html`).

Google's "official" build (`is_official_build`, with LTO and PGO profiles) isn't used. It's much heavier to build and needs `checkout_pgo_profiles` in `.gclient`.

## Changing Chromium

See [docs/DEVELOPING.md](../docs/DEVELOPING.md):
1. Commit your work on the `plutonium` branch of the checkout.
2. Run `plutonium chromium export` to rewrite `patches/` from the commits since `BASE`.
