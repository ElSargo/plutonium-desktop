# excalidraw-spiral-sized: 2026-10-24 (test session at `t3/fix-drag` 01cfbc2, T3 e07d9f0382; claude-opus-5-5)

Run `logs/agent-tests/20261024-145112-excalidraw-spiral-sized`, thread `mcp:41d9f2f0-013c-4578-bb76-3cd5508147f1`: completed after 5.9 min, task not finished; 22 tool calls, 4 failed (`preview_drag`, 2× `preview_snapshot`, `preview_evaluate`). Test session on tty7 with `--show` and a screen recording (2560×1600, 4 fps). The recording **ends at 01:55:04 (+227 s)**, before the drag.

Fix under test: round 2 of `drag` (T3 commit e07d9f0382, diff from 860e0454af):
1. `BrowserMiniPlayer` (`ThreadPreviewMiniPlayer.tsx`) renders `AgentBrowserCursor` over the floating preview.
2. `preview_resize` on a desktop tab polls `innerWidth/innerHeight` for up to 3 s (`settledDesktopViewport`, `ServerBrowser.ts`) and replies with the size it finds.
3. Snapshots capture at scale 1 with no clip, so there's no device-metrics emulation, and `shrinkPng` (`pngScale.ts`) scales the PNG to CSS pixels on the server.

## Verdict

| Check | Result | Evidence |
|---|---|---|
| Round 2.1: cursor in the floating preview during a drag | **not reached** | The only drag (+252.9 s) came after the recording ended. The floating preview wasn't on screen then anyway: at 01:54:51 the person at tty7 switched to the `excalidraw-cloud` thread (`frames/switch-015449-015453.png`, `frames/015453.png`), and the floating preview is per-thread. The two clicks (+215.0 s, +226.6 s) also happened with no preview showing. |
| Round 2.2: resize reply | **pass** | +8.2 s: `"viewport":{"width":1024,"height":768}` for tab 1, sent 1.1 s after the call. +23.2 s: the same for tab 2, after 0.1 s. Each tab's `innerWidth/innerHeight` was then 1024×768 (+30.9 s, +31.7 s). |
| Round 2.3: no half-size flash on snapshots | **pass (non-`save` snapshots only)** | I checked every frame of the floating preview from 01:51:23 to 01:51:35 and from 01:51:37 to 01:51:49 (`frames/mini-0124-0136.png`, `frames/mini-0138-0150.png`). They cover both snapshots (+11.3 s, +25.3 s), and neither has a half-size frame. The only changes are the expected ones: blank while loading, then the fill aspect for about 2 s until the resize applies, then 4:3. The round-1 flash happened on `save:true` snapshots, and none were taken here. The capture path is now the same for both kinds (`captureAtSize`), so the flash is probably gone, but this run didn't show it. |
| Round 2.3: snapshot size vs image | **pass** | `seen/001` and `seen/002` are both 1024×768 and match the reported viewport. They took 0.4 s and 0.3 s, so `shrinkPng` was fast on the 1.78× capture. |
| 1. Page 1024×768; snapshots report it | pass | See above. |
| 2. Spiral drawn with input-tool drags | **fail** | One `preview_drag` with a 181-point `path` at +252.9 s timed out after 15 s. The scene then held one freedraw element with 87 points (+341.3 s, read through tab 1). |
| 3. Dot at the centre | not reached | |
| 4. Final snapshot | not reached | Every later operation on tab 2 timed out. |
| Watch for: panel/cursor on the resized tab | not reached | See 2.1. |

## Problems

### 1. The hang: the display stopped, the drag never finished, and that one stuck call jammed the tab for good (app or environment trigger; tool bug in how a stuck operation is handled)

**What happened, in order:**

- +210 s (01:54:47): the question was answered (see problem 3).
- 01:54:51: the person at tty7 switched T3 to the `excalidraw-cloud` thread. From then on, the tab wasn't shown anywhere on screen.
- 01:55:03 (+226 s): **the session's VT was switched away.** The Ash log has `logind: session paused` at 01:55:03.56 and no resume afterwards. At the same moment the recording died: `ffmpeg.log` shows `kmsgrab: Plane 206 no longer has an associated framebuffer`.
- +226.6 s: a locator click took 3.4 s. The earlier coordinate click took 0.3 s, so this was the first sign that frames had slowed down.
- +252.9 s: `preview_drag` was sent. It reached about half the path, leaving a freedraw element with 87 points, and then stalled.
- From 01:56:31 on, the Ash log shows renderer 1207809 with `EXO-STALL renderer: 61 … 100 … 200 frames await presentation feedback`. That renderer is producing frames that are never presented.

**Why every later call on tab 2 failed:**

- Agent actions on a tab run one at a time, through `SessionControl.enqueue` (`apps/server/src/preview/SessionControl.ts:37`).
- The 15 s timeout rejects the caller's promise, but it doesn't cancel the operation underneath. The drag's `run()` was still waiting inside `dragPath` (`page.mouse.move` → CDP `Input.dispatchMouseEvent`) and never settled.
- So the queue's tail never moved. The two snapshots and the evaluate (+272 s, +292.9 s, +313.6 s) were queued behind the drag and never started, which is why each one timed out after exactly 15 s.
- `preview_status` (17 ms) doesn't queue, so it answered, and it still reported the tab as healthy. Tab 1 has its own queue, so it kept answering (+333.5 s, +341.3 s).
- `dragPath`'s `finally`, which lets the button go, never ran because the `await` above it never returned. So the button is probably still held in tab 2, which matches what the tester suspected.

**Ruled out:**

- **`pngScale.ts` blocking the event loop.** No snapshot ran between +25.6 s and the drag, and the drag hung first. While tab 2 was stuck, the server answered `preview_status` in 17 ms and tab 1's evaluate in 30 ms, so the event loop was free.
- **A capture lock left held.** The drag doesn't take `captureLock`, and the hang started with the drag.
- **Round 2's changes.** `dragPath` isn't in the e07d9f0382 diff. In round 1, the same code drew a 151-point spiral in 2.4 s while the display was on.
- **The second tab.** It has its own queue, and the other tab stayed usable. It only made the run harder to read.

**Likely cause:** CDP mouse moves don't complete while the page isn't producing presented frames. Blink lines `mousemove` up with animation frames, so the dispatch acknowledgement waits for a frame. Two things stopped frames here: the tab dropped off screen at 01:54:51, and the display was paused at 01:55:03. I can't tell which of the two stalled the drag, or why 87 moves got through first.

**What would tell:** re-run with tty7 left in front and the tester's thread left selected. Then reproduce each condition on its own: switch threads in the middle of a drag, and `chvt` in the middle of a drag.

**Suggested fixes (tool side):**
- When an operation times out, stop it from blocking the tab. For example, mark the tab's queue as poisoned and have the next call reset it: dispatch a `mouseReleased` directly through CDP, then start a fresh tail. Or detach and re-attach the CDP session.
- `preview_status` should report a stuck operation, for example `busy: {operation:"drag", since:…}`, rather than reporting a healthy tab.
- Optionally, give drag and snapshot errors a hint when the tab isn't presenting frames ("the tab isn't on screen / the display is off").

### 2. `profileId:"incognito"` doesn't isolate a desktop-rendered tab (tool bug)

At +20.6 s, the agent opened tab 2 with `profileId:"incognito"`. It loaded the same 6-element scene as tab 1, and its `localStorage` keys matched tab 1's (+30.9 s, +31.7 s). Clearing the scene in tab 2 also cleared it in tab 1 (+341.3 s).

In `ServerBrowser.ts` (around lines 790–800), `isolatedContext` requires `desktop === null`, and a desktop tab uses `desktop.page.context()`. So incognito, and the throwaway storage meant for agent tabs, never apply when the desktop renders the tab. I didn't check whether `connectDesktop` passes the profile to the shell at all.

Suggested fix: either open desktop tabs in the requested (OTR) profile, or reject `profileId` for desktop tabs with a clear error rather than ignoring it.

### 3. The test session's profile still carries earlier runs' drawings, and that cost about 3 minutes (app or environment; still open from round 1)

The canvas opened with the round-1 spiral and dot and the `excalidraw-cloud` ellipses (`seen/001`). Because the tester was told not to work around problems, it asked the user with `AskUserQuestion` (+40.9 s). The answer, "Clear canvas first", came 169 s later.

That explains the gap between +23 s and +269 s: about 3 minutes of waiting for that answer, then the clear (Ctrl+A, Delete), choosing the pencil, and generating the path with Bash (+215 to +230 s). The drag itself was sent at +252.9 s. The person who answered then switched threads and VTs, which set off problem 1.

Fix, as in round 1: give each run a fresh profile in `run.sh`, or clear the scenario's origin before the run starts. The scenario could also say "clear the canvas if it isn't empty", so the tester doesn't have to ask.

### 4. The recording stops when the VT changes (environment)

kmsgrab fails as soon as tty7 loses the display, so everything after +227 s is missing, including the step this scenario exists to check. `run.sh`/`session.sh` could warn when the session's VT isn't in the foreground during a run, or record from the compositor instead.

## The tester's report

It's accurate. It correctly reported:
- the 15 s drag timeout;
- the tab staying unresponsive while `preview_status` said it was fine;
- the other tab still working;
- the partial stroke (87 of 181 points);
- the incognito isolation bug;
- that the clear deleted the old drawing for both profiles.

Its guess that the button was still held is probably right (see problem 1).

It couldn't have known about the VT switch or the thread switch, so it doesn't mention them. It calls the hang a drag bug. In fact the trigger was the stopped display, and the tool's bug is that one stuck call wedges the tab for good.

Opening a second tab is a small departure from "don't build a workaround". It was a reasonable test of a documented parameter, though, and it found problem 2.

## Compared with earlier runs

Against `20261024-142711-excalidraw-spiral-sized` (round 1):
- **Fixed:** the `preview_resize` reply now gives the new viewport (round-1 problem 2).
- **Probably fixed, not fully confirmed:** the half-size flash. No flash on plain snapshots; `save:true` wasn't exercised (round-1 problem 3).
- **Still not exercised:** the agent cursor, in either the panel or the floating preview.
- **Still open:** leftover canvas state between runs (round-1 problem 4), which this time indirectly caused the failure.
- **New:**
  - a stuck operation wedges its tab permanently, and `preview_status` doesn't show it (problem 1);
  - `profileId:"incognito"` is ignored for desktop tabs (problem 2);
  - the recording is lost on a VT switch (problem 4).
- **Next run:** keep tty7 in front and the tester's thread selected until the run ends, and start with a fresh profile.
