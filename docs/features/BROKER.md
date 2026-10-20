# The window broker and grants

How a shell page finds native windows and gets the right to show them, and who else is kept out. The design and its first verification are in [history/PHASE2_PROGRESS.md](../history/PHASE2_PROGRESS.md) and [PHASE2_REPORT.md](../history/PHASE2_REPORT.md). Tabs, which go through the same API, are in [TABS.md](TABS.md).

## API (`navigator.windowBroker`, shell document only)

| Call | What |
|---|---|
| `getWindows()` | the current windows (`NativeWindowEntry`) |
| `requestGrant(id)` | a grant for window `id`, for `<native-window grant=…>` elements in this document; rejects `NotAllowedError` if there's no such window |
| `revokeGrant(grant)` | revokes a grant this document holds: its elements detach and fire `windowclose` |
| `showOnDesktop(id)`, `close(id)`, `snapshot(id)` | pop out, ask the app to close, PNG |
| `windowadded` / `windowchanged` / `windowremoved` | lifecycle; `event.windowId`, `event.entry` |
| `windowfocusrequest` | the shells overlay asks this shell to show a window |
| `grantrevoked` | a grant this document holds stopped working: `event.grant`, `event.windowId`. Fired after `revokeGrant()`, and when the window closes (just before its `windowremoved`). Elements using it have detached already |

`NativeWindowEntry`: `id`, `appId`, `title`, `width`, `height`, `deviceScaleFactor`, `embedded`, `focused`, `pid`, `tag`, `tags`.

**Subscribing.** Adding the first listener for any of the five window events subscribes. The current windows then arrive as `windowadded` events, followed by every change, with nothing missed or seen twice in between. Removing the last of those listeners (including `onwindowadded = null` and `{ once: true }` listeners that ran) unsubscribes: the observer pipe closes and the browser drops it. Listening again subscribes again and replays the current windows. Tab events (`tabadded` …), `groupschanged`, `shellschanged` and `contextmenurequest` subscribe and unsubscribe the same way, each kind on its own. A page that stops listening for `contextmenurequest` gets Chrome's own menus again (the browser drops its observer when the pipe closes; not checked live).

**`NativeWindowEvent`** can be made by script, e.g. for a shell's tests or to replay its own state:

```js
new NativeWindowEvent("windowadded", { windowId: 3, entry: someNativeWindowEntry });
new NativeWindowEvent("grantrevoked", { windowId: 3, grant: "…" });
```

`windowId` defaults to 0, `grant` to `""`, and a missing `entry` reads as `null`. An `entry` lacking a required member throws `TypeError`. Like any script-made event it isn't trusted, and it bubbles only if `bubbles: true` says so.

**The shell library** (`helper/web/plutonium-shell.js`) keeps one grant per window and reuses it. On `grantrevoked` it forgets that grant, so the next `grantFor()` asks for a new one.

## Who is the shell

`plutonium_shell::IsShellDocument(rfh)`, checked in the browser on every call:

- the document is in the **primary main frame** (no iframes, fenced frames, prerendered or back/forward-cached pages);
- its `WebContents` has **no outer contents** (no guests) and is **not a browser tab**;
- it is live and **not an error page**;
- its committed **origin and URL's origin** are the shell origin (no `about:blank`, `srcdoc`, `data:` or sandboxed documents). In shell mode (`--plutonium-shell-url`, which `plutonium run` uses), that's the origin of the shell whose window it is; outside shell mode, any top-level page on `--plutonium-shell-origin`.

The renderer only sees `navigator.windowBroker` where the browser force-enabled the `PlutoniumShell` origin trial, for shell navigations. That only decides what script sees: the binder (`BindWindowBroker`) and `NativeWindowHost.Attach` check `IsShellDocument` themselves. A grant only resolves for the document it was issued to, so a grant copied to any other document (another tab, an iframe, the next document in the same frame) attaches nothing.

## The exclusion cases

| Case | Result | How it's checked |
|---|---|---|
| iframes in the shell, same origin (`srcdoc`, `about:blank`, URL) | no API; forced, calls rejected; the shell's grant refused | live; unit (`IframesAreNot`, `ShellGrantInAnIframe`) |
| cross-site iframe (an out-of-process frame) | the same | live; unit |
| popup, `window.open(url)` from the shell | needs a user gesture; in shell mode it opens as a browser tab (the shell gets a `Window` handle), which is never the shell: no API; forced, calls rejected | live |
| `window.open("")` from the shell (an `about:blank` tab on the shell's origin, which the shell can script) | no API; forced, the URL check refuses it; the shell's grant refused | live |
| `<webview>` / guest contents at the shell origin | `<webview>` isn't available to pages (`HTMLUnknownElement`); inner contents are refused by the outer-contents check | live; unit (`InnerContentsAreNot`) |
| prerendered page on the shell origin | not exposed (the throttle only runs for primary main frames). Forced, its request for the broker waits for activation (prerendering's Mojo policy defers unlisted interfaces) and is never answered while it is prerendered | live; unit (`PrerenderedShellIsNot`) |
| fenced frame | not the shell | unit (`FencedFramesAreNot`) |
| error page at the shell URL | not the shell | unit (`ErrorPagesAreNot`) |
| a new document in the same frame | the old document's grants were revoked with it, and the document id doesn't match | unit, with RenderDocument for main frames off (`NewDocumentInTheSameFrameHasNoGrants`). Chromium's default (RenderDocument for all frames) gives every cross-document navigation a new frame host anyway |
| a `javascript:` URL's document in the shell's frame | keeps the API and the previous document's grants: the browser sees no new document (same frame host, URL, origin and document data). Only the shell's own script can run a `javascript:` URL in its frame, so this is shell code, as with `document.open()`. Not a hole; recorded, not asserted | live |
| back/forward-cached shell | not the shell; its grants stay with it (they work again if it comes back) and resolve nowhere else | unit (`BackForwardCachedShellIsNot`, `NavigatingAwayLeavesTheGrantBehind`) |
| a renderer calling `Focus`, `SetSize`, `Blur`, `OnFullscreenChanged` without attaching | nothing happens: the host has no grant | unit, with raw Mojo calls (`UnattachedHostDoesNothing`) |
| input to a window a page doesn't embed | the router only routes to foreign frame sinks linked to its own views, and drops a capture whose link went | unit (`content_unittests`, `ForeignSink*`, `RouteToForeignChecksTheLink`, `ForeignCaptureEndsWithTheLink`) |

## Tests

**Unit tests** (Chromium, `out/Cros`, in the build container: `plutonium container shell`):

```
autoninja -C out/Cros plutonium_unittests content_unittests
out/Cros/plutonium_unittests
out/Cros/content_unittests --gtest_filter='RenderWidgetHostInputEventRouterTest.*Foreign*'
```

- `plutonium_unittests` is a target of its own (`chrome/test/BUILD.gn`), on `//chrome/browser` and content's test support: about 800 build steps from a built `chrome`, against about 8,800 for `unit_tests` and 8,100 for `browser_tests`. It has `chrome/browser/exo_window_broker_unittest.cc` (grants, revocation, documents) and `plutonium_shell_unittest.cc` (`IsShellDocument`, the binder, `grantrevoked` forwarding, attach refusals). The broker has a test-only `AddWindowForTesting()`, since its windows otherwise come from Exo. Attach refusals are told apart by the browser's `VLOG` lines. A grant that passes every check still fails afterwards ("not embeddable"), because the test's windows aren't real.
- The input router's checks are in `content_unittests` (`render_widget_host_input_event_router_unittest.cc`), whose fixture can reach the router's private parts.
- Not covered by unit tests: anything that needs a real Exo window (a successful attach, input reaching an app) or Ash's shell mode (`PlutoniumShells`). The live checks cover those.

**Live checks**: `tools/shell-checks/run.sh [--forced]` starts an X11 session in the checkout's slot, with `tools/shell-checks/index.html` as its only shell and two foot windows. It runs `checks.js` in the shell page over DevTools and prints one line per check. `--forced` adds `--enable-blink-features=PlutoniumShell`, so every page sees the API and only the browser's checks keep them out. It stops the slot's X11 session before and after (`--keep` leaves it up). Exits non-zero if a check fails.

The checks: the shell's grant, `revokeGrant()` → `grantrevoked` and `windowclose`, a closing window's `grantrevoked` before `windowremoved`, resubscribing (also with `onwindowadded = null`), `NativeWindowEvent`'s constructor, `srcdoc`/`about:blank`/same-origin/cross-site iframes, `<webview src>`, both popups (evaluated with a user gesture), a prerendered page (started with DevTools detached, since an attached page-level DevTools session turns prerendering off), and the `javascript:` URL document. `serve.py` serves the directory uncached on `127.0.0.1` (the shell) and, as the same server, `localhost` (another site).

Run on 2026-10-20 (patches 0031–0032, X11 slot 19): 39/39 both ways. The shell library's change was checked by hand in the same session: after `revokeGrant()` its cached grant was gone, and the next `grantFor()` got a new one that attached.

The first run found a crash: `revokeGrant()` on an attached grant stopped the dev build. Revoking detached the element, whose detach changed the window, which notified the broker's observers from inside the revocation's own notification. `base::ObserverList` forbids that: fatal in the dev build (`dcheck_always_on = true`), a crash dump and carrying on in the release build. The broker now tells observers one event at a time (`ExoWindowBroker::Notify()`, test `EventsCausedByAnObserverWaitTheirTurn`), so the shell also gets `grantrevoked` before the `windowchanged` the detach causes.

