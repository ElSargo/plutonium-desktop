# Plutonium's Chromium

Plutonium is a set of patches on Chromium's ChromeOS shell (Ash) and its Wayland server (Exo), built as a Linux ChromeOS (`target_os = "chromeos"`) that runs on an ordinary Linux machine.

- **`BASE`**: the upstream commit the patches apply to. It is `9f2eedcd653d` (2026-10-14, Chrome 158.0.8106.0).
- **`patches/`**: the patch series, in order (`git am`). Together they change 251 files (about 20,900 lines).
- **`args.gn`**: the build arguments.

`plutonium chromium fetch` checks out `BASE`, `plutonium chromium patch` applies the series on a branch `plutonium`, and `plutonium chromium build` builds `chrome`. See [docs/BUILDING.md](../docs/BUILDING.md).

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
| 0017 | The page alone sizes an embedded window: its maximize, minimize, move and resize requests are refused, and Ash's changes undone | [features/WINDOW_SIZING](../docs/features/WINDOW_SIZING.md) |
| 0018 | `object-fit` for `<native-window>`; `crossfade`, the resize cross-fade | [features/WINDOW_SIZING](../docs/features/WINDOW_SIZING.md) |
| 0019 | `windowrequest` events; which element drives a window several show | [features/WINDOW_SIZING](../docs/features/WINDOW_SIZING.md) |
| 0020 | The box is where the window is (the app's frame stretched to it until it answers a resize); `crossfade-easing`, and niri's cross-fade; no fade on a window's first size | [features/WINDOW_SIZING](../docs/features/WINDOW_SIZING.md) |
| 0021 | Seat management through logind (`--plutonium-logind-session`): devices from `TakeDevice`, given up and taken back across VT switches; Ctrl+Alt+F1…F12 and Ctrl+Alt+Backspace | [features/SEAT](../docs/features/SEAT.md) |
| 0022 | Chrome's own UI in the shell: docked DevTools for shell pages, a tab's DevTools as a tab, context menus without browser-window items drawn by the shell (`contextmenurequest`), only DevTools and clipboard commands in shell windows, keys in tabs, only hardware keys of Ash's accelerators, no status bubble | [features/CHROME_UI](../docs/features/CHROME_UI.md) |
| 0023 | The switcher: Super+Tab's sidebar of shells over windows and tabs, with a page for each (shell status and management, a window's shells, snapshot and details); `EmbeddedWindows::Present()` opens a window fullscreen above every shell (EXO-PRESENT); the backup terminal and browser; launching a desktop app through the helper's socket (`--plutonium-helper-url`, `--plutonium-helper-socket`) | [features/SHELLS](../docs/features/SHELLS.md) |
| 0024 | Google sign-in works: shell mode turns off Mirror account consistency (EXO-SIGNIN), so Gaia's sign-in pages aren't cancelled for an OS "Add account" dialog Plutonium doesn't have. Tabs open fullscreen from the switcher, the tab's own page in an Ash window (`PlutoniumTabs::Present()`, `PlutoniumTabPresenter`) | [features/SHELLS](../docs/features/SHELLS.md) |
| 0025 | Agents drive windows and tabs (EXO-AGENT): the `Plutonium` DevTools domain on the browser target, for trusted clients only (lists and events, `createTab`, `captureTab`, `captureWindow`, window mouse and keys, `setTabAwake`, `setWindowAwake`, window screencasts); `EmbeddedWindows::InjectMouseEvent()`, `InjectKeyEvents()` (`Seat::DispatchAgentKeyEvent()`), `KeepDrawing()` (frames without the undrawn throttle) | [features/AGENT_CONTROL](../docs/features/AGENT_CONTROL.md) |
| 0026 | A tab's context menu item runs with the tab focused: the shell had the keyboard while it showed the menu, so spelling suggestions, paste, cut, undo and select all did nothing (`SurfaceEmbedConnector::FocusInnerWebContents`) | [features/CHROME_UI](../docs/features/CHROME_UI.md) |
| 0027 | Agent keyboard focus beside the user's (EXO-AGENT): a client focuses the window an agent drives while the user's focus is in another app (`Seat::AddAgentFocus()`), held between calls (`EmbeddedWindows::HoldAgentFocus()`, `Plutonium.setWindowAgentFocus`). The compositor decorates every window (EXO-DECOR): xdg-decoration always answers server side, and KDE's server-decoration protocol (for GTK 3) always answers server | [features/AGENT_CONTROL](../docs/features/AGENT_CONTROL.md) |
| 0028 | Shared-memory buffers the GPU can't import don't stall the display (EXO-IMPORT): the GPU process reports which formats it can import (`SharedImageCapabilities::shared_memory_import_formats`), `wl_shm` imports an X format it can't as its A twin and refuses a format with no twin (`invalid_format`), and Exo never sends an unimportable one (which stopped the browser's GPU channel on every commit). The `EXO-DIAG` logging is `VLOG(1)` | [features/GPU_X11](../docs/features/GPU_X11.md) |
| 0029 | A drag that ends outside an embedded window sends `wl_pointer.leave` with the release, not at the next move | [features/CONTROLS](../docs/features/CONTROLS.md) |
| 0030 | Embedded focus follows modal dialogs (EXO-MODAL): `xdg_wm_dialog_v1`, and while a page shows a window's modal dialog, focus on the window goes to the dialog, and back when it closes | [features/CONTROLS](../docs/features/CONTROLS.md) |
| 0031 | Broker follow-ups (EXO-BROKER): a `grantrevoked` event for the shell's own grants, removing the last listener of a kind of broker event unsubscribes, `new NativeWindowEvent(type, init)`. The broker tells observers one event at a time (`revokeGrant()` crashed dev builds on a re-entrant observer list) | [features/BROKER](../docs/features/BROKER.md) |
| 0032 | Unit tests for the broker and grant checks: `plutonium_unittests` (its own target), and the input router's foreign-sink checks in `content_unittests` | [features/BROKER](../docs/features/BROKER.md) |
| 0033 | A logind session started on a VT that isn't in front: the displays wait for the session to be in front (`DrmDisplayHostManager::AddDelegate()` revokes display control), and the first real configuration is the one on resume. Input devices aren't asked of logind meanwhile | [features/SEAT](../docs/features/SEAT.md) |

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
