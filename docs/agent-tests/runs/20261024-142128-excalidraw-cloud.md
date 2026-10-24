# excalidraw-cloud: 2026-10-24 (test session at `t3/fix-drag` b7156bb, T3 860e0454af; claude-opus-5-5)

Run `logs/agent-tests/20261024-142128-excalidraw-cloud`, thread `mcp:0c7cf382-45d2-48c3-9343-114b35e760ff`: completed after 1.3 min; 21 tool calls, 4 failed (2 × `preview_recording_start`, 1 × `preview_snapshot`, 1 × `preview_recording_stop`). Test session on tty7 with `--show` and a screen recording.

Fix under test (`drag`, T3 commit 860e0454af):
1. `preview_drag` takes `path: [{x,y},…]`, real mouse input along the points.
2. Snapshot images are one pixel per CSS pixel; `screenshot.width/height` are the image's size, `screenshot.viewport` the CSS size.
3. The panel's agent cursor follows a resized, scaled tab (`PlutoniumBrowserTab` publishes its layout).

The recording fix isn't in this branch, so recording was expected to fail.

## Verdict

| Check | Result | Evidence |
|---|---|---|
| Fix 1: path drags | **pass** | Three 2-point drags (+47.1, +50.3, +51.0 s) drew ellipses with exactly the requested boxes: (480,380)–(640,480), (560,330)–(720,460), (660,370)–(800,480). The third one's selection box in `seen/002` is 655–804 × 366–484. The panel's mini preview shows each ellipse appear at the moment of its drag (`frames/pip-drags.png`). Curves (paths with >2 points) were not tried. |
| Fix 2: snapshot size matches image | **pass** | All 3 snapshots report `"screenshot":{"width":1280,"height":800,"viewport":{"width":1280,"height":800}}`. `seen/001–003` and the saved `browser-screenshot-excalidraw-com-mvlpsaqm-20f0926f.png` are all 1280×800. Image coordinates were the click coordinates (see fix 1). |
| Fix 3: cursor follows a resized tab | **not exercised** | No `preview_resize` call. The right panel never opened; the tab showed only in the small floating preview, at 1280×800 throughout. |
| 1. Recording works, video plays | fail (expected) | +28.0 s `recordingStart timed out after 15000ms`; +41.9 s `browserType.launch: Target page, context or browser has been closed`; +70.7 s stop: `No recording is active for this thread.` The first error is new; see problem 1. |
| 2. Clicks land, no stale refs or 15 s timeouts | pass (partial) | Role-locator click `role=button[name='Ellipse']` landed in 0.4 s (+50.2 s) with the tab hidden (`visible:false`). The 15 s role-locator timeout from the known issues didn't recur. No coordinate clicks and no ref clicks. |
| 3. Part of the cloud drawn with input tools | **pass** | 3 of 4 puffs drawn with `preview_press o` / `preview_click` + `preview_drag path`. The 4th puff and the fill came from `preview_evaluate`, by the agent's choice (problem 3). |
| 4. Final snapshot shows a cloud | pass | `seen/003`: four overlapping light-blue filled ellipses. The canvas was empty at the start (`seen/001`), so the leftover-state problem from the baseline is gone in a test session. |
| 5. Notices viewport change; resize gives the size asked for | not reached | No resize. The viewport stayed at 1280×800. |
| Watch for: cursor in the panel sits where the agent acts | not checkable | No resize, and no agent cursor that moves with the drags can be seen in the mini preview at 4 fps. A ring stays fixed at the mini preview's top-right corner for the whole run (`frames/012144.png` onwards). It is either preview chrome or a parked cursor that never moved; see problem 4. |
| Watch for: panel shows the tab live | pass, in the mini preview | The floating preview (bottom right, `frames/012221.6.png`, `012224.8.png`) updates live with every drag, evaluate and fill (`frames/pip-eval.png`). The right panel itself never opened. |

## Problems

### 1. The first `preview_recording_start` installs chrome-headless-shell inside a 15 s budget; the timeout evicts the browser host and fails a parallel snapshot (tool bug; cold start, not a regression)

At +11.9 s the agent sent `preview_recording_start` and `preview_snapshot` together. Both failed at +28.0 s:

- recording: `Preview automation recordingStart timed out after 15000ms.`
- snapshot: `No preview automation host is available for snapshot in environment 73cb9d71-…. The server-owned browser may be starting or reconnecting.`

What happened, from the test session's T3 home (`~/.local/share/plutonium/at-drag/t3-home`) and its `userdata/logs/server.trace.ndjson`:

1. The session's T3 home is fresh, so it had no `tools/chrome-headless-shell`. `tools/` was created at 14:21:46.195 local (01:21:46.19 UTC), the instant the recording started. The 197 MB `chrome-headless-shell` binary landed at 14:22:13.70, and the directory was complete at 14:22:14.05. So the recording start spent about 28 s downloading the encoder browser.
2. The broker gives `recordingStart` the default 15 s (+1 s grace). Only `open` on the preferred host gets 660 s for an install (`apps/server/src/mcp/PreviewAutomationBroker.ts:566–567`). At 01:22:02.19 `awaitResponse` timed out, and because the request was unanswered the broker called `disconnect(…, true)` on the whole server browser host (`PreviewAutomationBroker.ts:664–671`; trace spans `PreviewAutomationBroker.disconnect` and `closeConnection` at 01:22:02.190).
3. The snapshot only reached `PreviewAutomationBroker.invoke` at 01:22:02.214, 24 ms after the eviction (span length 0.17 ms). There was no host, so routing returned `PreviewAutomationNoAvailableHostError` (`PreviewAutomationBroker.ts:607`). Until the recording call ended, the snapshot was held somewhere upstream of the broker. No span covers that 16 s wait, so where it was held isn't confirmed.
4. The host re-registered at 01:22:03.19 (`connect`, `acquireConnection`). `preview_status` at +30.3 s was fine.
5. The orphaned install kept running in the host. At 01:22:14.07 `PreviewBrowserHost.diagnoseLaunchFailure` ran on it (the shell can't run on NixOS, as in the baseline), and its late `respond` came at 01:22:14.078. The retried snapshot (+32.1 s) took 7.9 s and returned at 01:22:14.27, right after that. The host appears to serialise requests, so the snapshot was stuck behind the dead recording.
6. The second start (+41.9 s) failed at once with the baseline's error, because the binary now existed but can't run on NixOS. `diagnoseLaunchFailure` still doesn't recognise the NixOS stub-loader message.

So this is not a regression from `fix-drag`: the commit touches neither the broker nor recording. It's a cold-start problem caused by the recording attempt. It shows only where the T3 home has never downloaded the headless shell (every fresh test session), and it would hit any tool call made in parallel with the first recording start. On the live desktop the shell is already downloaded, which is why the baseline saw only the immediate launch error.

Suggested fix: the recording fix should stop needing the headless shell on Plutonium, which makes this go away. Independently:
- Give a recording start that may install the shell the same long budget as `open`, or install it outside the request.
- Don't evict the whole host when one slow request times out while the host is still answering others.
- `preview_recording_start`'s error should say it was downloading a browser.

### 2. `preview_open` says `visible:false`, but the user sees the tab live (tool bug or description gap; still open from the baseline)

At +8.8 s `preview_open` (no `open` argument; the description says it defaults to true) returned `"visible":false`. Every `preview_status` said the same. The screen shows the tab in a floating preview at the bottom right of the shell from the start (`frames/012144.png`), updating live. The right panel never opened, and the viewport stayed at 1280×800.

Either the floating preview doesn't count as a viewer (`visible` is `tab.viewers.size > 0`, `apps/server/src/preview/ServerBrowser.ts`), or `visible` is read before it attaches. The tester flagged it but couldn't tell what the user saw. Fix: count the floating preview as visible, or say in the description that `visible` means the panel only.

### 3. Half the cloud came from `preview_evaluate` by the agent's choice, not because of a gap (agent choice, prompt-driven; not a tool problem)

After the three puffs, its thinking says: "I'm thinking about adding a flat base and coloring them light blue using JS eval … I'm considering driving the canvas through synthetic pointer events to draw the base ellipse and click the color swatch." Its message at +59.3 s says: "Three puffs drawn with keys and cursor. Next I'll use JS eval to draw a fourth, lower puff…". The prompt asks for "a mix of cursor actions, keys, and js eval", and the evaluates were how it met the "JS eval" part.

None of these is a capability or description gap:
- The 4th puff could have been one more path drag.
- The fill swatch and the "Solid" option are ordinary buttons that `preview_click` reaches.
- Picking the tool by key and by click both worked.

The description it had loaded advertises curves clearly: "press the button and move along a path of points, to draw on a canvas, sketch a shape or curve … two points for a straight drag, more for a curve". The `path` parameter adds: "Two points draw a straight stroke or drag a box; more points draw a curve or freehand line." Ellipses only need two points, so multi-point paths (curves, freehand) went untested. A future run should ask for a freehand outline (`p` / pencil) to exercise them.

### 4. Panel cursor can't be judged from this run (test gap)

Fix 3 needs a `preview_resize` with the panel open. Neither happened. In the mini preview, no cursor visibly moves to the drag points. A ring stays fixed at the preview's top-right corner for the whole run (`frames/pip-drags.png`, `pip-eval.png`). If that ring is the agent cursor, it didn't follow the path drags, even though the commit says "The panel's cursor follows the path". The recording is 4 fps and the preview is about 280 px wide, so I can't tell.

To settle both questions, run a scenario that opens the panel (`preview_open` with the panel shown), resizes to something like 900×700, and does slow multi-point drags. Then check frames at full size.

### 5. Press and drag sent in parallel (agent risk, minor)

At +47.1 s and +51.0 s the agent sent `preview_press o` and `preview_drag` in the same batch. They ran in order (press done 0.5 s before the drag), and the drags drew ellipses. But nothing guarantees that order: if the drag runs first, it makes a selection box instead. It worked here, so this is not a tool problem.

## The tester's report

It's accurate on what failed, with errors quoted exactly. It was honest that the first recording timed out and the second gave a different error, and its guess that "the recorder is probably trying to launch its own browser" is right.

Gaps:
- It linked the snapshot failure to the recording only by noting they were sent "in the same batch". It didn't know the first start was downloading a browser.
- It never tried `preview_resize` or multi-point paths, so fix 3 and curves weren't exercised. The prompt didn't ask for either.
- It said nothing about the path drag itself beyond "all of these worked first time". That is true: the ellipses match the requested boxes.

## Compared with earlier runs

Against the baseline `20261024-115418`:
- **Fixed:** no coordinate drag (baseline problem 2): path drags now draw on the canvas, and the input tools drew most of the cloud. Snapshot size versus image (baseline problem 3): now 1280×800 for both, plus `viewport`. Leftover canvas state (baseline problem 5) didn't occur in the test session's fresh profile.
- **Still failing:** recording, with the same `browserType.launch` error once the shell was downloaded (expected; the recording fix isn't here). `visible:false` (baseline problem 4), now known to be wrong: the user did see the tab, in the floating preview.
- **New:** the 15 s timeout on the first recording start while it downloads chrome-headless-shell, the host eviction, and the parallel snapshot's `No preview automation host` (problem 1). It's specific to a fresh T3 home and not caused by this branch.
- **Not exercised:** the cursor after a resize (fix 3), the 539 px viewport with the panel open, coordinate clicks, multi-point paths. Not checked: whether evaluates now appear in the `actionTimeline` (baseline problem 6).
