# excalidraw-incognito: 2026-10-24 (test session at `t3/fix-drag` 47468be, claude-opus-5-5)

Run `logs/agent-tests/20261024-194129-excalidraw-incognito`, thread `mcp:adc29d48-49df-4dbc-9dc0-d1e001915352`: completed after 1.7 min; 21 tool calls, 0 failed.
This is the scenario's first run. It tests the incognito part of the drag fix: T3 0a5a7d9d1d ("incognito tabs on the desktop": the server passes `incognito: true` in its `open` command to the helper, and the shell page calls `createTab(url, tag, true)`) and Chromium patch 0045 (`builds/561f1493e9ae`). With these, `preview_open {profileId:"incognito"}` should open a desktop tab with throwaway storage of its own.

## Verdict

Incognito tabs work. The private tab opened through the tool's own option, started with empty storage, and showed in the floating preview. It took the agent's input with the cursor in the right place, and its circle never reached the normal tab, even after a reload. The one new problem is what the user sees: when the agent went back to the first tab, the floating preview stayed on the private tab.

| Check | Result | Evidence |
|---|---|---|
| 1. Private tab opened with the tools' incognito option | **pass** | +41.2 s `preview_open {"url":"https://excalidraw.com","reuseExistingTab":false,"profileId":"incognito"}`. The result lists `tab_2` with `"profileId":"incognito"` and `tab_1` with `"default"`. `preview_status` (+8.4 s) had offered the `incognito` profile (`"incognito":true`). Nothing was faked: no storage clearing, and every evaluate only read `localStorage`. |
| 2. Private tab starts empty | **pass** | +47.7 s: evaluate on `tab_2` read `localStorage['excalidraw']` and got `[]`. The tab's first snapshot `seen/003` shows the welcome screen, byte-identical to tab 1's first snapshot `seen/001` taken before the square. Tab 1's storage held `[rectangle 150×150]` at +33.7 s, so the two tabs really had separate storage, not just different screens. |
| 3. Normal tab still has only the square, after a fresh read | **pass** | +78.3 s: evaluate on `tab_1` got `[rectangle]`. +78.4 s: `preview_navigate` reloaded it. +87.4 s: evaluate after the reload got `[rectangle]` again. `seen/005` shows only the square, and undo is greyed out, which confirms a fresh page load and not the old in-memory state. Tab 2's storage at +66.7 s held only `[ellipse 150×150]`. |
| 4. Both shapes drawn with input tools; final snapshots show them | **pass** | Square: `preview_press r` and a Shift `preview_drag` (+27.5 s). Circle: `preview_press o` and a Shift `preview_drag` (+58.5 s). `seen/002` shows the square at (250–400, 450–600). `seen/004` shows the circle at (850–1000, 450–600). Both match the drag paths exactly. |
| 5. Both tabs keep working across switches | **pass (partial)** | Every call took ≤1.6 s except the first `preview_open` (5.4 s, a cold load), and none failed. Every call passed an explicit `tabId`, and each landed in the tab it named (see the storage reads). But the agent sent no *input* to tab 1 after tab 2 existed: it only evaluated, navigated and snapshotted it. So "input to the right tab after switching back" wasn't exercised. |
| Watch for: private tab shows in its element and takes input | **pass** | The floating preview switches to the private tab's welcome screen on open (`frames/064222.png`). It then shows the circle being drawn (`frames/064236.1.png`; `frames/crop-064236.1.png`: the circle, its selection box, and the properties panel). The side panel never opened. |
| Watch for: agent cursor in the tab being driven | **pass** | During the square drag the cursor sits on the square in tab 1's preview (`frames/064205.3.png`). During the circle drag it sits at the drag's end corner in the private tab's preview (`frames/064236.1.png`), then fades (`frames/064245.png`). No cursor showed up in the wrong tab. After the switch back, only navigate, evaluate and snapshot ran on tab 1, and those draw no cursor. |

## Problems

### 1. The floating preview stays on the private tab while the agent works on the first tab (user-visible glitch)

From +78.3 s to the end (06:42:55–06:43:16), the agent worked only on `tab_1`: an evaluate, a reload, an evaluate and a snapshot. The floating preview showed the private tab's circle the whole time. A montage of the preview at 2 frames/s (`frames/preview-montage-064254.png`) from 06:42:54 to 06:43:08 shows the circle in all 28 frames, and `frames/064315.png` still shows it at the end. The user never saw the first tab reload or end up with only its square, and nothing on screen tells them which tab the agent is driving. Single-tab scenarios can't show this.

Cause: `ChatView.tsx` (around line 5495) calls `usePreviewMiniPlayerStore.open(...)` only for a server session that is *fresh*: a new tab, or a new `revealRequest`. Actions on an existing tab don't move the floating player, and `preview_navigate` on `tab_1` doesn't seem to send a reveal request. Suggested fix: when the agent drives a different tab of its own (navigate, or any input action, maybe also snapshot), point the floating player at that tab. Alternatively, have the navigate/act path send a non-forced reveal request. To check the second option, see whether `revealRequest` changes on `preview_navigate` in `apps/server/src/preview/ServerBrowser.ts`.

### 2. `preview_open` says `visible:false` for both tabs (known, not this branch's)

+16.6 s and +42.8 s: `"visible":false`. The floating preview showed each tab. The tester told the user "you may not have seen the tabs appear", which was wrong. This is fixed on `t3/fix-recorder` but not merged here.

### 3. `preview_press` and `preview_drag` return only `{"toolIcon":…}` (description gap, low)

Every press and drag result was just `{"toolIcon":{"_tag":"website","pageUrl":…}}`. The tester said it couldn't tell from the result whether a drag had worked, so it checked with an evaluate and a snapshot each time. That cost nothing here, but nothing in the result confirms the action ran or says where it landed. Suggested fix: return a short `{ok, tabId}` (and the final pointer position for drags), or have the descriptions say that a bare result means success and that `preview_snapshot`'s action history is how to check.

### 4. The private tab's first request for the page was aborted (unexplained, harmless here)

The private tab's network entries start with `GET https://excalidraw.com/` `failed:true net::ERR_ABORTED` at 06:42:18.483, about 140 ms after the open (06:42:18.34). A second GET 500 ms later returned 200. Tab 1's entries have no aborted request. The tester reported this accurately. A plausible cause, not checked: two navigations race on the new incognito tab. One would come from the helper's `open` (`DesktopBrowserChannel.open`, now with `incognito`), the other from `PlutoniumBrowserTab`'s `lease.ready` → `navigate(initialUrl)` in `PlutoniumBrowserHost.tsx`, if the tab's URL still reads as blank at that moment. To tell, check the helper log for two navigations of `tab_2`, or log `current` in that `lease.ready` handler.

### Notes (not problems)

- Nothing in the preview marks a tab as private. In the floating preview the private tab looks exactly like the normal one. The UI has no incognito badge anywhere (the only `incognito` matches in `apps/web/src/**/*.tsx` are in settings), so this is a possible follow-up, not a regression.
- This run shows the two tabs have separate storage. It doesn't show the private storage is off the record, rather than just another profile. That would show if the private storage were gone after an app restart, or if Ash logged an OTR profile being created.
- `logs/ash-wayland-plutonium-s6.log` warns "Multiple CacheStorage instances using the same directory" at 06:41:54, 06:42:20 and 06:43:09. One of those is right after the private tab opened, but the others go with normal-tab loads, so it isn't specific to incognito. There are no coredumps. T3's server log has only telemetry noise and a stream-closed warning after the run ended (06:43:20).

## The tester's report

It's accurate about the result: the square stayed out of the private tab, the circle stayed out of tab 1, and tab 1 had only the square after the reload. Each claim is backed by its evaluates and snapshots, as it says. Its notes on `ERR_ABORTED` and the bare press/drag results are also accurate. What it got wrong or left out:

- It said the user "may not have seen the tabs appear" (problem 2). The floating preview showed both tabs.
- It couldn't know that the floating preview stayed on the private tab for the final check (problem 1). So "I came back here" was true for the agent but not for what the user saw.
- It said it confirmed a drag through "the tab's action history". The timeline shows it confirmed with `localStorage` evaluates and snapshots. That makes no difference to the result.

## Compared with earlier runs

- **New:** this is the first incognito run, and incognito tabs work (checks 1–4).
- **New:** the floating preview doesn't follow the agent back to an existing tab (problem 1). The single-tab spiral and cloud runs couldn't reach this.
- **Still working:** the floating preview's agent cursor follows drags, as in `20261024-193013-excalidraw-spiral-sized` and `20261024-193218-excalidraw-cloud`, and now in a private tab too.
- **Still failing, known:** `visible:false` while the floating preview shows the tab (fixed on `t3/fix-recorder`, not merged).
