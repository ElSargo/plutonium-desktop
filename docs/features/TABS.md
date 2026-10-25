# Browser tabs as elements

Date: 2026-10-16. Roadmap: Phase 5, item 1 ("Tabs per thread", `OPTION2_PLAN.md`). Chromium: `chromium/patches/0007-*.patch`, with tab automation in `0008`.

**Status:** the shell page can open real web pages as tabs, show them as elements, drive them, and bind them to threads; agents get them through the bridge. Tested in the plain shell on the private Xvfb Ash (`:99`, X input through Ash) and on the panel (DRM, evdev input through Ash, 2026-10-17). In T3 Code they back T3's own Browser panel, agent automation included ("In T3 Code" below; Chromium diff `patches/exo-t3-browser.patch`).

## What a tab is

A tab is a real Chromium page: its own `WebContents` in the shell's profile (so cookies and logins are shared), its own renderer process (site isolation as usual). The shell shows it with an `<embed>`:

```html
<embed type="application/x-chromium-surface-embed" data-content-id="…">
```

This is Chromium's **SurfaceEmbed** (`components/surface_embed`), written for the experimental WebUI browser, where the browser UI is a web page and the real tabs are embedded in it. That's the same problem as ours. Compared with the plan's guest view / Controlled Frame route:

- The tab's surface becomes a `cc::SurfaceLayer` in the shell page, like an OOPIF. Layout, clipping, transforms and z-order are the page's; input, focus, IME and popups (`<select>`, context menus) go through the normal child-frame routing.
- There is **no scripting channel** between the shell and the tab: no `contentWindow`, no `postMessage`, no `window.opener` across the boundary. The shell drives tabs browser-side through the broker.
- The tab is owned by the browser, not the element. Removing the `<embed>` just hides the tab, and another `<embed>` (or a reloaded shell) can show it again.
- No extensions, IWA or `<webview>` machinery is needed. The shell stays an ordinary http(s) origin.

## API (`navigator.windowBroker`, shell document only)

| Call | What |
|---|---|
| `createTab(url, tag?)` | opens a tab (omnibox-style URL fixup; `javascript:` refused) → `BrowserTabEntry` |
| `getTabs()` | the current tabs |
| `navigateTab(id, url)` | load a URL as if typed |
| `tabCommand(id, "back" \| "forward" \| "reload" \| "stop" \| "close")` | |
| `answerTabDialog(id, accept, text?)` | answer the page's pending `alert`/`confirm`/`prompt`/`beforeunload` |
| `snapshotTab(id)` | PNG of the page, also while hidden |
| `tabadded` / `tabchanged` / `tabremoved` events | subscribing replays the current tabs (as for windows) |

`BrowserTabEntry`: `id`, `contentId` (for the `<embed>`), `url`, `title`, `loading`, `canGoBack`, `canGoForward`, `embedded`, `focused`, `tag`, `openerId`, `openedBy` (`"shell"` or `"page"`), `dialogType`, `dialogMessage`, `dialogDefaultPrompt`.

**Threads.** The tag is opaque to the browser; frontends use the thread id. Tabs a page opens (`target=_blank`, `window.open`, middle click) inherit their opener's tag and record `openerId`. That binding is by construction, unlike the pid/environment scheme for native windows.

## Browser side

- `chrome/browser/plutonium_tabs.{h,cc}`, the registry (in `exo_parts`):
  - Owns the tabs; each tab is its `WebContents`' delegate and dialog manager.
  - Every new window a page opens becomes a tab; popups without a user gesture are blocked.
  - `window.close()` closes the tab.
  - Tabs close before their profile is destroyed.
- `plutonium_shell.cc`: the broker's tab methods and tab observer.
  - `IsShellDocument()` now also refuses tabs. A tab has no outer `WebContents`, so before this a tab navigated to the shell's URL would have counted as the shell.
- `chrome_content_browser_client_receiver_bindings.cc`: the SurfaceEmbed host is bound for the shell document too, not only `chrome://webui-browser`.
- `chrome_content_renderer_client.cc`: the plugin is created in main frames of the shell origin (passed to renderers as `--plutonium-shell-origin`). This gate is defense in depth; the browser-side binding check is the boundary.
- Blink: the methods, the `BrowserTabEntry` dictionary and the `BrowserTabEvent` interface on `NativeWindowBroker`.

Hidden tabs needed two fixes:
- **Size:** a tab detached from its `<embed>` gets a fresh, unsized view. The registry resizes it to the size it was shown at, so the page doesn't reflow to 0×0.
- **Painting:** a view outside any window tree has no compositor, so the page never paints, not even for a snapshot or DevTools' `Page.captureScreenshot`. Unshown tabs keep their view as a hidden child of the shell's top-level window. Snapshots of hidden tabs then use a frame-sink video capturer, as tab hover-card thumbnails do, and take about 60 ms. The page stays `document.visibilityState == "hidden"`.

## Helper, agent bridge and plain shell

- **Shell library** (`helper/web/plutonium-shell.js`):
  - `shell.tabs`, `tabsOf(threadId)`, `createTab(threadId, url)`, `navigateTab`, `tabCommand`, `answerTabDialog`, `snapshotTab`;
  - `tabElement(id)`, which makes the `<embed>`;
  - an `onFocusTab` hook, and bridge ops for all of these.
- **Daemon:** `/v1/threads/<thread>/tabs[/<id>/{navigate,back,forward,reload,stop,dialog,focus,close,snapshot}]` on the socket. Agents only reach tabs tagged with their thread.
- **MCP tools:** `list_tabs`, `open_tab` (waits for the load; shows the tab only with `focus: true`), `navigate_tab`, `tab_action`, `answer_dialog`, `snapshot_tab`, `focus_tab`, `close_tab`.
- **Plain shell:**
  - The header's **Open tab** button opens the address as a tab of the current thread.
  - Web tabs sit in the tab strip next to app tabs (◍; a dot marks a waiting dialog), with an address bar (back, forward, reload/stop).
  - Page dialogs are drawn over the tab.
  - A tab a page opens comes to the front if its opener is the tab being looked at.

## Verification (Xvfb `:99`, plain shell in shell mode, xdotool through Ash)

| Check | Result | Evidence |
|---|---|---|
| Tab renders in the page at the element's size | ✅ 1380×853, DPR 1 | `shots/tabs-first.png` |
| Typing and clicking in the tab | ✅ "hello tabs" typed, clicks at the right page coordinates | `shots/tabs-input.png` |
| Focus handoff | ✅ Clicking the shell's input moves the keys there; clicking the tab moves them back. `focused` follows. | — |
| `target=_blank`, `window.open()` from a click | ✅ New tabs with `openerId` and the thread's tag; the shell brings them to the front | — |
| `window.open()` without a gesture | ✅ Blocked (logged) | — |
| Same-tab navigation, back/forward | ✅ `canGoBack`/`canGoForward` follow | — |
| `window.close()` | ✅ The tab closes and the shell falls back to another tab | — |
| `alert()` / `confirm()` | ✅ Drawn by the shell over the tab. OK (clicked over the embedded area) returns. An agent answering `confirm` with Cancel gives `false`. | `shots/tabs-dialog.png`, `tabs-dialog-ok.png` |
| `<select>` popup | ✅ Opens at the right place; picking an option works | `shots/tabs-select-open.png` |
| Context menu | ✅ Chrome's menu appears; its Back/Forward/Reload are greyed out (no `Browser`) | `shots/tabs-context-menu.png` |
| Real site, wheel scrolling | ✅ en.wikipedia.org over HTTPS, scrolled 720 px | `shots/tabs-wikipedia.png` |
| Snapshot of a hidden / never-shown tab | ✅ About 60 ms, correct size and content, page still hidden | `shots/tabs-hidden-snapshot.png` |
| Hidden tab keeps its layout size | ✅ 1380×853 after being hidden | — |
| Switching tabs re-attaches; shell reload re-attaches | ✅ No crash; typing works after | `shots/tabs-reattach.png`, `tabs-after-reload.png` |
| Agent bridge over MCP (stdio) | ✅ All 8 tab tools; another thread's tab is refused ("This thread has no tab 3") | — |
| An ordinary tab embeds another tab with its content id | ✅ Refused: nothing attaches | — |
| A tab opened at the shell's own URL | ✅ No `navigator.windowBroker` ("not the shell"), and its `<embed>` attaches nothing | — |

## On DRM (panel, 2560×1600 at DPR 1.78)

Plain shell in shell mode on tty2 (`VT=tty2 DRM=1 launch-plain-shell.sh`), input from `tools/uinput.py`'s virtual keyboard and mouse through Ash's evdev backend. Pointer positions were calibrated against a page listener: one mouse count is one CSS pixel.

| Check | Result | Evidence |
|---|---|---|
| Tab opened with the Open tab button renders at the element's size | ✅ 1220×755 CSS px, DPR 1.78, sharp | `shots/tabs-drm-first.png` |
| Typing and clicking in the tab | ✅ "hello drm" typed; clicks at the right page coordinates (84,223) | — |
| Focus handoff | ✅ Clicking the shell's input moves the keys there, `focused` goes false; clicking the tab moves them back | — |
| `<select>` popup | ✅ Drawn in place; picking "three" works | `shots/tabs-drm-select.png` |
| `target=_blank` | ✅ New tab with `openerId` 1 and the thread's tag, brought to the front | `shots/tabs-drm-blank.png` |
| `alert()` | ✅ Drawn by the shell; clicking OK returns | `shots/tabs-drm-dialog.png` |
| `window.close()` | ✅ The tab closes; the other tab re-attaches and takes typing | — |
| Real site, wheel scrolling | ✅ after a fix (below): 5 notches down → 600 px, 2 up → 360 px; the events reach the tab, not the shell | `shots/tabs-drm-wikipedia.png` |
| Snapshot of a hidden tab | ✅ 2169×1343 (device pixels) in 252 ms; content and scroll position right | `shots/tabs-drm-hidden-snapshot.png` |
| Switching tabs by clicking the tab strip | ✅ Re-attaches; scrolling works after | — |

**Wheel fix.** At first the wheel did nothing on DRM, for the shell page as much as for tabs. Mice on a non-device ChromeOS build (`is_chromeos_device` false, so no libgestures) go through `EventConverterEvdevImpl`, which only read `REL_X`/`REL_Y`. It now turns `REL_WHEEL`/`REL_HWHEEL` (and the high-resolution axes, preferred when the device reports them) into wheel events at each `SYN_REPORT`, 120 per notch. This affects every page on DRM, so it also fixes the physical mouse. The touchpad is still untested on DRM.

## In T3 Code (2026-10-17)

T3 has a full browser (the right panel's Browser surface, a mini player, and `preview_*` MCP tools for its agents), but only in its Electron build: there the main process owns the tabs and `<webview>`s show them. The web build turns it off. In the Plutonium shell it now runs on Plutonium's tabs (T3 fork, `apps/web/src/plutonium/`):

- `previewBridge.ts` implements T3's `DesktopPreviewBridge` on `navigator.windowBroker`: create, navigate, back/forward/reload, close, state events (URL, title, loading, history). Tabs carry their thread id as the tag. What a page opens loads in the same tab, as in Electron. After a reload of the shell page the bridge adopts its tabs (`sessionStorage`) instead of opening new ones.
- `PlutoniumBrowserHost.tsx` takes the place of `ElectronBrowserHost`: each preview session's tab is an `<embed>` where the panel or mini player puts its surface, laid out at the session's viewport (agents open at 1280×800) and scaled to fit. It also draws the page's `alert`/`confirm`/`prompt`, and keeps a tab mounted invisibly while background automation holds it.
- `previewAutomation.ts` implements T3's agent automation (`status`, `snapshot`, `click`, `type`, `press`, `scroll`, `evaluate`, `waitFor`). It uses a new broker call, `sendTabDevToolsCommand(tabId, method, paramsJson)`:
  - shell document only, registry tabs only;
  - an untrusted DevTools client: no browser target, no other targets, no local files;
  - only page domains: Runtime, Input, Page, DOM, Accessibility, Emulation, Log, Network.
  Element lookup and snapshots run in an isolated world; clicks and keys are synthesized by the browser (`Input.dispatch*`). Locators: CSS, `text=`, `role=…[name=…]`, xpath, `id=`, `data-testid=`, `>>` chains, `nth=`, `:has-text()`, which is a subset of Playwright's.
- T3's own gates (`previewBridge`, `isPreviewSupportedInRuntime`, `PreviewAutomationHosts`) accept the Plutonium shell.

Chromium fixes found on the way:
- **SurfaceEmbed under a transform:** the plugin sized the page from the element's transformed bounding box, so a scaled-down `<embed>` got a scaled-down page, drawn scaled down again. It now lays out at the element's own size, as an out-of-process iframe does, and rasters at the drawn scale.
- **Performance manager:** a SurfaceEmbed tab's main frame is an outermost frame to the graph, and telling the graph it isn't intersecting the viewport is a "bad message". With the renderer gone it was a browser DCHECK; inside a message it would have killed the shell's renderer.

Verified, Xvfb and panel:

| Check | Result |
|---|---|
| Browser enabled in T3's panel menu; typing a URL loads it; title and URL in T3's tab strip and address bar | ✅ |
| Typing, clicking, `target=_blank` (loads in the same tab), `alert()` drawn and answered | ✅ |
| A T3 agent (Claude, `preview_*` tools): open, snapshot, type, click, evaluate, press | ✅ "agent was here" typed, box "clicked 1", Enter delivered |
| Agent-opened tab at 1280×800 in the mini player and the panel, scaled to fit | ✅ `innerWidth` 1280 at DPR 1 (Xvfb) and 1.78 (panel) |
| A real click through the scaled-down tab | ✅ lands at the right page coordinates |
| Background open (`open: false`) and evaluate while the Apps tab is showing | ✅ 5.9 s |
| foot (native app) from Apps beside the browser; typing into it on the panel | ✅ |
| Switching Apps ↔ Browser ↔ foot | ✅ no crash after the two fixes above |
| Wikipedia over HTTPS, snapshot from an agent | ✅ |
| `sendTabDevToolsCommand`: `Target.*` refused; `Page.navigate` to `file://` refused | ✅ |

Not done for T3 (the bridge rejects or ignores these):
- the panel's own zoom controls (zoom itself works: the keys, Ctrl+wheel and the library's toast, `TAB_FEATURES.md`), emulated color scheme, mute, the DevTools window;
- element picking (needs T3's picker preload), screenshots saved to a file, recordings, picture-in-picture windows, cookie import;
- console and network entries in snapshots (always empty).

## In T3 Code 0.1: the server drives the tabs (2026-10-18)

T3 Code 0.1 moved agent browsing to the server: it drives every tab with Playwright over the DevTools protocol, and the client-side automation host above (and the RPCs it used) is gone. The desktop app renders its own server's tabs and lends the server each tab's debugger over a "desktop browser channel"; every other client watches tabs that run in a headless Chrome on the server, as a JPEG stream. The Plutonium shell now takes the desktop app's part, with the browser's real tabs, so the user still sees and uses the real tab, and agents get upstream's engine:

- **T3 server** (patch 0012): its `DesktopBrowserChannel` (newline-delimited JSON: `attached`/`detached`/`cdp` from the desktop, `cdp`/`release`/`pointer` to it) also runs over the helper's Unix socket, as `GET /v1/desktop-browser` upgraded, when the server runs in a Plutonium session. It reconnects when the helper restarts, and counts as available only while connected, so with no session a new tab starts headless at once instead of waiting for one. Since 2026-10-19 (patch 0017) the server also sends `open`, and the helper opens the tab itself when no page shows it, so no T3 page needs to be open ([AGENT_CONTROL.md](AGENT_CONTROL.md#in-t3-code)).
- **Shell page:** `rendersServerTabNatively` is true in the Plutonium shell, so the shell shows this server's tabs as the desktop app does. When the bridge creates the tab for a server tab, it calls the shell library's `showServerTab(browserTabId, {threadId, tabId})`, which reads the tab's DevTools target id (its main frame id, from `Page.getFrameTree`) and tells the helper.
- **Helper** (`helper/src/serverTabs.ts`, `cdp.ts`): connects to the browser's own DevTools (`--cdp-port`, the session's `--remote-debugging-port`) and gives the server one relay per tab. The relay is a port of T3's `CdpRelay`: to Playwright it looks like a browser with one page, and it answers browser-level commands itself. Page commands go to a flat session on that tab's target, with the target's child sessions (frames, workers) passed through and nothing else reachable. Downloads keep the browser's own behaviour (`Browser.setDownloadBehavior` is the whole browser's).
- **Several shells:** each running shell page renders the panel's tabs, so the first page to show a server tab owns it, and the others show that same browser tab. When the owner's page goes away, another page that shows it takes over.
- The agent's cursor (`pointer`) goes to the page that shows the tab, into T3's own cursor overlay. What a page opens in a new tab or window becomes another tab of its thread (T3's `onOpenLink`), as in the desktop app.
- **Popups keep their opener** (patch 0014, 2026-10-18). At first the bridge closed what a page opened and opened its URL again in a fresh tab. That tab had no `window.opener`, so OAuth sign-in popups couldn't post their result back, and sign-in never finished. Now the tab the page opened backs the new panel tab itself: the thread's next new preview tab adopts it, without loading it again. When it closes itself (`window.close()`, as sign-in popups do), its panel tab closes too and the opener's comes back, as the desktop app's popup window does. With several shell pages, one of them (a Web Lock) asks for the preview tab; before, each page opened one.

The client-side engine (`previewAutomation.ts`) is gone; `sendTabDevToolsCommand` is now only used to read a tab's target id.

Verified on Xvfb with the host's T3 data:

| Check | Result |
|---|---|
| Browser tab from the panel, URL typed: loads in the real tab; title and URL reach T3 through the server | ✅ |
| Relay by hand over the helper's socket: `Browser.getVersion`, `Target.setAutoAttach` announces the page, `Runtime.evaluate` returns the tab's URL | ✅ |
| A T3 agent (Claude, `preview_*`): opens example.com, snapshots it, clicks "Learn more", reports "Example Domains" at iana.org | ✅ in the real tab (target type `other`); clicks relayed as `Input.dispatchMouseEvent`; no headless Chrome started |
| Three T3 shell pages in one profile | ✅ one browser tab, attached once |
| The agent's cursor (`pointer` from the server) | ✅ drawn by T3's overlay over the real tab |
| A popup from a click (`window.open(url, "auth", "width=500,…")`, cross-origin), with two T3 shell pages | ✅ one new panel tab, `window.opener` set; its `postMessage` reaches the opener; its `window.close()` closes the panel tab and brings the opener back |

## Surviving a restart (EXO-SESSION)

The browser keeps the tabs in `Plutonium Tabs` in the profile, a JSON list of each tab's address, tags and `openedBy`, written a second after any change (an `ImportantFileWriter`, so a crash loses at most that second) and never once shutdown has started (closing the browser closes its tabs, which mustn't empty the list). At the next start, once the startup shell's page exists, each one opens again with its tags, so it is back in its thread in whichever shell shows that thread. Not kept: incognito tabs, DevTools, and tabs whose origin tag is T3 Code's (`t3:`), since T3's server reopens its browser panel's tabs itself. A restored tab is a new tab at its address: no back/forward history, and a new id.

## Limits and next steps
- **No `Browser` behind a tab.** What Chrome reaches through a `Browser` window comes from tab helpers attached to the registry's `WebContents`, exposed to shells (`TAB_FEATURES.md`): find in page, zoom, permission prompts, downloads, file pickers and printing are built. Still missing: autofill (not wanted for now) and Chrome's password manager (`PASSWORDS.md` instead).
- **Tabs don't survive a browser restart** (no session restore).
- **DevTools:** tabs are CDP targets of type `page` (`other` before `CHROME_UI.md`). A tab's DevTools is a tab of its own (`openedBy: "devtools"`), listed as `other`.
- A key typed within milliseconds of switching tabs can be lost while the tab re-attaches. No key was lost with a 50 ms gap.
- SurfaceEmbed is new upstream: enabled by default, but only used by the experimental WebUI browser. Its README describes it as the "secure and simple" replacement for iframe-based embedding (`GuestContents`, which is marked not for production).
