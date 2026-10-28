# stuck-drag-paused: 2026-10-28 (X11 session, slot 26, main a927a6e + the helper fixes, claude-opus-5-5 on claudeAgent_claude_2)

Run `logs/agent-tests/20261028-234829-stuck-drag-paused`: completed after 3.7 min; 11 tool calls, 2 errors; hidden tab. `pause-x11.sh --after 2 --for 40`. Written by the backlog worker that ran it (agent-scenarios), not a separate reviewer: checked against `timeline.txt` and the screen frames.

## Verdict

The pause came at the wrong time: `pause-x11.sh` matched `preview_drag` in the tool listing and stopped the Xvfb 10:48:38–10:49:18, during `preview_open` (+5.6 → +45.9, 40.3 s, then fine). Fixed: it matches the call. The drags then failed with no pause: the 490-point spiral (+103.3) timed out after 60 s ("Preview automation drag timed out after 60000ms."), a 2-point drag after 15 s, and a press and snapshot queued behind it took 16 and 23 s. The control run (20261029-000105) shows the same without any pause.
