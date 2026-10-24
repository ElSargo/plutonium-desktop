---
name: excalidraw-spiral-sized
model: claude-opus-5-5
timeout: 15
---

# A freehand spiral in Excalidraw, at a set page size

Browser tab tools at a viewport the agent sets: `preview_resize`, path drags with many points (freehand curves), clicks by coordinates read off snapshots, and the panel's agent cursor on a resized, scaled tab. Written 2026-10-24 to exercise the `drag` fix's cursor part, which `excalidraw-cloud` didn't reach.

## Prompt

```text
Open excalidraw.com with the page at exactly 1024×768, and draw a spiral freehand with the pencil, about three turns, in the middle of the canvas. Then put a small red dot at the spiral's centre. Show me the result when you're done.

This is a test of the tools in this build. If a tool fails or behaves strangely, tell me exactly what happened. Don't build a workaround for it; carry on with the rest of the task as best you can.
```

## Checks

1. The page is set to 1024×768 with the tools for that, and snapshots then report a 1024×768 viewport and image.
2. The spiral is drawn with input-tool drags along many points (a freehand stroke), not with `preview_evaluate` events.
3. The dot lands at the spiral's centre: a point read off a snapshot clicks or drags at that spot.
4. The final snapshot shows a spiral of about three turns with a red dot at its centre.

## Watch for

In the screen recording (session runs with `--show`):

- Once the tab is 1024×768 and drawn scaled in the panel, the panel's agent cursor sits where the strokes are drawn and follows the spiral as it's drawn.
- The panel shows the tab at the size the agent set.

## Known issues

(none yet)
