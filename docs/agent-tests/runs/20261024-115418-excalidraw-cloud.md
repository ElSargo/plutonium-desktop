# excalidraw-cloud: 2026-10-24 (live desktop, claude-opus-5-5)

Run `logs/agent-tests/20261024-115418-excalidraw-cloud`, thread `mcp:7380a1d2-393d-4198-b821-9020d83c5a81` (instance `claudeAgent_claude_2`): completed after 1.2 min; 24 tool calls, 3 failed (2 × `preview_recording_start`, 1 × `preview_recording_stop`).
A baseline run of the current build. It doesn't test a fix. There was no screen recording (live runs don't capture the screen).

## Verdict

| Check | Result | Evidence |
|---|---|---|
| 1. Recording starts and stops, video plays | fail | 22:54:33.86 and 22:54:41.33 `recordingStart failed: browserType.launch: Target page, context or browser has been closed`; 22:55:20.02 stop: `No recording is active for this thread.` No video. |
| 2. Clicks land (ref and coordinates, tab hidden or shown, no stale refs or 15 s timeouts) | partial pass | One ref click (22:54:49, `aria-ref=t3-39df6384-e-e57`, the Ellipse button) landed in 0.3 s with the tab hidden (`visible:false`). No coordinate click and no click with the tab shown, so those were not exercised. |
| 3. Part of the cloud drawn with the input tools | fail (missing capability) | All six ellipses were dragged out by `preview_evaluate` dispatching PointerEvents (22:54:54, 22:55:08–22:55:11). The input tools only chose the tool (`preview_click` at 22:54:49, `preview_press o`) and deleted or deselected (`Delete`, `Escape`). See problem 2. |
| 4. Final snapshot shows a cloud | pass | `seen/003-preview_snapshot.png`: a new five-puff cloud at the bottom right. The centre cloud was already on the canvas, left there by run `20261024-115103` (problem 5). |
| 5. Notices viewport changes; resize gives the size asked for | not reached | No `preview_resize` call. The panel never opened (`visible:false`), so the viewport stayed at 1280×800 (`box=0,0,1280,800` in the tree). |
| Watch for: cursor preview after resize | not checked: no recording | |
| Watch for: panel shows the tab live at the agent's size | not checked: no recording | `preview_open` reported `visible:false` (problem 4). |

## Problems

### 1. `preview_recording_start` can't launch its encoder browser on NixOS (tool bug, NixOS host)

Both starts failed at once (22:54:33.86 and 22:54:41.33, under 20 ms each) with `Preview automation recordingStart failed: browserType.launch: Target page, context or browser has been closed`. The stop at 22:55:20 then found nothing to stop. Both aborted runs hit the same error twice (`20261024-114950` at 22:50:04 and 22:50:11; `20261024-115103` at 22:51:17 and 22:51:36), and manual thread `e7f9bc64` hit it 4 times.

The cause: a recording doesn't capture with the tab's own browser. `startRecording` (`~/projects/t3code/apps/server/src/preview/ServerBrowser.ts:1518`) first calls `contexts.scratchPage()` to get a page to run the encoder script in. `scratchPage` (`apps/server/src/preview/ServerBrowserContexts.ts:193`) calls `sharedBrowser()`, which launches a separate headless browser with `chromium.launch(options)` (`ServerBrowserContexts.ts:126`). Its `executablePath` comes from `PreviewBrowser.executable`, the chrome-headless-shell that T3 downloads to `~/.t3/tools/chrome-headless-shell/linux64/154.0.8037.92/chrome-headless-shell`. That build is for generic Linux, and NixOS's stub loader refuses to run it. Running it by hand shows this:

```
$ ~/.t3/tools/chrome-headless-shell/linux64/154.0.8037.92/chrome-headless-shell --version
Could not start dynamically linked executable: …/chrome-headless-shell
NixOS cannot run dynamically linked executables intended for generic
linux environments out of the box.
```

The process exits at once, and Playwright reports that as "Target page, context or browser has been closed". The tab itself is a desktop page that Plutonium renders, reached through `connectDesktopPage` (`ServerBrowserContexts.ts:203`). So every other tool works, and only recording needs the headless shell.

The error doesn't say any of this. `diagnoseLaunchFailure` should replace the error with the missing host setup, but it only recognises glibc's `error while loading shared libraries:` (`LOADER_ERROR`, `apps/server/src/preview/PreviewBrowserHost.ts:94`, used at `:136`). It misses NixOS's `Could not start dynamically linked executable`, so the raw Playwright message gets through.

Suggested fix:
- On Plutonium, don't start a second browser just to encode. Run the encoder in a hidden page of the desktop browser that the helper opens, or encode the screencast frames in the server process.
- Failing that, point the executable at a Chromium or headless shell built by Nix, through an override that Plutonium sets.
- In either case, make `LOADER_ERROR` (or `missingLibraries`) recognise the stub-ld message, so the error names the cause.

### 2. No tool drags between two points, so a canvas can't be drawn on with input tools (missing capability)

The tester loaded `preview_drag` (ToolSearch at 22:54:24) but never called it. It said: "`preview_drag` only moves one page element onto another". The description it saw confirms that:

> `preview_drag`: "Drag one element onto another in the tab selected by tabId, or this agent session's current tab when omitted. Server browser tabs only." The parameters are `source` ("Locator of the element to drag…") and `target` ("Locator of the element to drop onto…"), both required, with no coordinates.

The code matches the description. `PreviewAutomationDragInput` (`packages/contracts/src/previewAutomation.ts:490`) takes only locators. `ServerBrowserPage.drag` (`apps/server/src/preview/ServerBrowserPage.ts:374`) calls `source.dragTo(target)` and never passes `sourcePosition` or `targetPosition`. `preview_click` and `preview_hover` take `x`/`y`, but neither can hold a button down, and no tool exposes `mouse.down`, `mouse.move` or `mouse.up`. Excalidraw's canvas is a single element, so `dragTo` can't draw a shape on it. This is not a description gap or an agent mistake: the capability doesn't exist. Building a `__drag` helper in `preview_evaluate` (22:55:05) was the only way, and the prompt asked for JS eval anyway.

Suggested fix: let `preview_drag` take `from: {x,y}` and `to: {x,y}` in place of `source` and `target`, optionally with a list of points and steps for curves. Implement it with `page.mouse.move/down/move…/up`, and move the panel's cursor preview along the same path.

### 3. Snapshot reports a screenshot size that doesn't match the image (tool bug, minor)

Every snapshot reported `"screenshot":{"width":1280,"height":800}`. The images returned and saved were 1138×711 (`seen/001–003`, and `~/.t3/userdata/browser-artifacts/browser-screenshot-excalidraw-com-mvlkiok9-c2eeef7a.png`). The tester noticed. It did no harm here, because the tester used CSS coordinates from the tree boxes: the Ellipse button is at `box=582,20,36,36` and appears at about x 533 in the image (×0.889).

Likely cause: `snapshot` computes its scale and the reported size from `RENDER_SCALE = 2` (`apps/server/src/preview/ServerBrowser.ts:87`, passed at `:2002`; `ServerBrowserPage.ts:187` and `:222–223`). That constant is the headless server browser's `--force-device-scale-factor=2`. A desktop tab renders at the desktop's own device pixel ratio, which is about 1.78 if 1138 = 1280 × 0.5 × DPR. To confirm, evaluate `devicePixelRatio` in a desktop tab. Fix: take the render scale from the page (from `Page.getLayoutMetrics` or `devicePixelRatio`), not a constant.

### 4. `preview_open` said `visible:false` although it opens the preview by default (unverified; possible tool bug or description gap)

At 22:54:30 the call had no `open` argument. The description says: "open its thread-bound inline preview by default … `open`: … Defaults to true". The result had `"visible":false`. `visible` is `tab.viewers.size > 0` at the moment the call returns (`ServerBrowser.ts:1420`), so a panel that attaches a moment later would still read false. Without a screen recording it's impossible to tell whether the panel opened. The viewport stayed at 1280×800 for the whole run, and the known issue says opening the panel narrows it to 539 px, which suggests the panel never attached. Check `--show` runs: if the panel does open, make `preview_open` wait for the viewer, or say in the description that `visible` can lag. If it doesn't open, it's a bug in the helper or the desktop channel.

### 5. Runs share the default profile's storage (test environment)

Excalidraw opened with five ellipses already in `localStorage` (22:54:41, `count:5`; `seen/001`). Run `20261024-115103` drew those 22:51–22:52, after clearing the canvas left by earlier runs. Leftover state makes check 4 ambiguous and could mislead a tester. Fix: open scenario tabs in a fresh profile (`profileId`), have `run.sh` clear the site's storage, or tell the tester in the scenario to clear the canvas first.

### 6. `actionTimeline` leaves out `preview_evaluate` (minor; possibly by design)

The tester noted that the snapshot's action history lists the click and the presses but none of the 8 evaluates. In `ServerBrowser.ts:2040`, `evaluate` isn't wrapped in `recordAction` the way `drag`, `press` and the others are. If the timeline is meant to show everything the agent did to the page, wrap it. If not, say in `preview_snapshot`'s description that it lists input actions only.

## The tester's report

The report is accurate, and it didn't spend time on workarounds. It quoted both recording errors exactly, and it correctly said that no input tool drags between coordinates. It also correctly flagged `visible:false`, the leftover cloud, the missing evaluates in the timeline and the scaled screenshots.

What it left out or got slightly wrong:
- It didn't try a coordinate click, `preview_hover`, or `preview_resize`, so checks 2 (coordinates) and 5 weren't exercised. The prompt didn't ask for them.
- It said the canvas state came "from an earlier session in the default profile". It came from the previous agent test run, `20261024-115103`.
- "Coordinates in the page structure didn't line up with the image at 1:1" is right, but the real defect is that the reported size (1280×800) is wrong (problem 3).

## Compared with earlier runs

No earlier reports exist. Compared with the known issues from manual thread `e7f9bc64`:
- Still failing: `preview_recording_start` gives `browserType.launch: Target page, context or browser has been closed`, every time, in this run and both aborted ones. Cause now found (problem 1).
- Better: the tester didn't build an in-page recorder or try to smuggle a video out. That's because the prompt now says not to build workarounds.
- Not seen: the 15 s role-locator timeout with the tab hidden (no role-locator clicks), and the stale ref right after a snapshot (only one ref click, which worked).
- Not exercised: the `<a download>` that never appeared in `downloads`, and the 539 px viewport after `preview_open` (the panel never attached, problem 4). The cursor preview mismatch after a resize: not checked, no recording.
- New: the missing coordinate drag (problem 2; the aborted run `115103` concluded the same at 22:52:00), the wrong screenshot size (3), leftover profile state (5), and evaluates missing from the timeline (6).
