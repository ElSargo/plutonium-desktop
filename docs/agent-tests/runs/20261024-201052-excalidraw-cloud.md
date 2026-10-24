# excalidraw-cloud: 2026-10-24 (test session at main 05017b9, claude-opus-5-5)

Run `logs/agent-tests/20261024-201052-excalidraw-cloud`, thread `mcp:7b1d3859-1623-4923-ba40-a4f01fee3d25`: completed after 1.6 min; 24 tool calls, 0 failed.
The final test of main: a fresh session with Chromium built from main's patches, T3 from the `plutonium` branch, a fresh T3 server and `--show`. It is the first run with the recorder fix and the drag fix together. The recorder fix encodes recordings in a hidden page of Plutonium's own browser instead of T3's downloaded `chrome-headless-shell`, keeps the server's browser host when a tab request is slow, and makes `visible` count the floating preview. The drag fix adds coordinate path drags, correct snapshot sizes, a cursor that follows drags, a reply from resize, no flash on `save:true`, and abandons stuck actions.

**Fix verdicts:** the recorder fix works. The parts of the drag fix this run exercised (path drags, snapshot sizes, the cursor following drags, `save:true`) work. Resize and stuck actions weren't exercised.

## Verdict

| Check | Result | Evidence |
|---|---|---|
| 1. Recording works the first time; the video plays and shows the drawing | **pass** | `preview_recording_start` ok in 0.4 s (07:11:12); `preview_recording_stop` ok in 1.2 s (07:12:22) and returned a `path`. The file exists: `…/t3-home/userdata/attachments/mcp-7b1d3859-…-ee1543ef4f15-webm.webm`, 897,754 bytes. ffprobe: VP9, 2276×1423, 132 frames, last pts 70.3 s (matches the 70 s between start and stop). It decodes with no errors. Frames: 0 s shows the empty welcome screen; 14 s the base ellipse; 18–19 s the two puffs with the cursor at the end of each drag; 41 s all selected after Ctrl+A; 61 s filled; 70 s the finished four-puff cloud. Nothing was downloaded into the T3 home (no `chrome-headless-shell`, no `tools/`). |
| 2. Clicks land, with no stale refs and no 15 s timeouts | **pass (partial)** | Ref click `aria-ref=…-e91` (Ellipse tool) 0.4 s after a snapshot (07:11:21), with no stale ref error. Two CSS-selector clicks on the `#a5d8ff` swatch took 0.3 s each (07:11:53, 07:12:16); the fill shows in `seen/003` and `seen/004`. There were no coordinate clicks. The tab was only in the floating preview. |
| 3. Part of the cloud drawn with the input tools | **pass** | All four ellipses come from `preview_drag` with a `path` (3–4 points), after `preview_click` or `preview_press o` chose the tool (07:11:25, :29, :30, 07:12:13). The stored boxes match the paths exactly, e.g. (460,390) 360×130 for the path 460,390 → 820,520. The one `preview_evaluate` that tried to draw made nothing that lasted (problem 1). |
| 4. Final snapshot shows a cloud | **pass** | `seen/004` (07:12:19, `save:true`): a light-blue base with three puffs. The saved PNG is in `userdata/browser-artifacts/…mvm29w5a-2a3f0d6a.png`. |
| 5. Notices viewport changes; resize gives the size asked for | **not exercised** | The viewport stayed `fill` at 1280×800. The panel never opened and there was no `preview_resize`. |
| `preview_open` `visible` | **pass** | It returned `visible:true` (07:11:09). The screen recording shows the floating preview bottom right from 07:11:10 (`frames/071110.png`), so `true` is right now. Earlier runs got `false`. |
| Snapshot size | **pass** | Each snapshot reports 1280×800, and each image in `seen/` is 1280×800 (it was 1138×711 before). |
| Watch for: the panel's cursor matches the clicks | **pass, without a resize** | In the floating preview the cursor sits at the end corner of each drag (`/tmp` crops of 07:11:26.6 and 07:12:13.9: bottom right of the new ellipse's selection box). There was no resize to test it after. |
| Watch for: the panel shows the tab live | **pass, in the floating preview** | The floating preview updates with each drag, the selection and the fill (`frames/071126.5.png` … `071223.5.png`). There was no flash around the `save:true` snapshots. The right panel never opened. |

## Problems

No tool bugs that broke the task. The rest is minor.

### 1. The `preview_evaluate` drawing attempt made nothing that lasted (agent mistake)

At 07:11:44 the agent's script dispatched a synthetic `keydown o` on `document`, then `pointerdown` on the interactive canvas, and then `pointermove`/`pointerup` on `window`. It returned `elementCount: 4`. The snapshot at 07:11:54 and the evaluate at 07:11:59 found only 3 ellipses, so Excalidraw dropped a zero-size element. The tool reported what the page did; earlier runs drew with evaluate-dispatched pointer events that went to the canvas (`20261024-115418`). The agent said it was its script's fault, didn't build a workaround, and drew that puff with `preview_drag`. Nothing to fix in the tools.

### 2. The recorded WebM has no duration and seeks badly (tool bug, minor)

ffprobe reports `duration=N/A`, and the frames are variable-rate, only where the page changed (132 frames over 70 s). This is a MediaRecorder WebM with no duration or cues. Decoded straight through, every frame is right. But a seek with `ffmpeg -ss 65` gave a blank, half-decoded canvas, and players may show no length or a broken scrubber. Fix: after recording, remux to write the duration and cues, e.g. `ffmpeg -c copy`, or fix the duration in the page with a library like `ts-ebml`/`fix-webm-duration` before handing the file over. Check in a player (mpv, Chromium) to see whether users notice.

### 3. `actionTimeline` still leaves out `preview_evaluate` (minor; from baseline problem 6)

The snapshots' `actionTimeline` lists clicks, presses and drags but none of the three evaluates. The tester's claim that its parallel calls "ran in the order I sent them, according to the page's action log" holds for the input calls. Either record evaluates, or say in `preview_snapshot`'s description that the timeline lists input actions only.

### Noise

T3's server log has `orchestration-v2.claude-query-stream-failed` at 20:12:38, 5 s after the turn completed (20:12:33). It is probably the harness shutting the provider down. It had no effect on the run. `coredumps.txt` is empty.

## The tester's report

It is accurate. It names the video path, which exists and plays, and gives the right size (0.9 MB) and length (~70 s). It correctly says every tool returned normally. It describes the failed JS draw honestly as its own script's fault, not the tool's. It notes that the finished cloud is all cursor and key work, which matches the stored boxes. It left out:

- It didn't check that the video plays; this review did.
- It said nothing about the viewport or panel. That matters little, since the viewport never changed.

## Compared with earlier runs

- **Fixed:** recording on NixOS works the first time, now with main's full set of changes (rounds 1+2 in `20261024-143229` tested it alone). `visible:true` with the floating preview is fixed (it was `false` in `115418` and `193218`). Snapshot images now match their reported size. Path drags draw (as in `193218`). The profile is fresh: the canvas started empty.
- **Still open:** evaluates are missing from `actionTimeline` (problem 3).
- **New:** the WebM has no duration or cues (problem 2).
- **Still not exercised in any run since the fixes:** the 539 px viewport with the panel open, the cursor after `preview_resize`, coordinate clicks, and stuck-action abandonment. The scenario's prompt doesn't steer the agent to these. To cover check 5 and the first watch-for item, ask for a page size, e.g. "with the page at 900×700 and the browser panel open".
