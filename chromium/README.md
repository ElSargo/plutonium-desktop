# Plutonium's Chromium

Plutonium is a set of patches on Chromium's ChromeOS shell (Ash) and its Wayland server (Exo), built as a Linux ChromeOS (`target_os = "chromeos"`) that runs on an ordinary Linux machine.

- **`BASE`**: the upstream commit the patches apply to. It is `9f2eedcd653d` (2026-10-14, Chrome 158.0.8106.0).
- **`patches/`**: the patch series, in order (`git am`). Together they change 372 files (about 42,600 lines, almost all of it new files).
- **`args.gn`**: the build arguments.

`plutonium chromium fetch` checks out `BASE`, `plutonium chromium patch` applies the series on a branch `plutonium`, and `plutonium chromium build` builds `chrome`. See [docs/BUILDING.md](../docs/BUILDING.md).

## The patches

One patch per part of Plutonium. Each holds every change to its own files, so no two patches touch the same file: they apply in any order, but build only together (`chrome/browser/BUILD.gn`, in the first, lists every part's sources). Each patch's message lists the changes it holds.

| # | Part | What | Docs |
|---|---|---|---|
| 0001 | The shell page and the window broker, in the browser | The shell page (`--plutonium-shell-origin`, `--plutonium-shell-url`) and what makes it the desktop: the window broker and its grants, the embedder that puts Exo's windows in the page, several shells, tags and groups, the keys the shell takes | [BROKER](../docs/features/BROKER.md), [SHELLS](../docs/features/SHELLS.md) |
| 0002 | Exo: embedded windows | Windows parked off the desktop until a page shows them, the page alone sizing them, focus, keyboard and pointer for embedded windows (pointer lock, modal dialogs, popups), drag and drop, input methods, window icons | [WINDOW_SIZING](../docs/features/WINDOW_SIZING.md), [CONTROLS](../docs/features/CONTROLS.md), [DRAG_AND_DROP](../docs/features/DRAG_AND_DROP.md) |
| 0003 | Embedded surfaces | SurfaceEmbed, and input routing and viz hit testing for the surfaces a page embeds | [TABS](../docs/features/TABS.md) |
| 0004 | The shell page's API | `<native-window>` (its layout, `object-fit`, the cross-fade), `navigator.windowBroker`, and the events and entries for windows, tabs, displays, captures, downloads and context menus | [BROKER](../docs/features/BROKER.md), [WINDOW_SIZING](../docs/features/WINDOW_SIZING.md) |
| 0005 | DRM | Shell mode on the display hardware: the display-plane path, logind seats (also on a VT that isn't in front), evdev and libinput, touchpad swipes, and the GPU details (Vulkan device ids, shm buffers the GPU can't import) | [SEAT](../docs/features/SEAT.md), [GPU_X11](../docs/features/GPU_X11.md) |
| 0006 | Ash in shell mode | Ash's accelerators and gestures go to the shell; no toasts, nudges or clipboard history | [CHROME_UI](../docs/features/CHROME_UI.md) |
| 0007 | The switcher | Super+Tab's overlay: shells, windows and tabs, installed shells, a prompt for the user's agent, the backup terminal, desktop settings and display configuration | [SHELLS](../docs/features/SHELLS.md), [MULTI_MONITOR](../docs/features/MULTI_MONITOR.md) |
| 0008 | Browser tabs | Real Chromium tabs as elements of the shell page: opening, driving and restoring them, incognito tabs, fullscreen, their requests to the shell | [TABS](../docs/features/TABS.md) |
| 0009 | Tab features | Permission prompts and per-thread grants, downloads, file pickers, printing, zoom, find in page, context menus, MPRIS media sessions, speechSynthesis voices; pages see Linux | [TAB_FEATURES](../docs/features/TAB_FEATURES.md), [CHROME_UI](../docs/features/CHROME_UI.md), [LINUX_COMPAT](../docs/features/LINUX_COMPAT.md) |
| 0010 | The Plutonium DevTools domain | `Plutonium` on the browser target (`cros_protocol.pdl`), for the helper and its agents: windows, tabs, input, notifications, media, the hardware keys. DevTools on a Unix socket for this user only (`--plutonium-remote-debugging-socket`) | [AGENT_CONTROL](../docs/features/AGENT_CONTROL.md), [DESKTOP_SERVICES](../docs/features/DESKTOP_SERVICES.md) |
| 0011 | Screen capture | Capture requests to the focused shell, `getDisplayMedia`, PipeWire video nodes (with dmabufs), window captures from the window's own frames, `ext-image-copy-capture-v1` for grim | [CAPTURE](../docs/features/CAPTURE.md) |
| 0012 | Wayland protocols | `zwp_text_input_v3`, `xdg_activation_v1`, `wp_cursor_shape_v1`, `ext_idle_notify_v1`, `ext_data_control_v1`, server-side decorations | [WAYLAND_PROTOCOLS](../docs/features/WAYLAND_PROTOCOLS.md), [IME](../docs/features/IME.md) |
| 0013 | The lock screen and idle | Ash's lock over every display (Super+L), idle and inhibitors | [DESKTOP_SERVICES](../docs/features/DESKTOP_SERVICES.md) |

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
use_libinput = true         # touchpads on DRM (features/STYX_SHELL)
```

A first build takes about two hours on 32 threads, and incremental builds take seconds to minutes.

**Release build** (`args.release.gn`, `plutonium chromium build --release`, into `out/Release`): the same features, as one self-contained `chrome` with no assertions or symbols. It took 1 h 22 min on 32 threads (68,749 steps). `plutonium host build` and the release bundle stage it the same way:
- what Chrome's Linux installer ships (`chrome/installer/linux/common/installer.py`), plus every top-level `.pak`, `.bin` and `.dat`, `locales/` and `resources/`;
- the binaries, stripped: 607 MB in all;
- Chromium's license notices (`LICENSES.chromium.html`).

**Official build** (`args.official.gn`, `plutonium chromium build --official`, into `out/Official`): the release build optimized the way Google ships Chrome, for a published tarball (`plutonium bundle build` takes chrome from it). It turns on `is_official_build` and ThinLTO (which gn leaves off for a non-device ChromeOS build) and uses ChromeOS's AFDO sample profile for big x86 cores. Chrome's Linux PGO profile is for a different binary, and CFI is off, since a bad cast in a patch would take the session down.

## Changing Chromium

See [docs/DEVELOPING.md](../docs/DEVELOPING.md):
1. Commit your work on the `plutonium` branch of the checkout.
2. Run `plutonium chromium export` to rewrite `patches/` from the commits since `BASE`.
3. Keep one patch per part. A change goes into the commit that owns its files: `git commit --fixup=<that commit>`, then `git rebase -i --autosquash <BASE>`. Each part has its own files, so the fixups always apply. Split a change that touches several parts into one fixup per part, and put a new file in the part it belongs to. A new commit of its own becomes a new patch. That's fine while you work, but fold it in before a release.
