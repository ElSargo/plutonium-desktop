# excalidraw-incognito: 2026-10-24 (test session at main 05017b9, claude-opus-5-5)

Run `logs/agent-tests/20261024-200843-excalidraw-incognito`, thread `mcp:e0fab542-e104-443e-9ddf-a294125c6d4d`: completed after 1.5 min. It made 23 tool calls and none failed: 1 ToolSearch, 3 Reads of saved screenshots, and 19 preview tools.

It ran in a fresh session from main with no `--ref`:
- Chromium built from main's patches (0045 parked popups, 0046 incognito tabs);
- T3 from the `plutonium` branch (bb3e35d338);
- a fresh T3 server;
- `--show`, with a screen recording of the whole run.

It's the final check, on main, of two fixes:
- **Incognito tabs (drag fix):** `preview_open {profileId:"incognito"}` opens a desktop tab with throwaway storage of its own.
- **Recorder fix:** `visible` counts the floating preview.

## Verdict

Incognito tabs work on main, as they did on `t3/fix-drag`. `visible` is now right per tab: it is true for the tab the floating preview shows and false for the other. The one new finding is cosmetic: `preview_navigate`'s reply reports its own navigate as `busy`.

| Check | Result | Evidence |
|---|---|---|
| 1. Private tab opened with the tools' incognito option | **pass** | At +8.4 s, `preview_status` listed the `incognito` profile (`"incognito":true`). At +32.6 s the agent called `preview_open {"url":"https://excalidraw.com","reuseExistingTab":false,"profileId":"incognito"}`. Its result lists `tab_2` with `profileId:"incognito"` and `tab_1` with `"default"`. Nothing was faked: every evaluate only read `localStorage`. |
| 2. Private tab starts empty | **pass** | At +43.8 s, an evaluate on `tab_2` read `localStorage['excalidraw']` as `[]`. Tab 1's storage held `[rectangle 150×150]` at +32.6 s. `seen/003` shows tab 2 on Excalidraw's welcome screen. |
| 3. Normal tab still has only the square after a fresh read | **pass** | At +69.0 s, `preview_navigate` reloaded `tab_1`. At +70.3 s an evaluate read `[rectangle]`. `seen/004` shows only the square, and undo and redo are greyed out, so this is a fresh load. Tab 2's storage held only `[ellipse 150×150]` (+61.3 s, `seen/005`). |
| 4. Both shapes drawn with input tools; final snapshots show them | **pass** | The square came from `preview_press r` plus a Shift `preview_drag` from (300,450) to (450,600) at +24.8 s. The circle came from `preview_press o` plus a Shift `preview_drag` from (800,450) to (950,600) on `tab_2` at +57.8 s. `seen/004` and `seen/005` show each shape where its drag put it. |
| 5. Both tabs keep working across switches | **pass (partial)** | No calls failed. The slowest was `preview_open` at 4–5 s. Every call after tab 2 existed named its `tabId`, and each landed in that tab, as the storage reads show. As in the earlier run, no *input* went to tab 1 after the switch back, only a navigate, an evaluate and a snapshot. |
| Watch for: private tab shows in its element and takes input | **pass** | `frames/open2-montage.png` (2 fps from 07:09:24): the floating preview shows tab 1's square, then a blank card while the private tab loads, then the private tab's welcome screen. `frames/circle-montage.png` shows the circle being drawn there. The side panel never opened. |
| Watch for: agent cursor in the tab being driven | **pass** | `frames/square-montage.png`: the cursor follows the square drag in tab 1. `frames/circle-montage.png`: it follows the circle drag in the private tab, then fades. No cursor showed in the wrong tab. |
| Fix: `visible` counts the floating preview | **pass** | Tab 1's `preview_open` (+15.4 s) said `visible:true`, and the floating preview was showing it. Tab 2's open (+37.8 s) said `visible:true`, and its `tabs` list said `tab_1 visible:false` and `tab_2 visible:true`. The preview had switched to tab 2 (`frames/open2-montage.png`). The navigate (+69.7 s) and the final snapshot on `tab_1` said `visible:false`. All through that period the floating preview showed tab 2's circle (`frames/back-montage.png`, 07:09:59–07:10:07; `frames/071005.png`). Every value matches the recording. |
| Fix: `busy` in status | **shown, with a quirk** | `busy` appeared once, in `preview_navigate`'s own reply (problem 1). |

On the open risk that a hidden background embed (opacity 0) counts as visible: this run is evidence against it, though not proof. Tab 1 kept working in the background, so a background embed was probably drawing it, and every reply still reported it `visible:false`. `visible` comes from `onScreen` (`apps/server/src/preview/ServerBrowser.ts:1454`): `tab.viewers.size > 0` or the relay's `Plutonium.getTabs` `embedded` flag (`:791`). To settle the risk, log `embedded` for a tab in `PlutoniumBrowserHost.tsx`'s background branch (`:213`).

## Problems

### 1. `preview_navigate`'s reply says its own navigate is still running (tool bug, low)

At +69.7 s, `preview_navigate` on `tab_1` returned `"loading":false` together with `"busy":{"running":{"operation":"navigate","since":"07:09:59.824Z"}}`. The `since` is that same call's start. The navigate had finished: the next evaluate read the reloaded page, and the snapshot shows a fresh load. The tester flagged it as "done and busy at the same time".

The cause is in `executeTabOperation`'s `navigate` case (`apps/server/src/preview/ServerBrowser.ts:2121–2131`). It builds its reply with `statusWithTitle` inside `tab.control.agent(...)` (`:2099`), and `tab.control.activity.running` is still set while that runs, so `busyStatus` (`:1901`) reports the call itself.

Suggested fix: leave the caller's own activity out of `busy` in replies built inside the action. Alternatively, build the navigate reply after the action has finished. Any other operation that returns `statusWithTitle` from inside the queue has the same quirk.

### 2. Environment noise (no action)

- The "Update Available: Claude v2.1.310" toast covered T3's top right for the whole run (`frames/071005.png`).
- `t3-server.log` has a telemetry send failure (07:09:40) and `claude-query-stream-failed` at 07:10:25, 4 s after the end. The second is teardown.
- The Ash log has two "Multiple CacheStorage instances" warnings. One came with tab 1's load (07:09:06), the other with the private tab's (07:09:29), so they aren't specific to incognito.
- `coredumps.txt`: none.
- The agent read no network entries, so this run neither shows nor rules out the earlier run's `ERR_ABORTED` on the private tab's first GET.

## The tester's report

It's accurate:
- The square never reached the private tab, and the circle never reached tab 1.
- Tab 1 had only the square after a reload.
- The `busy`/`loading` contradiction is real (problem 1).

Unlike the earlier run, it no longer tells the user they may not have seen the tabs.

It says it "came back" to the first tab. That's true for the agent, but the user's floating preview stayed on the private tab (known backlog, below).

## Compared with earlier runs

- **Fixed:** `visible:false` while the floating preview showed the tab (problem 2 of `20261024-194129`). It's now right for each tab.
- **Still working:** incognito tabs (checks 1–4), and the cursor following drags in both tabs.
- **Known backlog, still present (not re-reported):**
  - The floating preview doesn't follow the agent back to tab 1 (`frames/back-montage.png`).
  - Nothing marks the private tab as private.
  - `preview_press` and `preview_drag` return only `toolIcon`.
- **New, low:** the `busy` self-report in `preview_navigate`'s reply (problem 1).
- **Not observed:** the earlier run's `ERR_ABORTED`, because the agent didn't read the network log.
