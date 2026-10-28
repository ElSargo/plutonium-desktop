---
name: stuck-drag-paused
model: claude-opus-5-5
timeout: 15
---

# A long drag while the display is paused

A tab action that can't finish (backlog "Agent tool paths no run has reached yet", 2026-10-28): a long path drag while the session's display is paused, so the tab draws no frames and its mouse moves wait. The tools should say so and let go (`features/AGENT_CONTROL.md`, "A stuck action doesn't wedge its tab"): a timeout that says the tab isn't drawing, `preview_status` `busy`/`stuck`, no held button, and a working tab once the display is back.

How to run: pause the display while the tester's first long `preview_drag` runs, for about 40 s, then resume it. On DRM, switch to another VT and back (the orchestrator's). On the X11 session, stop the slot's Xvfb (`kill -STOP`, then `-CONT`): Ash can't present, so its tabs stop drawing. Watch the tester's transcript for its first `preview_drag`.

## Prompt

```text
Open excalidraw.com and draw a big freehand spiral with the pencil, about five turns, as one slow, smooth stroke with lots of points. Then draw a rectangle around it, and show me the result.

This is a test of the tools in this build. If a tool fails or behaves strangely, tell me exactly what happened. Don't build a workaround for it; carry on with the rest of the task as best you can. Don't stop to ask me anything (nobody is watching); make a sensible choice and say what you chose.
```

## Checks

1. The drag that runs into the pause fails within its timeout with an error that says the tab isn't drawing frames (or that the action was abandoned), not a hang until the run's deadline.
2. `preview_status` (if the agent calls it) shows the action under `busy` while it runs and under `stuck` after.
3. Once the display is back, the next actions work: no button left down (the next stroke isn't joined to the stuck one), no queue still blocked.
4. The agent reports what happened, and the drawing is finished after the pause.

## Watch for

- The tab, once the display is back, shows no half-stroke still following the pointer.

## Known issues

- 2026-10-28 (run `20261028-234829-stuck-drag-paused`, X11 slot 26, hidden tab): `pause-x11.sh` matched the tool's name in a tool listing and paused during `preview_open`, not the drag (fixed: it matches the call); `preview_open` waited out the 40 s pause and then answered. The spiral (490 points) then timed out after 60 s with no pause at all: "Preview automation drag timed out after 60000ms."; a 2-point drag timed out after 15 s, and the press and snapshot queued behind it took 16 and 23 s.
- 2026-10-29 (run `20261029-000105-stuck-drag-paused`, control, no pause): the same: the spiral timed out after 60 s, `preview_status` listed it under `stuck`, the next press took 0.1 s and a 2-point drag (about 30 moves) 14.5 s. Raw `Input.dispatchMouseEvent` on that Excalidraw tab, hidden: 20 moves without a button in 0.3 s, 20 while drawing in 8.1 s; a minute later 19 s and 10 s (held awake). The tab's `requestAnimationFrame` ran at 60 fps meanwhile, on the GPU (RADV). So moves on a hidden tab are slow on this X11 session, for Excalidraw's pen most of all, and a long drag can't finish there with or without a pause; the stuck-action handling itself worked (a timeout that says so, `stuck` in the status, the tab usable after). The pause during a drag is still unrun, and so is the DRM version (a VT switch; the orchestrator's).
