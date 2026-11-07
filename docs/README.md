# Docs

**Start here**
- [../INSTALL.md](../INSTALL.md): installing, first sessions, troubleshooting
- [BUILDING.md](BUILDING.md): building Chromium from source
- [USING.md](USING.md): keys, shells, threads, agents, writing a shell
- [ARCHITECTURE.md](ARCHITECTURE.md): how the pieces fit
- [DEVELOPING.md](DEVELOPING.md): changing Chromium, the helper and the shells; testing sessions
- [BACKLOG.md](BACKLOG.md): what isn't done

**Features.** Each doc covers what the feature does, how it works, and what was verified on the panel.
- [features/TABS.md](features/TABS.md): browser tabs as elements
- [features/CONTROLS.md](features/CONTROLS.md): fullscreen, shell shortcuts, pointer capture, the app launcher
- [features/KEYS.md](features/KEYS.md): design: one keymap for every shell and the browser, contexts, chords and modes, the `config.js` script
- [features/SHELLS.md](features/SHELLS.md): several shells, tags and groups, the Super+Tab overlay
- [features/STYX_SHELL.md](features/STYX_SHELL.md): Styx, the scrollable tiling shell; keyboard, touchpad and scrolling fixes
- [features/UI_LIBRARY.md](features/UI_LIBRARY.md): the shells' UI library: the dock, keys, settings, dragging and widgets Styx, Charon and the plain shell share
- [features/DRAG_AND_DROP.md](features/DRAG_AND_DROP.md): drag and drop between apps, tabs and pages
- [features/WINDOW_SIZING.md](features/WINDOW_SIZING.md): who sizes a window, object-fit, the resize cross-fade, windowrequest
- [features/OPENING_LINKS.md](features/OPENING_LINKS.md): links and files open in their thread
- [features/GPU_X11.md](features/GPU_X11.md): the GPU path for apps
- [features/SEAT.md](features/SEAT.md): DRM sessions through logind: starting, stopping, switching VTs
- [features/CAPTURE.md](features/CAPTURE.md): screenshots, screen sharing and recording
- [features/PASSWORDS.md](features/PASSWORDS.md): a password manager adapter for apps, tabs and agents (design, not built)
- [features/TAB_FEATURES.md](features/TAB_FEATURES.md): find, zoom, printing, permission prompts, downloads, file pickers for tabs, through the shell (built; autofill not)
- [features/FILE_MANAGER.md](features/FILE_MANAGER.md): Hydra's file manager and picker: tree, columns and grid, Yazi's keys, fuzzy finding, drag and drop in and out, and carrying files with no mouse.
- [features/REMOTE_WINDOWS.md](features/REMOTE_WINDOWS.md): native windows for Hydra (T3 Code) clients away from the desktop, streamed by the server
- [features/MULTI_MONITOR.md](features/MULTI_MONITOR.md): a shell per display, and what moves between them
- [features/CHARON_SHELL.md](features/CHARON_SHELL.md): Charon, the floating shell, with workspaces as threads
- [features/SHELL_PACKAGES.md](features/SHELL_PACKAGES.md): shells as installed packages, edited safely and rolled back
- [features/HYDRA_DOCK.md](features/HYDRA_DOCK.md): Hydra's dock of apps, sites and terminals
- [features/AGENT_CONTROL.md](features/AGENT_CONTROL.md): how agents see and drive apps and tabs
- [features/APPEARANCE.md](features/APPEARANCE.md): light or dark for the whole desktop: shells, tabs, GTK and Qt apps
- [features/DESKTOP_SERVICES.md](features/DESKTOP_SERVICES.md): what a shell gets from the desktop: notifications, audio, power, network
- [features/IME.md](features/IME.md): input methods

**History.** These are the reports as they were written, in order. Their commands and paths refer to the original research repository: `tools/launch-*.sh` is now `plutonium run`, `patches/exo-*.patch` is now `chromium/patches/`, and `shell/` and `shell-niri/` are now `shells/`.
1. [history/exo-viability-handoff.md](history/exo-viability-handoff.md): the brief
2. [history/VIABILITY_REPORT.md](history/VIABILITY_REPORT.md): Exo hosting Linux apps; the dmabuf fixes
3. [history/TTY_REPORT.md](history/TTY_REPORT.md): Ash straight on DRM
4. [history/EMBED_SPIKE_V0.md](history/EMBED_SPIKE_V0.md): the first native window in a page
5. [history/OPTION2_PLAN.md](history/OPTION2_PLAN.md): the plan and roadmap
6. [history/PHASE1_REPORT.md](history/PHASE1_REPORT.md), [PHASE1_PROGRESS.md](history/PHASE1_PROGRESS.md): `<native-window>`
7. [history/PHASE2_REPORT.md](history/PHASE2_REPORT.md), [PHASE2_PROGRESS.md](history/PHASE2_PROGRESS.md): the broker and the security model
8. [history/T3_SHELL_TEST.md](history/T3_SHELL_TEST.md): T3 Code as the first frontend
9. [history/PHASE3_REPORT.md](history/PHASE3_REPORT.md): the helper, the agent bridge, the plain shell
10. [history/PHASE4_PROGRESS.md](history/PHASE4_PROGRESS.md): shell mode on DRM, input, display planes
