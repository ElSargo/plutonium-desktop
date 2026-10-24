---
name: calc-normal-cdf
model: claude-opus-5-5
timeout: 25
---

# A normal CDF table and line chart in LibreOffice Calc

Native window tools: launching an app, snapshots, typing, keys, clicks, `read_window` and `act_window`, dialogs, window size. From the run of 2026-10-23 (thread `40dc59ce`, fork `51c61577`).

## Prompt

```text
Can you open up LibreOffice, create a new spreadsheet, and fill in a table of index, x = mean + index / 10, and then the normal distribution CDF of x? Use mean = 100 and sd = 16. Then create a line chart of that.

This is a test of the tools in this build. If a tool fails or behaves strangely, tell me exactly what happened. Don't build a workaround for it; carry on with the rest of the task as best you can.
```

## Checks

1. LibreOffice starts with `launch_app` and its window belongs to the thread, on the first or second try.
2. `read_window` and `act_window` work on Calc without crashing it (no core dump in `coredumps.txt`).
3. The chart wizard can be seen and driven: it shows in `snapshot_window` or `read_window`, and keys sent while it's open go to it.
4. `resize_window` gives the size asked for, and the agent can reach the toolbar and menus at the size it works at.
5. The table and the chart are made in the GUI. Falling back to a headless or UNO script is a failure of the GUI path, even if the file comes out right.
6. The values are right: x from mean + index/10, CDF(100) = 0.5.

## Watch for

In the screen recording:

- Menus, context menus and dialogs of the agent's app don't show over the shell or the user's other windows, with the thread focused or not (2026-10-23: a GTK context menu appeared over the shell while the thread wasn't focused).
- The app stays inside its panel at the size it's held at; it doesn't shrink or jump.

## Known issues

- 2026-10-23 (`51c61577`, manual): `libreoffice` isn't on PATH; the Flatpak's window never attached to the thread; the Nix store build sat on its splash screen until `--norestore`. `read_window` crashed Calc twice (`abort()` in `ScAccessibleContextBase::getLocale`). The chart wizard couldn't be seen; blind keys typed "Chart..." into B1 and cancelled it. Tabbing past empty cells skipped a column; clicking the Name Box didn't always select its text. `resize_window` was ignored. The agent made the chart with a headless UNO script. A GTK context menu showed over the shell while the thread wasn't focused (seen by the user).
- 2026-10-24 (run `20261024-115556-calc-normal-cdf`, live): `libreoffice` still not on PATH; `launch_app`'s description gives `["libreoffice", "--writer"]` as its example and no tool launches by desktop id, though the helper can (`/v1/apps/launch`). The Flatpak's soffice.bin had `PLUTONIUM_THREAD_ID` and `WAYLAND_DISPLAY=wayland-plutonium` (no `DISPLAY`), yet no window reached the thread; the logs don't say why (the helper doesn't log launches, Ash doesn't log windows at its level). With an empty tag list from the browser, the helper's pid fallback (`helper/src/daemon.ts:464`) never runs.
