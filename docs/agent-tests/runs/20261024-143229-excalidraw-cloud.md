# excalidraw-cloud: 2026-10-24 (test session at t3/fix-recorder, T3 fix/recorder 7c4a68d628, claude-opus-5-5)

Run `logs/agent-tests/20261024-143229-excalidraw-cloud`, thread `mcp:e96f3940-d592-47ad-be0b-a64df90300e1`: completed after 1.8 min; 26 tool calls, 0 failed.
Tests the `recorder` fix (rounds 1 and 2): the encoder runs in a hidden page of Plutonium's browser instead of a downloaded chrome-headless-shell; a timed-out request no longer drops the server's own browser host; `visible` is whether the user sees the tab. Checked by the orchestrator against the timeline and the video; no reviewer agent (the merged branch gets a full review in the final run).

## Verdict

| Check | Result | Evidence |
|---|---|---|
| 1. Recording works the first time, and the video plays and shows the drawing | pass | `preview_recording_start` ok in 0.3 s (+22.7 s); `preview_recording_stop` ok in 1.2 s with a `path` (+83.6 s). The file is VP9 webm, 2276×1423 (the tab at device scale 1.78), 86 frames over 61 s, all distinct. The frame at 58 s shows the finished, filled cloud, selected, with the pointer on the fill swatch. Nothing was downloaded into the T3 home (no `tools/`). |
| 2. Clicks land | pass | Ref and locator clicks all ok; no stale refs or timeouts. |
| 3. Drawn partly with the input tools | not tested here | This branch hasn't got the `drag` fix (no path drags), so the tester drew the puffs with pointer events from `preview_evaluate` again; tools and keys were chosen with clicks and `preview_press`. Path drags pass on `t3/fix-drag` (`20261024-142128`, `20261024-142711`). |
| 4. The final snapshot shows a cloud | pass | `seen/003`, and the video. |
| 5. Viewport and resize | not reached | No `preview_resize`. |
| `preview_open` reports `visible` | pass | `visible:true` with the thread shown in the shell (+19.8 s). |

## Problems

### 1. Recording video size isn't stated (minor, description)

The video is at device pixels (2276×1423), while snapshots and coordinates are CSS pixels (1280×800). `preview_recording_stop`'s result doesn't give the size. Harmless, but an agent comparing a video frame with a snapshot would see different sizes. Suggestion: give `width`/`height` in the stop result.

## The tester's report

Accurate: it said where the video is and checked its duration with `ffprobe` itself.

## Compared with earlier runs

Fixed: the recorder's `browserType.launch` failure (every earlier run and e7f9bc64), and `visible:false` after `preview_open`. The cold-start snapshot failure from `20261024-142128` didn't recur (no download).
