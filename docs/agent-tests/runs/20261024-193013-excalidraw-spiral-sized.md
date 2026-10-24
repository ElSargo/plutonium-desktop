# excalidraw-spiral-sized: 2026-10-24 (test session `at-drag` at `t3/fix-drag` 47468be, T3 fix/drag 0a5a7d9d1d, Chromium `builds/561f1493e9ae`; claude-opus-5-5)

Run `logs/agent-tests/20261024-193013-excalidraw-spiral-sized`, thread `mcp:f0c0eb26-7267-4d27-97bd-c4f365fde632`: completed after 1.6 min. 16 tool calls, 0 failed: 1 ToolSearch, 1 Bash (to compute the path points), and 14 preview tools. The session ran on tty7 with `--show` and a screen recording (2560×1600 at 4 fps, covering the whole run).

Fix under test: `drag`, rounds 1–3.
- **Round 1:** `preview_drag` takes a `path`, and snapshot images come at the page's CSS size.
- **Round 2:**
  - the floating preview draws the agent cursor;
  - the `preview_resize` reply reports the new viewport;
  - no flash on `save:true` snapshots.
- **Round 3:**
  - a stuck action is abandoned at its timeout + 500 ms, and queued actions past their deadline don't start;
  - each mouse event fails after 5 s with "tab isn't drawing frames";
  - held buttons are released;
  - `preview_status` reports `busy`;
  - incognito desktop tabs get their own off-the-record profile.

## Verdict

| Check | Result | Evidence |
|---|---|---|
| Round 1: path drag | **pass** | +57.8 s: one `preview_drag` with a 181-point `path`, finished in 3.2 s. The stroke matches the path exactly: its inner end is at (516,400), the first point (`seen/002`). |
| Round 1: snapshot image size | **pass** | All 5 snapshots report `"screenshot":{"width":1024,"height":768,"viewport":{"width":1024,"height":768}}`. `seen/001–005` and the saved `browser-screenshot-excalidraw-com-mvm0tr3y-fa3341f4.png` are all 1024×768. |
| Round 2: cursor in the floating preview follows the path | **pass** | `frames/drag-montage.png` (one frame every 0.25 s from 06:31:16.5) shows the cursor at the centre at 06:31:17.25. It then sits on the growing tip of the stroke in every frame through 06:31:20.0, and fades after the drag ends. The dot drag behaves the same way (`frames/dot-montage.png`, 06:31:43.25–44.0): the cursor is on the spiral's centre. |
| Round 2: resize reply | **pass** | +24.9 s: `"viewport":{"width":1024,"height":768}`. The resize was sent 0.4 s after `preview_open`, before open had answered. It queued behind the open, which is why it took 4.5 s. |
| Round 2: no flash on `save:true` | **pass** | The only `save:true` snapshot ran from 06:31:46.33 to 46.57. Every frame from 06:31:42.5 to 47.5 (`frames/dot-montage.png`) shows the page at its fitted size, with no half-size frame. |
| Round 3: stuck action / `busy` / 5 s mouse timeout / button release | **not exercised** | Nothing stuck. The slowest call was 4.8 s (`preview_open`), and `preview_status` was never called. The display stayed on and the tester's thread stayed selected throughout (frames 06:30:40–06:31:56). |
| Round 3: incognito desktop tabs | **not exercised** | `preview_open` was called with only `url`. `profileId` and `incognito` appear in the transcript only in tool schemas. |
| 1. Page 1024×768; snapshots report it | **pass** | See the resize and snapshot-size rows. The floating preview switches to 4:3 (`frames/063118.png`). |
| 2. Spiral drawn with input-tool drags | **pass** | The pencil was chosen by a ref click (+38.4 s), then the spiral was drawn with the 181-point `preview_drag`. There was no `preview_evaluate`; the Bash call only printed the coordinates. |
| 3. Dot at the spiral's centre | **pass** | Red was set by ref clicks (+69.1 s, +76.7 s, `seen/004`: red stroke swatch). Then a 22-point scribble drag around (512,400) (+83.8 s). `seen/005` shows the red dot on the inner end of the curl. The point came from the computed spiral centre, which `seen/002` confirmed rather than the agent reading it off a snapshot. |
| 4. Final snapshot: ~3 turns with a red dot at the centre | **pass** | `seen/005`: three turns and a small red dot (about 6 px) at the centre. The canvas was empty at the start (`seen/001`). |
| Watch for: cursor sits where strokes are drawn | **pass (floating preview)** | See the round 2 cursor row. The side panel never opened (`visible:false`), so the panel's own cursor (`PreviewView`) still wasn't exercised. |
| Watch for: preview shows the tab at the size set | **pass (floating preview)** | 4:3 from the resize on, fitted to the preview (`frames/mini-063130.png`). The side panel wasn't shown. |

## Problems

### 1. `preview_open` says `visible:false` while the floating preview shows the tab (tool bug or description gap, still open)

+24.8 s: `"visible":false`. The tab was live in the floating preview from the first frames (`frames/063052.png`), and the right panel never opened. The tester flagged this and told the user the preview "may not have appeared on your side", which was wrong: the user did see it. This hasn't changed since the baseline. Either count the floating preview as a viewer (`visible` comes from `tab.viewers.size > 0` in `apps/server/src/preview/ServerBrowser.ts`), or have the description say that `visible` means the side panel only.

### 2. Round 3 and incognito weren't exercised (test gap)

The run had no stall, so the round-3 code paths didn't run: the abandoned action, deadline-skipped queue entries, the 5 s "tab isn't drawing frames" error, button release and `busy`. Incognito was never requested either. Checking them takes a deliberate stall, for example `chvt` away during a long path drag, then `preview_status` and a snapshot on that tab, plus a scenario that opens a desktop tab with `incognito`/`profileId` and compares `localStorage` with a normal tab. This run does at least show the round-3 queue changes didn't break normal back-to-back and parallel calls: open + resize at +20.0 s, and click + press + snapshot at +76.7 s.

### 3. Teardown noise and unrelated core dumps (environment, no action)

- `t3-server.log` shows `orchestration-v2.claude-query-stream-failed` at 19:31:59, 5 s after the thread completed. It lines up with `run.sh` killing the tester's leftover `claude` process (`leftover.txt`), so it's teardown, not a run failure.
- `coredumps.txt` has no Chromium dump from this session. The host's `drkonqi` crash loop is generating many SIGABRTs, which is why the "units are running" notice appears. The one `chrome` core nearby (19:29:13) is from `builds/293c83b0b339`, not this session's `561f1493e9ae`, and predates the run.

## The tester's report

It's accurate:
- the spiral really has 181 points, three turns and centre (512,400);
- the dot really is a red pencil scribble of about 6 px;
- every call did succeed.

Calling the dot "small … doesn't stand out much" is fair (`seen/005`).

The one error is about the user's side: it suggested the preview "may not have appeared", but the floating preview showed the whole run, cursor included (problem 1).

## Compared with earlier runs

- **Against round 1 (`20261024-142711`):**
  - Fixed: the stale `viewport` in the resize reply.
  - Fixed: the half-size flash on `save:true`, which is now confirmed in the recording.
  - Fixed: the missing cursor in the floating preview. It now follows the path.
  - Fixed: leftover canvas state. `session.sh` now gives the session a fresh profile, and the canvas started empty.
- **Against round 2 (`20261024-145112`):** the hang didn't recur, but the display and thread conditions that triggered it weren't repeated, so this run neither confirms nor rules out the round-3 fix.
- **Still open:** `visible:false` (problem 1), and the side panel's cursor on a scaled tab, which no run has yet shown.
