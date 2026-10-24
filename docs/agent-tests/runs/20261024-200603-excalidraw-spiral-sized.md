# excalidraw-spiral-sized: 2026-10-24 (test session at main 05017b9, claude-opus-5-5)

Run `logs/agent-tests/20261024-200603-excalidraw-spiral-sized`, thread `mcp:d656087b-e3b6-46d5-992d-e58d32b2cb9e`: completed after 2.0 min; 23 tool calls, 0 failed (1 ToolSearch, 1 Bash to compute the path points, 21 preview tools). Fresh session from main, no `--ref`: Chromium built from main's patches (0045 parked popups, 0046 incognito tabs), T3 from the `plutonium` branch (bb3e35d338), fresh T3 server, `--show`, screen recording of the whole run.

This is the final check of the drag fix and the recorder fix on main:
- **Drag fix:**
  - coordinate path drags;
  - snapshot images at page size;
  - the floating preview's cursor follows drags;
  - the resize reply reports the new viewport;
  - no flash on `save:true`;
  - stuck actions are abandoned;
  - `preview_status` reports `busy`;
  - incognito tabs.
- **Recorder fix:** `visible` now counts the floating preview. Earlier runs wrongly said `visible:false`.

## Verdict

Everything this scenario reaches works on main. `visible` is now right.

| Check | Result | Evidence |
|---|---|---|
| 1. Page 1024×768; snapshots report it | **pass** | +24.7 s `preview_resize {freeform,1024,768}` answered in 0.1 s with `"viewport":{"width":1024,"height":768}`. All 7 snapshots report `"screenshot":{"width":1024,"height":768,"viewport":{"width":1024,"height":768}}`, and `seen/001–007` are 1024×768. |
| 2. Spiral drawn with input-tool drags | **pass** | Pencil chosen by a ref click (+34.6 s). Then one `preview_drag` with a 181-point `path` (+60.3 s, 3.4 s). There was no `preview_evaluate`; Bash only printed the coordinates. `seen/002`: three turns, inner end at about (518,400), the path's first point. |
| 3. Dot at the spiral's centre | **pass** | Ellipse chosen by ref (+80.5 s). Stroke panel opened by a coordinate click at (40,96), read off `seen/002`'s swatch. Red stroke, red fill and Solid chosen by ref clicks (+87.2 s to +107.7 s). Then a 4-point drag from (505,393) to (519,407) (+107.7 s). The centre (512,400) was computed, and `seen/002` confirmed it, rather than reading it off a snapshot. `seen/007`: a solid red dot of about 14 px on the inner end of the spiral. |
| 4. Final snapshot: ~3 turns with a red dot at the centre | **pass** | `seen/007`. The canvas was empty at the start (`seen/001`). |
| Watch for: the cursor sits where strokes are drawn and follows the spiral | **pass (floating preview)** | `frames/drag-montage.png` (4 fps from 07:07:12.5): the cursor sits on the growing tip of the stroke in every frame, then fades after the drag ends. `frames/dot-montage.png` (07:07:59.8): it moves to the clicks, then to the centre for the dot drag. The side panel never opened, so the panel's own cursor still hasn't been seen. |
| Watch for: preview shows the tab at the size set | **pass (floating preview)** | Before the resize the card is 16:10 (`frames/070636.png`). After it, the card is 4:3 and the page fills it with nothing spilling out. I checked this with a contrast-boosted crop at 07:06:39. |
| Fix: `visible` counts the floating preview | **pass** | +16.5 s `preview_open` says `"visible":true`, and `tabs[0].visible:true`. The floating preview was showing the tab: it was blank while loading at 07:06:27 and showed the welcome screen by 07:06:36. The side panel never opened. |
| Fix: no flash on `save:true` | **pass** | The one `save:true` snapshot ran from 07:08:00.15 to 01.07. `frames/dot-montage.png` covers 07:07:59.8–08:02.8 at 4 fps, and every frame shows the page at its fitted size. |
| Fix: resize reply | **pass** | See check 1. |
| Fix: stuck action, `busy`, incognito | **not exercised** | Nothing stalled (the slowest call was `preview_open` at 5.5 s), `preview_status` wasn't called, and only the default profile was used. The incognito run (`20261024-200843-excalidraw-incognito`) covers `busy` and incognito. |

## Problems

### 1. Snapshot's `[active]` marker read as "selected" (description gap, low)

In the fill options, the accessibility tree marked `button "Hachure (Alt-Click)" [active]`, but the image showed Solid as the chosen fill (`seen/006`). The tester saw the mismatch, guessed it meant keyboard focus, and clicked Solid anyway. That guess is probably right: `[active]` in an aria snapshot marks the focused element. But no tool description in `apps/server/src/mcp/` or `apps/server/src/preview/` says so, so an agent can read it as the selected option. Suggested fix: in `preview_snapshot`'s description, a line saying that `[active]` means focused, and that `[pressed]`/`[selected]`/`[checked]` mean chosen.

### 2. Environment noise (no action)

- A "Update Available: Claude v2.1.310" toast sat over the top right of T3 for the whole run (`frames/070812.png`). It covers the panel toggles but nothing the agent used.
- `t3-server.log` has `orchestration-v2.claude-query-stream-failed` at 07:08:16, 5 s after the thread completed. That's teardown, when `run.sh` kills the leftover `claude` process (`leftover.txt`).
- The Ash log has only the usual DriveFs, uma and CacheStorage lines, and `coredumps.txt` is empty.

## The tester's report

It's accurate:
- It says the spiral has 181 points, three turns and its centre at (512,400), with the innermost point 6 px right of the centre.
- It says the dot is a 14 px ellipse with red stroke and solid fill, not a pencil dot. It explains why, which is a fair choice.
- It says every call succeeded.
- Its `[active]` observation is real (problem 1).

Unlike the earlier run, it doesn't claim the user might not have seen the preview.

## Compared with earlier runs

- **Fixed:** `visible:false` while the floating preview showed the tab (problem 1 of `20261024-193013`). It now says `true`, which matches the recording.
- **Fixed:** the resize reply, the flash on `save:true`, and the floating preview's cursor following path drags. All three hold on main, as they did on `t3/fix-drag`.
- **New, low:** the `[active]` description gap.
- **Still not seen:** the side panel's cursor on a scaled tab. No run has opened the side panel.
