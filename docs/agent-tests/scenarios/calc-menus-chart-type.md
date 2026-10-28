---
name: calc-menus-chart-type
model: claude-opus-5-5
timeout: 25
---

# Menus, a changed chart type and an unsaved close in LibreOffice Calc

Native window tools on paths `calc-normal-cdf` never reached (backlog "Agent tool paths no run has reached yet", 2026-10-28): a menu and its submenu (a hover), `act_window` `select` on the chart wizard's type list, a ref the wizard replaced (a stale ref), and the untitled "Save Document?" box. Run it twice: once with `--show` (the user watching the thread, so the panel shows the window) and once without (the window shown nowhere).

## Prompt

```text
Open LibreOffice Calc with a new spreadsheet. In A1:B7 put a small table: a header row "Month" and "Sales", then Jan to Jun with sales 120, 95, 140, 80, 160 and 110. Make the header row bold using the Format menu (not a keyboard shortcut or the toolbar). Then insert a chart of the table from the Insert menu. In the chart wizard pick a Pie chart first, then change your mind, pick Bar instead, and finish the wizard. Finally close the document without saving it.

This is a test of the tools in this build. If a tool fails or behaves strangely, tell me exactly what happened. Don't build a workaround for it; carry on with the rest of the task as best you can. Don't stop to ask me anything (nobody is watching); make a sensible choice and say what you chose.
```

## Checks

1. The Format menu and its Text submenu are opened in the GUI and seen: the menu shows in a snapshot, or the action's `popups`, and the submenu opens by hovering or clicking its parent item. Bold is picked from the submenu, and A1:B1 end up bold.
2. Insert ▸ Chart opens the wizard, named in an action's `newWindows`.
3. Pie, then Bar, are chosen in the wizard's chart type list, by `act_window` `select` (or a click); the wizard shows each type's subtypes after. A ref read before the change (a subtype of Pie) used after it gets a clear "is gone" answer, not an empty outline or a wrong element.
4. The chart is a bar chart of B2:B7.
5. Closing the untitled document brings up "Save Document?"; the agent sees it (`newWindows`, `list_windows` or `read_window` on it) and picks Don't Save, and the window closes (`closedWindows`).
6. No core dump (`coredumps.txt`) and nothing left running (`leftover.txt`).

## Watch for

On the screen frames:

- Shown (`--show`): the menus and the wizard show at the panel, over the window, where the snapshots have them.
- Hidden: no menu, wizard or "Save Document?" box shows anywhere on screen, over the shell or another window.

## Known issues

- 2026-10-28 (run `20261028-231956-calc-menus-chart-type`, X11 slot 26, hidden): the task done, all in the GUI; no core dump. Format ▸ Text ▸ Bold and Insert ▸ Chart by clicks, the menus in the results' `popups`, nothing on screen. Two helper bugs: the chart wizard, opened 20 s after `launch_app`, was held at the main window's 1280×800 (`holdLate` held every new window for 60 s after a launch); `close_window` waited its 3 s and said `{closed: false}`, not naming the "Save Document?" box it opened (the agent found it with `list_windows`). Not reached: a hover (LibreOffice opens a submenu on click too), `act_window` `select` (Pie and Bar clicked), a stale ref.
- 2026-10-28 (run `20261028-232600-calc-menus-chart-type`, the fixes): the wizard at its own size; `close_window` answered in 0.4 s with `newWindows: ["new window #4 (\"Save Document?\", 506×198)"]`, and the agent answered it with `act_window`. `--show` didn't take (run.sh's `--x11` used the DRM DevTools port; fixed), so the shown case is still unrun. Not reached, as before: a hover, `select`, a stale ref. Insert ▸ Chart's wizard takes longer than an action's 250 ms wait, so it's named by the next call, not the click.
- 2026-10-29 (run `20261029-001347-calc-menus-chart-type`, `--show`): every step worked, no errors, no core dump; the fixes held (the wizard at its own size, `close_window` naming "Save Document?"). `--show` shows the thread, not its window: the window stayed `shown: false` (no `focus_window`, no panel on it), and no menu showed on screen, which is right for a hidden window. So the window-shown case needs someone to open the window in the panel while it runs (as `tab-narrow-panel` opens the side panel); still unrun. Not reached, a third time: a hover, `select`, a stale ref (the agent clicks Pie and Bar by their points; LibreOffice opens submenus on click).
