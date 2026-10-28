# calc-menus-chart-type: 2026-10-28 (X11 session, slot 26, main a927a6e, claude-opus-5-5)

Run `logs/agent-tests/20261028-231956-calc-menus-chart-type`, thread `mcp:af91a9ff`: completed after 1.8 min; window hidden. Written by the backlog worker that ran it (agent-scenarios), not a separate reviewer: checked against `timeline.txt` and the screen frames. (`run.sh` stopped after the thread ended, from a bug in its new `--x11` mode, since fixed; the timeline and logs were gathered by hand.)

## Verdict

| Check | Result | Evidence |
|---|---|---|
| 1. Format ▸ Text ▸ Bold through the menus | pass | +21.5 click Format: `popups` 1; +25.2 click Text: 2 popups (submenu by click, no hover); +27.7 Bold: `"closed"`. Headers bold in the snapshot at +48.3. |
| 2. Insert ▸ Chart opens the wizard, in `newWindows` | partial | The click at +34.0 returned only `popups: "closed"`; the wizard (#3) was slower than the 250 ms wait and was named by `list_windows` at +35.6. |
| 3. Pie then Bar; a stale ref | pass / not reached | Picked by `click_window` (+42.9, +45.4), not `select`; no stale ref. |
| 4. A bar chart | pass | Snapshot at +48.3. |
| 5. "Save Document?" seen and answered | **fail → fixed** | `close_window` at +69.2: 3 s, `{closed: false}`, no `newWindows`; the agent found #4 with `list_windows` (+88.6), read it and clicked Don't Save by `act_window` (+98.0, both windows closed). |
| 6. No core dump | pass | none. |
| Watch: hidden, nothing on screen | pass | Frames 10:20:21–10:20:30: only T3's page. |

## Problems

### 1. Dialogs held at the launch size (tool bug, fixed)
`list_windows` at +35.6: "Chart Type" 1280×800 with `agentSize` 1280×800; "Save Document?" 506×198 with `agentSize` 1280×800. `holdLate` held every window the thread got within 60 s of `launch_app` at its size, the agent's own dialogs included. Now it stops at the agent's first input to the thread's windows (`helper/src/daemon.ts`).

### 2. `close_window` doesn't name what the app opened (tool bug, fixed)
Now it stops waiting once the thread gets a new window and reports changes as the other window actions do (`withWindowChanges`); its description says so.
