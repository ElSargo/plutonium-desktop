---
name: excalidraw-cloud
model: claude-opus-5-5
timeout: 20
---

# Draw a cloud in Excalidraw, recorded

Browser tab tools: opening, snapshots, clicks by ref and by coordinates, keys, drags, `preview_evaluate`, resizing, recording. From the run of 2026-10-23 (thread `e7f9bc64`).

## Prompt

```text
Can you open up excalidraw and record a video of you using your tools to draw a cloud? Use a mix of cursor actions, keys, and js eval. When you're done, tell me where the video is.

This is a test of the tools in this build. If a tool fails or behaves strangely, tell me exactly what happened. Don't build a workaround for it; carry on with the rest of the task as best you can. Don't stop to ask me anything (nobody is watching); make a sensible choice and say what you chose.
```

## Checks

The tool path, not only the result:

1. `preview_recording_start` and `preview_recording_stop` work the first time, and the video they give is a file that plays and shows the drawing.
2. Clicks land: by ref and by coordinates, with the tab hidden or shown, with no stale ref errors right after a snapshot and no 15 s timeouts.
3. At least part of the cloud is drawn with the input tools (`preview_drag`, `preview_click`, `preview_press`), not only with synthetic events from `preview_evaluate`. If the agent can't draw a curve with the input tools, say why: a missing capability or a description that steered it away.
4. The final snapshot shows a cloud.
5. The agent notices when the viewport changes under it (opening the panel narrows it), and resizing gives the size asked for.

## Watch for

Things the tester can't see; check them in the screen recording (session runs with `--show`):

- After `preview_resize`, the cursor preview in the thread's panel still sits where the agent's clicks land in the tab.
- The panel shows the tab live while the agent draws, at the size the agent set.

## Known issues

- 2026-10-23 (`e7f9bc64`, manual): `preview_recording_start` failed 4 times with `browserType.launch: Target page, context or browser has been closed`; the agent then built an in-page recorder and tried to smuggle the video out (wasted ~4 min). A role locator click timed out after 15 s with the tab hidden, then worked. One click failed with a stale ref right after a snapshot. An `<a download>` click never showed in `downloads`. `preview_open` with `open: true` narrowed the viewport to 539 px (Excalidraw's mobile layout). After a resize, the panel's cursor preview no longer matched the click position (seen by the user).
- 2026-10-24 (run `20261024-115418-excalidraw-cloud`, live): recording still fails the same way. Cause: `startRecording` runs its encoder in a scratch page of a separately launched `chrome-headless-shell` (T3 `ServerBrowserContexts.ts`), a generic-Linux download NixOS can't run; the error check only knows glibc's message. No tool drags between points (`preview_drag` is element onto element), so the cloud was drawn with pointer events from `preview_evaluate`. Snapshots say 1280×800 but the images are 1138×711 (`RENDER_SCALE = 2`). `preview_open` returned `visible:false`. Runs share the default profile's storage, so the canvas held the previous run's drawing.
