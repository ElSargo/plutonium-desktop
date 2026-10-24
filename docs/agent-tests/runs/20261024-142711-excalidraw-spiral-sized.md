# excalidraw-spiral-sized: 2026-10-24 (test session at `t3/fix-drag` b7156bb, T3 860e0454af; claude-opus-5-5)

Run `logs/agent-tests/20261024-142711-excalidraw-spiral-sized`, thread `mcp:f6652832-f654-4ad4-b58f-142dddf195cf`: completed after 2.1 min; 29 tool calls, 0 failed. Test session on tty7 with `--show` and a screen recording (2560×1600, 4 fps).

Fix under test: the third part of `drag` (T3 commit 860e0454af). `PlutoniumBrowserTab` now publishes its content layout (`x`, `y`, `scale`) to `useBrowserSurfaceStore` (`PresentContent`, `apps/web/src/plutonium/PlutoniumBrowserHost.tsx`), and `AgentBrowserCursor` uses it. Before, the cursor assumed scale 1 at offset 0, so after `preview_resize` it drifted away from where clicks landed.

## Verdict

| Check | Result | Evidence |
|---|---|---|
| Fix: panel cursor follows a resized, scaled tab | **not checkable** | The tab was never in the side panel. It showed only in the floating preview (bottom right, about 570 px wide at native resolution, so roughly 0.56× of the 1024 px page) for the whole run (`frames/overview.png`). The floating preview (`BrowserMiniPlayer`, `apps/web/src/components/preview/ThreadPreviewMiniPlayer.tsx`) doesn't render `AgentBrowserCursor`; only `PreviewView` does (`PreviewView.tsx:1123`). In every frame through the spiral drag (01:30:56.6–01:31:00.6, every 0.25 s, `frames/spiral/`, `frames/spiral-montage.png`) and the dot drag (01:31:43.1–01:31:45.1, `frames/dot/`, `frames/dot-montage.png`), the stroke grows live and no cursor is drawn anywhere near it. See problem 1. |
| 1. Page set to 1024×768; snapshots report 1024×768 | **pass** | `preview_resize {"mode":"freeform","width":1024,"height":768}` at +16.6 s. `preview_status` +21.7 s: `viewportSetting` freeform 1024×768. `innerWidth/innerHeight` 1024×768 (dpr 1.78). All 7 snapshots: `"screenshot":{"width":1024,"height":768,"viewport":{"width":1024,"height":768}}`; `seen/001–006` are 1024×768. The floating preview switched to the 4:3 aspect between 01:30:14 and 01:30:18 (`frames/013014.0.png`, `013018.0.png`). The resize's own reply was wrong (problem 2). |
| 2. Spiral drawn with input-tool drags | **pass** | One `preview_drag` with a 151-point `path` at +56.6 s, 2.4 s. The recording shows the stroke growing from the centre outwards over about 1.75 s (`frames/spiral-montage.png`, from 01:30:57.6). The two `preview_evaluate` calls only read state (viewport, the active tool); neither drew. |
| 3. Dot at the spiral's centre | **pass** | Ellipse tool, red fill, then `preview_drag` (506,378)→(518,390) at +103.2 s: an ellipse centred on (512,384), the spiral's first point. `seen/006` shows the red dot at about (512,384). The agent used the centre it had computed for the path rather than reading one off a snapshot; the snapshots confirmed it. Excalidraw's smoothing makes the innermost curl look slightly off, as the tester said. |
| 4. Final snapshot: spiral of ~3 turns with red dot | **pass**, but over old drawings | `seen/006` and the saved `browser-screenshot-excalidraw-com-mvlq45pa-d6655acf.png`: three turns, red dot at the centre. The canvas already held the four light-blue ellipses from the earlier `excalidraw-cloud` run, and the spiral overlaps them (problem 4). |
| Watch for: panel shows the tab at the size the agent set | pass (floating preview) | The floating preview shows the page at 4:3 from 01:30:18 on, fitted to its frame. The side panel never opened. |

## Problems

### 1. The cursor fix can't be seen: the tab stays in the floating preview, which has no agent cursor (test gap; possibly missing capability)

`preview_open` returned `"visible":false` at +12.2 s, the right panel never opened, and the tab showed only in the floating preview the whole run (`frames/overview.png`, one frame every 5 s). `BrowserMiniPlayer` renders a `BrowserSurfaceSlot` with `fitSourceContent` and nothing else: no `AgentBrowserCursor`. So the fix's code path (`PresentContent` → `AgentBrowserCursor` in `PreviewView`) never drew anything here. At 4 fps the spiral visibly grows frame by frame from 01:30:57.6 to 01:30:59.4, and no pointer is anywhere on the preview.

The ring at the floating preview's top-right corner (about (567,32) in the cropped frames) stays put for the whole run, including while the agent clicks toolbar buttons and drags. The earlier report wondered whether it was a parked cursor. Since the mini player doesn't render the cursor, it's preview chrome, not the cursor.

To test the fix, the side panel has to show the tab. Either:
- the scenario prompt asks for the browser panel to be open (or the runner opens it before the prompt), or
- the floating preview gets the agent cursor too. That's arguably what the user wants: it's where they watch the agent when the panel is shut. It would need the same layout data. `fittedSourceContent` is already in the store, so `BrowserMiniPlayer` could render `AgentBrowserCursor` with it.

### 2. `preview_resize` replies with the old viewport (tool bug)

At +16.6 s, `preview_resize` to 1024×768 returned `"setting":{"_tag":"freeform","width":1024,"height":768},"viewport":{"width":1280,"height":800}`. The page was 1024×768 by +21.7 s (`preview_status`, `innerWidth`/`innerHeight`, every snapshot). The reply's `viewport` is read before the resize takes effect, after only 18 ms. It probably comes from `apps/server/src/preview/ServerBrowser.ts`'s resize handling, which returns the tab's last reported viewport; I haven't confirmed where. An agent that trusts the reply would think the resize failed. Fix: wait for the page to report the new size before replying, or leave `viewport` out and say to use `preview_status`. The tester flagged this correctly.

### 3. A `save:true` snapshot makes the floating preview flash the page at about half size in its top-left corner (user-visible glitch)

Both `preview_snapshot {"save":true,…}` calls (+103.2 s and +115.4 s) coincide with one frame in which the floating preview draws the page at about 0.55× of its fitted size, in the top-left corner, with white elsewhere: `frames/dot-montage.png` at 01:31:44.1, and `frames/save-glitch.png` at 01:31:56.1. The five snapshots without `save` show no such frame (`frames/snaps.png`). The scale is close to 1/devicePixelRatio (1/1.78), which suggests that the save path captures in a way that briefly re-lays out or re-scales the live view. One possibility is a capture with a scaled clip, which Chromium does by emulating device metrics. I haven't traced which capture path a Plutonium tab's `save` uses (`apps/web/src/plutonium/previewBridge.ts:604` marks `captureScreenshot` "unsupported", so it goes elsewhere). To find it, check what the save path calls for desktop tabs and whether it changes the page's device metrics. It lasts one frame (≤0.25 s), but users would see it as flicker.

### 4. The test session's browser profile carries the previous run's drawing (app or environment)

`seen/001` shows the four blue ellipses from `excalidraw-cloud` (run `20261024-142128`, same session and T3 home `~/.local/share/plutonium/at-drag/t3-home`). Excalidraw saves its scene in the profile's local storage. That's also why new shapes defaulted to light blue. It doesn't affect the tool checks, but results are harder to read and the "final result" check is muddied. Fix: in `run.sh`, give each run a fresh browser profile, or clear site data for the scenario's origin before it starts.

## The tester's report

It's accurate:
- It flagged the wrong `viewport` in the resize reply (problem 2).
- It flagged the leftover drawing (problem 4) and correctly didn't blame itself.
- It explained the pale-pink default shade and the typed hex as normal app use.
- Its description of the spiral (151 points, 3 turns, radius 170) and the dot (12 px, centred on (512,384)) matches the evidence.

It left out:
- The save-snapshot flicker (it couldn't see the screen).
- That the user couldn't see an agent cursor. It had no way to know.

Its item 3 ("some locator results were empty or slow to load") isn't a tool problem, as it said itself.

## Compared with earlier runs

Against `20261024-142128-excalidraw-cloud`:
- **Now passing:** multi-point path drags (curves/freehand), which weren't tried there. `preview_resize` sets the page size, and snapshots then report 1024×768 for both the image and the viewport.
- **Still not exercised:** the panel cursor after a resize. This time the resize happened, but the tab again stayed in the floating preview, which has no cursor. The ring at the preview's corner is chrome, not a parked cursor; that settles the earlier report's question.
- **Still open:** `preview_open` says `visible:false` while the user sees the tab in the floating preview.
- **New:** the stale `viewport` in the resize reply (problem 2), the half-size flash on `save:true` snapshots (problem 3), and leftover canvas state carried between runs in one test session (problem 4). The earlier run had a fresh profile, so problem 4 couldn't appear there.
