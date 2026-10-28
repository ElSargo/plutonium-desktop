# stuck-drag-paused: 2026-10-29, control without a pause (X11 session, slot 26, claude-opus-5-5 on claudeAgent_claude_2)

Run `logs/agent-tests/20261029-000105-stuck-drag-paused`: completed after 3.1 min; 12 tool calls, 1 error; hidden tab, fresh session, no pause. Written by the backlog worker that ran it (agent-scenarios), not a separate reviewer: checked against `timeline.txt` and the screen frames.

## Verdict

| Check | Result | Evidence |
|---|---|---|
| 1. The stuck drag fails within its timeout, saying so | pass | Spiral `preview_drag` failed at +135.0 after 60.5 s: "Preview automation drag timed out after 60000ms." |
| 2. `preview_status` shows it | pass | +138.2: the drag under `stuck`. |
| 3. Next actions work | pass | `preview_press r` 0.1 s (+149.2); a 2-point drag worked but took 14.5 s (+163.6). |
| 4. The drawing finished | fail | One turn of five (the agent's `preview_evaluate` at +166.4 read the freedraw element). |

## Problems

### 1. Mouse moves on a hidden tab are slow on the X11 session (environment or browser, open)
Raw moves on the same tab afterwards: 20 without a button 0.3 s, 20 with the pen down 8.1 s; a minute later 19 s and 10 s with the tab held awake, while `requestAnimationFrame` ran at 60 fps on the GPU (RADV). The paused-display case can't be told apart from this until moves are fast again. BACKLOG: "Mouse moves on a hidden tab are slow on the X11 session".
