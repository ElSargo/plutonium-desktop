# Handoff: Check viability of Chromium's Exo Wayland server on a Linux desktop

## Goal

Find out whether a **linux-chromeos** build of Chromium (the ChromeOS shell, Ash, running as a normal program on a Linux desktop) can act as a **Wayland compositor for ordinary native Linux apps**, using Chromium's built-in Wayland server, **Exo**. Pay particular attention to whether **zero-copy dmabuf** buffer sharing works.

This is a feasibility check, not a product build. The output is a written report with evidence, not a polished patch set.

## Why (context for decisions along the way)

The long-term idea is a single userland program that manages every surface the user works with: web content and native Wayland apps together, eventually with native apps shown as browser tabs and buffers shared without copies. The user already has a nested Wayland compositor project. ChromeOS already does much of this internally (Exo hosts Linux and Android app windows inside Ash), so the question is how much of it works when Ash runs on a regular desktop.

## What we already know (from reading Chromium `main`, Oct 2026; re-verify against your checkout)

- `docs/chromeos_build_instructions.md` documents linux-chromeos: add `target_os = ['chromeos']` to `.gclient`, `gclient sync`, then build with `target_os="chromeos"`. The whole ChromeOS UI runs in a single X11 window; most system services are stubbed.
- `chrome/browser/exo_parts.cc`: the Wayland server is only created if the `--enable-wayland-server` switch is present (`ash::switches::kAshEnableWaylandServer`).
- `components/exo/wayland/server.cc`:
  - Socket is `$XDG_RUNTIME_DIR/wayland-0` by default; override with `--wayland-server-socket=<name>` (comment says it's for when another Wayland server already uses the default). The host desktop owns `wayland-0`, so **always pass this flag**.
  - Has a branch explicitly for "debugging chromeos-chrome on linux platform".
  - Registers `wl_compositor`, `wl_shm`, `wl_subcompositor`, `wl_seat`, `wl_data_device_manager`, `xdg_wm_base` (v3), viewporter, presentation-time, fractional-scale, pointer constraints/gestures, relative pointer, text-input, xdg-decoration, idle-inhibit, plus Chromium-specific `zaura_shell` and others.
  - `zwp_linux_dmabuf_v1` is **only registered if** `WaylandDmabufFeedbackManager::GetVersionSupportedByPlatform() > 0`. Whether that's true under linux-chromeos on X11 is the key unknown.
- Nobody has been confirmed to run this end to end. Treat every assumption as unverified until tested.

## Ground rules

- **Ask the user before** running anything with `sudo` (e.g. `build/install-build-deps.sh`, distro package installs), and before deleting anything outside the Chromium checkout.
- Don't touch the user's existing compositor project or desktop config.
- Keep all Chromium source edits on a local branch (e.g. `exo-viability`). Prefer investigation and logging over patches; small diagnostic patches are fine if clearly noted in the report.
- Record exact commands, Chromium revision, and outputs as you go. The report is the deliverable.
- If a phase fails, capture the failure, attempt reasonable fixes, and if still blocked, write it up and continue with whatever later phases are still possible.

## Phase 0 — Machine check

Record:
- Distro and version, kernel, CPU cores, RAM, free disk on the target drive (need ~150 GB+).
- GPU and driver (`glxinfo -B` or `eglinfo`), Mesa version.
- Session type (`echo $XDG_SESSION_TYPE`), whether Xwayland is available (linux-chromeos is an X11 window), and `$XDG_RUNTIME_DIR`.
- Whether `depot_tools` is installed and on `PATH`; if not, install it in the user's home (no sudo needed): `git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git`.

## Phase 1 — Checkout

Follow `docs/linux/build_instructions.md` for a fresh checkout. Reasonable defaults:

```
mkdir -p ~/chromium && cd ~/chromium
fetch --nohooks --no-history chromium
```

Edit `~/chromium/.gclient` and add:

```
target_os = ['chromeos']
```

Then (ask before the sudo step):

```
cd src
./build/install-build-deps.sh      # needs sudo — ask the user first
gclient sync
gclient runhooks
```

Record the commit hash (`git rev-parse HEAD`).

## Phase 2 — Build

```
gn gen out/Cros --args='target_os="chromeos" is_component_build=true is_debug=false dcheck_always_on=true symbol_level=1'
autoninja -C out/Cros chrome
```

Note build time. If the build fails, capture the first real error, not the tail.

## Phase 3 — Launch with Exo enabled

```
out/Cros/chrome \
  --enable-wayland-server \
  --wayland-server-socket=wayland-cros \
  --use-system-clipboard \
  --user-data-dir=/tmp/cros-exo-test \
  --enable-logging=stderr --v=0 2>&1 | tee /tmp/cros-exo.log
```

Check:
- Does the ChromeOS UI appear in a window and reach a usable desktop (stub user login is default)?
- Does `$XDG_RUNTIME_DIR/wayland-cros` exist? Any `libwayland:` or Exo errors in the log?
- If the window paints nothing, try the graphics fallbacks from the docs: `--ui-enable-software-compositing --ui-disable-threaded-compositing`, or `--use-gl=angle --use-angle=swiftshader`. Note which one was needed, since software paths affect the dmabuf question.

## Phase 4 — Probe the server

Install `wayland-utils` if missing (ask first if sudo is needed), then:

```
WAYLAND_DISPLAY=wayland-cros wayland-info > /tmp/exo-wayland-info.txt
```

Record:
- Full list of globals and versions.
- **Whether `zwp_linux_dmabuf_v1` is present**, its version, and the advertised formats/modifiers (and the main device, if feedback is supported).
- `xdg_wm_base` version.

## Phase 5 — Run real clients

Try each with `WAYLAND_DISPLAY=wayland-cros`. For failures, rerun with `WAYLAND_DEBUG=1` and save the tail of the log.

| Client | Purpose |
|---|---|
| `weston-simple-shm` | Basic shm path |
| `weston-simple-egl` | EGL / GPU-rendered client |
| `weston-simple-dmabuf-egl` (or `weston-simple-dmabuf-feedback`) | Explicit dmabuf path |
| `foot` or another native Wayland terminal | Real app: keyboard input, resize |
| A GTK4 app (e.g. `gtk4-demo`) with `GDK_BACKEND=wayland` | Toolkit compatibility, popups/menus |
| A Qt app with `QT_QPA_PLATFORM=wayland` | Second toolkit |
| A video player like `mpv --vo=gpu --gpu-context=wayland` (optional) | Sustained frame delivery |

The weston demo clients may not be packaged on every distro; if missing, build them from the weston source (they don't need a weston install to run against another compositor).

For each client record:
- Does it connect?
- Does a window appear?
- Do keyboard and mouse input work?
- Do resize and close work?
- Do popups/menus position correctly?
- Do HiDPI/fractional scale look right?
- Any obvious visual problems?

## Phase 6 — Zero-copy investigation

This is the most important question.

1. If `zwp_linux_dmabuf_v1` was **not** advertised: read `components/exo/wayland/wayland_dmabuf_feedback_manager.cc` and related code to find what `GetVersionSupportedByPlatform()` depends on, and why it returns 0 here. Is it X11/Ozone platform support, GL backend, a feature flag, or a `IS_CHROMEOS_DEVICE`-style build condition? Check whether any flag or gn arg enables it, and whether linux-chromeos can run with a different Ozone platform (e.g. `--ozone-platform=wayland`, so Ash itself runs as a Wayland client of the host). Estimate how big a patch would be needed.
2. If it **was** advertised: confirm a dmabuf client actually renders, and trace (via logs or a brief diagnostic) whether the buffer is imported on the GPU side as a native pixmap/SharedImage rather than copied. Note any format/modifier mismatches.
3. Either way, briefly check whether Ash/Viz on this build can pass client buffers through to the host compositor (delegated compositing / overlays) or always composites them itself.

## Phase 7 — Quick look ahead (time-boxed, read-only)

Spend a short time reading code to answer, at a high level:
- Where do Exo toplevels become Ash windows (`ShellSurface` / `xdg_shell` handling, `WMHelper`)? What would it take to host one inside a browser tab instead of a top-level Ash window?
- How entangled is Exo with Ash (key dependencies), in case the user later wants Exo in a non-ChromeOS desktop Chrome build?

No implementation, just pointers to the relevant files and a rough difficulty estimate.

## Deliverable

Write `VIABILITY_REPORT.md` in the checkout root (outside `src/` or on the branch — either is fine), containing:

1. **Verdict up front**: works / partly works / doesn't work, in two or three sentences.
2. Environment (machine, distro, GPU, Chromium revision, gn args, launch flags used).
3. Results per phase, with key log excerpts.
4. Client compatibility table from Phase 5.
5. Zero-copy findings: advertised or not, why, and the estimated work to make it work.
6. Phase 7 pointers.
7. Recommended next step.

Keep it factual; mark guesses as guesses.
