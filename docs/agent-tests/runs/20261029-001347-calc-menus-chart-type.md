# calc-menus-chart-type: 2026-10-29 (X11 session, slot 26, main a927a6e + the helper fixes, claude-opus-5-5 on claudeAgent_claude_2)

Run `logs/agent-tests/20261029-001347-calc-menus-chart-type`: completed after 1.6 min; 30 tool calls, 0 errors; `--show`. Written by the backlog worker that ran it (agent-scenarios), not a separate reviewer: checked against `timeline.txt` and the screen frames.

## Verdict

Every step worked; the fixes held (`close_window` at +77.8 named "Save Document?" in 0.4 s). `--show` shows the thread, not its window: Calc stayed `shown: false`, and the frame at 11:14:31 (Format menu and submenu open) shows only the thread, no menu, which is right for a hidden window. The window-shown case needs the window opened in the panel during the run; still unrun. Not reached: a hover, `select`, a stale ref.
