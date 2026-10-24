# excalidraw-cloud: 2026-10-24 (test session `at-drag` at `t3/fix-drag` 47468be, T3 fix/drag 0a5a7d9d1d, Chromium `builds/561f1493e9ae`; claude-opus-5-5)

Run `logs/agent-tests/20261024-193218-excalidraw-cloud`, thread `mcp:5b5b7ac6-13cf-461d-aa28-564637992458`: completed after 0.9 min. 19 tool calls, 3 failed: 2 × `preview_recording_start` and 1 × `preview_recording_stop`. The session ran on tty7 with `--show` and a screen recording (2560×1600 at 4 fps, covering the whole run).

Fix under test: `drag`, rounds 1–3 (see `20261024-193013-excalidraw-spiral-sized.md` for the list). The recorder fix (`t3/fix-recorder`) isn't in this branch, so the recording was expected to fail.

## Verdict

| Check | Result | Evidence |
|---|---|---|
| 1. Recording starts and stops; the video plays | **fail (expected)** | +10.3 s and +14.6 s: `recordingStart failed: browserType.launch: Target page, context or browser has been closed`, each failing at once. +40.7 s: stop answered `No recording is active for this thread.` The 15 s cold-start timeout and host eviction seen in `20261024-142128` didn't recur, because the shell was already downloaded in this T3 home. The snapshot sent in parallel with the first start succeeded (0.5 s). |
| 2. Clicks land with no stale refs or 15 s timeouts | **pass (partial)** | Two role-locator clicks (`#a5d8ff` and `#1971c2`, +30.8 s and +31.0 s) took 0.4 s and 0.6 s. The colours they set are confirmed by the evaluate (+36.2 s) and `seen/003`. There were no ref clicks and no coordinate clicks. The tab was in the floating preview only (`visible:false`). |
| 3. Part of the cloud drawn with input tools | **pass** | All three puffs were drawn with `preview_press o` followed by a 2-point `preview_drag` (+21.2, +24.3, +25.3 s). The evaluate drew nothing: it only read `localStorage`. The ellipse boxes match the drags exactly: (480,420) 160×100, (560,360) 180×140, (680,410) 150×110. |
| 4. Final snapshot shows a cloud | **pass** | `seen/003`: three overlapping light-blue puffs with a blue outline. It's a loose cloud, with no base. The canvas was empty at the start (`seen/001`). |
| 5. Notices viewport changes; resize gives the size asked for | **not reached** | No `preview_resize`. The panel never opened, and the viewport stayed 1280×800. |
| Round 1: path drags; image at CSS size | **pass** | See check 3. All 3 snapshots, and the saved screenshot, are 1280×800 and report `viewport` 1280×800. Only 2-point paths were used here; the multi-point paths are in the spiral run. |
| Round 2: cursor in the floating preview follows drags | **pass** | `frames/drags-montage.png` (one frame every 0.25 s from 06:32:44.5) shows the cursor tracking each ellipse's drag from corner to corner, then fading. After Escape closes the properties panel, the faded cursor shows at the last swatch click (`frames/save-montage.png`). That's consistent. |
| Round 2: no flash on `save:true` | **pass** | The `save:true` snapshot ran from 06:33:04.17 to 04.69. `frames/save-montage.png` (06:33:02.5–07.5) has no half-size or misplaced frame. |
| Round 3 items; incognito | **not exercised** | Nothing stalled: the slowest call was `preview_open` at 2.9 s, and the next was the evaluate at 1.5 s, all of it the expression's own 1.5 s wait. `preview_status` was never called, and `preview_open` was called with only `url`. |
| Watch for: panel cursor after a resize | **not reached** | No resize, and the side panel never opened. |
| Watch for: panel shows the tab live at the set size | **pass (floating preview, 1280×800)** | The floating preview updates with each drag and fill (`frames/drags-montage.png`, `frames/save-montage.png`). |

## Problems

### 1. Recording still fails with `browserType.launch` (tool bug, expected here; fix in `t3/fix-recorder`)

The error is the same as in every run before this one, and the cause is the same: `startRecording` launches `chrome-headless-shell`, which can't run on NixOS (see `20261024-142128-excalidraw-cloud.md`, problem 1). It doesn't count against `drag`. This time it failed fast, and it didn't evict the host or take down the parallel snapshot.

### 2. `preview_open` says `visible:false` while the floating preview shows the tab (tool bug or description gap, still open)

+6.9 s: `"visible":false`. The tab was in the floating preview the whole run (`frames/063240.png`), and the tester told the user the preview "may not have opened for you". This is the same problem as in the spiral run and the baseline.

### 3. The prompt doesn't reach checks 2 and 5 (test gap)

The agent made no coordinate or ref clicks and no resize, so checks 2 and 5 are mostly untested, and so is the side-panel cursor after a resize. The evaluate only read state. That fits the prompt ("a mix of cursor actions, keys, and js eval"), but it doesn't steer the agent to the parts the checks care about. If these checks matter for this scenario, the prompt should ask for a page size, for example "with the page at 900×700 and the browser panel open".

### 4. Key press and click sent in parallel (agent risk, minor)

At +30.8 s, `Ctrl+A` and the `#a5d8ff` swatch click went out together, with no snapshot between them. The tab's queue ran them in order, and the fill applied to all three shapes. Nothing in the tools promises that order, though, and the fill only works if the selection comes first. It worked, so this isn't a tool problem.

## The tester's report

It's accurate:
- both recording errors are quoted exactly, along with the stop error;
- it accurately describes the three ellipses, the swatches and the localStorage read;
- it correctly says nothing else failed.

The one error is the same as in the spiral run. It told the user the preview may not have opened, but the floating preview showed the tab and the agent cursor the whole time.

## Compared with earlier runs

Against `20261024-142128-excalidraw-cloud` (round 1):
- **Fixed:** the cold-start 15 s recording timeout, which had evicted the host and failed the parallel snapshot. It was an artifact of a fresh T3 home and wasn't caused by `drag`.
- **Fixed:** the ring at the floating preview's corner, which turned out to be chrome. The floating preview now draws a moving agent cursor, and it follows each drag.
- **Still failing:** recording (expected) and `visible:false`.
- **Still not exercised:** resizing, coordinate and ref clicks, the side panel, and the round-3 stuck-action handling.
- **New:** nothing.
