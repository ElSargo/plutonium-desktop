# Phase 2 progress: security model and broker

Tracks the Phase 2 roadmap in [OPTION2_PLAN.md](OPTION2_PLAN.md). Chromium
changes live in `~/chromium/src` (branch `exo-viability`, build `out/Cros`) and
are tagged `EXO-BROKER`; test page `spike/phase1.html`, launcher
`tools/launch-phase1.sh`. Logs are `logs/phase1-<tag>.log`.

**Phase 2 complete** (2026-10-15). Results and known limits: [PHASE2_REPORT.md](PHASE2_REPORT.md); patch `patches/exo-phase2.patch`.

Status: ✅ done and verified · 🟡 built, partly verified · ⬜ not started · ❌ failing

| # | Item | Status | Evidence / notes |
|---|------|--------|------------------|
| 1 | Window broker service: registry, lifecycle events, grants | ✅ | `ExoWindowBroker` (`chrome/browser/exo_window_broker.{h,cc}`). Broker logs show kcalc added → embedded → focused → removed. Grant issue/validate checked, plus revocation on reload and on window close. No regression: kcalc embeds and types `12*3=` → 36 (`shots/phase2-broker-type.png`, `phase2-broker-final.png`). Not enforced yet |
| 2 | Grant-checked embedding (ExoEmbedder attach, frame-sink link, input hook); viz hit-test change limited to browser-registered children | ✅ | `NativeWindowHost.Attach(grant, window_id, client)`; `<native-window grant=… [window=…]>`. With a dev grant kcalc embeds, types `7*6=` → 42, menus open (`shots/phase2-grant-valid-{type,menu}.png`). No grant, forged token, malformed token, another window's grant, the page's grant used from an iframe, and the previous document's grant after reload are all refused (`windowerror`); clicks and keys on those elements reach the page, not kcalc (`phase2-grant-refused-probes.png`, `phase2-grant-after-refused.png`). Without `--exo-broker-dev-grants` nothing embeds (`phase2-nogrant.png`). Logs `logs/phase1-phase2-{grant,nogrant}.log` |
| 3 | Privileged shell origin: only the shell page gets the broker API | ✅ | `--plutonium-shell-origin` (checked browser-side on the committed document), `blink.mojom.WindowBroker` / `navigator.windowBroker`, dev grants removed. The shell lists windows, gets grants, embeds kcalc, types `7*6=` → 42, menus open (`shots/phase2-shell-{type,menu}.png`). An ordinary tab on another site can't see the API, and a stolen shell grant doesn't work there. Its clicks and keys reach the page, and kcalc keeps 42 (`phase2-ordinary-probes.png`, `phase2-shell-after-ordinary.png`). Same-origin iframes (srcdoc and URL) get no API and can't attach. With the API force-exposed, the browser refuses to bind it for all three. Logs `logs/phase1-phase2-{shell,shell2,forced,noshell}.log` |
| 4 | Remove the JSON registry file and polling; push events to the shell | ✅ | `navigator.windowBroker` is an `EventTarget`: the first `windowadded` / `windowchanged` / `windowremoved` listener subscribes (`AddObserver`, observer now an associated interface so snapshot and events can't race) and the current windows arrive as `windowadded`. `EmbeddedWindows::PublishRegistry`, `$EXO_EMBED_REGISTRY`, the launcher's `exo-surfaces.json` and `phase1.html`'s `poll()` are gone; no registry file is written anywhere. Live add (`shots/phase2-push-added.png`), title change via OSC 2 → `windowchanged`, kill → `windowremoved` and the card goes (`phase2-push-removed.png`); kcalc `7*6=` → 42, foot typing, menus (`phase2-push-{type,menu}.png`). Ordinary tab: no API, no list, stolen grant refused, input stays in the page (`phase2-push-ordinary-probes.png`, `phase2-push-shell-{before,after}-ordinary.png`). Forced API: observer never bound outside the shell (`phase2-push-forced.png`). Logs `logs/phase1-phase2-push{,-forced}.log` |
| — | Exit: an ordinary web page cannot embed or inject into any native window; the shell can | ✅ | Re-run of `spike/phase2-grant-checks.js` on the item-4 build (push-only shell): shell `run(1, 3)` all as expected incl. `pushedList … match`, `runAfterReload()` refused; ordinary tab `runOrdinary(1, stolen)` all refused and 5/5 clicks + all keys stayed in the page with kcalc keeping 42; with the API force-exposed every non-shell frame (ordinary tab, srcdoc and URL iframes) is refused binding, so it gets no list, no events and no grants. See "Item 4 → Verification" |

## Item 1: window broker

### What exists

**`ExoWindowBroker`** in `chrome/browser/exo_window_broker.{h,cc}` (built in
the `//chrome/browser:exo_parts` source set). Owned by `ExoParts`, created
just before `ExoEmbedder` and destroyed just after it, so it lives exactly
while the Wayland server runs. `ExoWindowBroker::Get()` returns it, or null
when there is no Wayland server. UI thread only.

- **Registry.** It observes `exo::EmbeddedWindows` and keeps a
  `std::map<int32_t, WindowInfo>`. It no longer reads the JSON file.
  `WindowInfo` holds:
  - `id`: the `EmbeddedWindows` window id, stable and never reused. It isn't
    a capability.
  - `app_id`, `title`;
  - `size`: the geometry size in DIPs;
  - `device_scale_factor`;
  - state: `embedded` (a page element is attached and the window is parked)
    and `focused` (embedded keyboard focus).

  `GetWindows()` and `GetWindow(id)` read it. Windows that already exist when
  the broker starts are picked up in its constructor.
- **Lifecycle events.** `ExoWindowBroker::Observer` has:
  - `OnWindowAdded(info)`: when the window first has a surface and is
    embeddable. That's the same moment the JSON registry lists it.
  - `OnWindowChanged(info)`: only when a `WindowInfo` field changes. Surface
    id and geometry-origin churn (every frame or resize) is filtered out.
  - `OnWindowRemoved(id)`: when the toplevel is destroyed. Its grants are
    revoked first.
  - `OnGrantRevoked(token, window_id, GlobalRenderFrameHostId)`.
- **Grants.** A grant is an opaque `base::UnguessableToken` bound to one
  window and one document.
  - `IssueGrant(rfh, window_id) → optional<token>`. It fails when the window
    isn't in the registry or the frame isn't live and active. Each call
    issues a fresh token.
  - `ResolveGrant(token, rfh) → optional<window_id>` and
    `ValidateGrant(token, rfh, window_id) → bool`. Both check:
    - the token exists;
    - it was issued to `rfh->GetGlobalId()`;
    - it belongs to the frame's *current document*. Each document gets a
      `DocumentUserData` (`ExoWindowBroker::DocumentGrants`) with its own
      random document id, and the grant stores that id. A same-RFH
      navigation therefore can't inherit a grant.
  - `RevokeGrant(token)` and `RevokeGrantsForWindow(id)` revoke explicitly.
  - Grants are revoked automatically:
    - **on window close**, in `OnEmbeddedWindowDestroyed`;
    - **when the document goes away** (navigation, reload, frame or tab
      closed), from the `DocumentGrants` destructor.
  - `grant_count()` is there for tests and logging.
- **Exo change.** `exo::EmbeddedWindows::Info` gained `attached`, and
  `Attach`/`Detach` call `NotifyIfChanged` when the count goes between 0 and
  1. That's how the broker sees `embedded`. Tagged `EXO-BROKER`.
- **Logging.** `VLOG(1)` lines prefixed `EXO-BROKER` cover window
  added/changed/removed and grant issued/revoked. Enable them with
  `EXTRA_FLAGS='--vmodule=exo_window_broker=1'`. This replaces the
  launcher's own `--vmodule`, since the last one wins.

(Item 2 added the enforcement; see below.)

### Verification

Run on the Xvfb dev loop with kcalc:
`PAGE_QUERY='?w=420&h=330' EXTRA_FLAGS='--vmodule=exo_window_broker=1' tools/launch-phase1.sh broker1 kcalc`.
Logs are `logs/phase1-broker{1,2}.log`.

- **Registry and events.** The broker logs:
  1. `window added: #1 app_id="org.kde.kcalc" title="KCalc" size=420x341`;
  2. `changed … embedded=1` when the element attaches;
  3. `changed … focused=1` on click;
  4. `changed … embedded=0` on page reload, then `embedded=1` when the
     reloaded page re-attaches;
  5. `window removed: #1` when kcalc is killed.

  The JSON registry still matched (`[{"id":1,…}]`, then `[]`).
- **Grants.** A temporary hook in `NativeWindowHostImpl::Attach`, since
  removed, issued a grant per attach and checked it. Results:
  - `ValidateGrant` was true for (token, frame, window) and false for a
    different window and for a random token;
  - a page reload logged `grant revoked … frame (36,5)`, which is
    revocation on document destruction. The reloaded document got a new
    grant on frame (36,8);
  - killing kcalc logged `grant revoked` before `window removed`.
- **No regression.** kcalc embeds, takes keyboard focus on click, and typing
  `12*3=` gives 36 (`shots/phase2-broker-type.png`). Rerun after removing
  the hook: `7*6=` gives 42 (`shots/phase2-broker-final.png`).
- **Not done:** no unit tests (the chrome `unit_tests` target wasn't built).
  Grant checks across frames and same-RFH navigations weren't exercised
  live: the test page has no iframes, and reloads swap the RFH.

### Notes for items 2–4

- **Item 2 (enforcement).** The obvious shape:
  - `blink.mojom.NativeWindowHost.Attach` takes a grant token
    (`mojo_base.mojom.UnguessableToken`) instead of, or as well as, the
    window id. `NativeWindowHostImpl::Attach` calls
    `ExoWindowBroker::Get()->ResolveGrant(token, &render_frame_host())` and
    attaches to the returned window only. The `<native-window>` element then
    needs a `grant` attribute (the plan's `<native-window grant=…>`).
  - `NativeWindowHostImpl` should observe `ExoWindowBroker` and `DoDetach()`
    plus `client_->OnClosed()` on `OnGrantRevoked` for its own token. It
    currently observes `exo::EmbeddedWindows` directly. On window close the
    broker revokes before `OnWindowRemoved`, but both are exo observers, so
    whichever of the broker and the host registered first runs first. Don't
    rely on that order.
  - `ExoEmbedder::RouteMouseEvent`, `Focus` and `SetSize` act on frame
    sinks or window ids that are already linked. With attach gated, the
    links (`ExoEmbedder::links_`) only exist for granted (page, window)
    pairs. `IsEmbeddedIn` is what the input router and viz-side checks key
    on, so gating attach gates input too. The hit-test aggregator change
    (`components/viz/service/hit_test/hit_test_aggregator.cc`) already
    requires the child to be registered under the renderer's frame sink.
  - Grants are per document, not per element. Several elements in one page
    can share a grant.
  - Until item 3 lands, the dev test page needs some way to get a grant,
    e.g. a temporary `--exo-broker-dev-grants` switch that makes
    `NativeWindowHostImpl` self-issue. Keep it behind a switch and remove it
    in item 3.
- **Items 3 and 4 (shell API, push events).** No mojom yet. Suggested shape,
  served only to the shell origin. The binder can live next to
  `ExoEmbedder::BindNativeWindowHost` in `chrome_browser_interface_binders.cc`,
  checking the origin before binding:
  ```
  interface WindowBroker {
    // Current windows, then pushed changes.
    AddObserver(pending_remote<WindowBrokerObserver> observer)
        => (array<NativeWindowEntry> windows);
    RequestGrant(int32 window_id) => (mojo_base.mojom.UnguessableToken? grant);
    RevokeGrant(mojo_base.mojom.UnguessableToken grant);
  };
  interface WindowBrokerObserver {
    OnWindowAdded(NativeWindowEntry w); OnWindowChanged(NativeWindowEntry w);
    OnWindowRemoved(int32 window_id);
  };
  ```
  An impl can be a `DocumentService<WindowBroker>` plus an
  `ExoWindowBroker::Observer` that forwards events. `RequestGrant` maps to
  `IssueGrant(&render_frame_host(), id)`. The JSON registry
  (`EmbeddedWindows::PublishRegistry`, `$EXO_EMBED_REGISTRY`, the launcher's
  `exo-surfaces.json`, the page's `poll()`) is untouched and is item 4's job.
- **Not modelled yet:** chat-thread binding (Phase 4) and tabs. Add them to
  `WindowInfo` and the registry when they exist. Ash window state
  (minimized and so on) isn't exposed, since parked windows don't have a
  meaningful one.

## Item 2: grant-checked embedding

(The dev-grant pieces described here, `RequestDevGrant`, `requestDevGrant()`,
`--exo-broker-dev-grants` and `DEV_GRANTS`, were removed in item 3. Grants now
come from the shell API.)

### What changed (Chromium, tagged `EXO-BROKER`)

- **Mojom** (`third_party/blink/public/mojom/native_window/native_window.mojom`):
  - `Attach(mojo_base.mojom.UnguessableToken grant, int32 window_id,
    pending_remote<NativeWindowClient>) => (bool)`. The grant decides which
    window is attached. A non-zero `window_id` must match it, otherwise
    the attach is refused (it's a check, never a selector).
  - `NativeWindowInfo.window_id`: so the page learns what it got.
  - `RequestDevGrant(int32 window_id) => (UnguessableToken?)`, **dev-only**.
    It replies null unless the browser runs with `--exo-broker-dev-grants`.
    Item 3 removes it.
  - BUILD: `native_window_mojo_bindings` depends on `//mojo/public/mojom/base`.
- **`NativeWindowHostImpl`** (`chrome/browser/exo_embedder.cc`):
  - `Attach` calls `ExoWindowBroker::ResolveGrant(grant, &render_frame_host())`.
    A failed resolve or a window-id mismatch means it doesn't attach: no
    `LinkFrameSinks` (no viz hierarchy registration), no
    `EmbeddedWindows::Attach` (no parking), no client bound. It replies
    false and logs `EXO-BROKER attach refused: …` at `VLOG(1)`.
  - It stores the grant and observes `ExoWindowBroker`. On
    `OnGrantRevoked` for its own token it calls `Close()`, which restores
    page text input if needed, sends `client_->OnClosed()` (the element fires
    `windowclose`) and runs `DoDetach()`. `OnEmbeddedWindowDestroyed` does
    the same, so either observer order at window close works. Both paths are
    idempotent.
  - `SetSize`, `Focus` and `Blur` re-check `ValidateGrant(grant, rfh,
    window)` before acting. That's belt and braces, since revocation already
    detaches.
  - `BindNativeWindowHost` needs both `ExoEmbedder` and `ExoWindowBroker`.
    Any frame may *bind* the host. Only a grant lets it attach.
- **Input router** (`components/input/render_widget_host_input_event_router.{h,cc}`):
  - New `IsForeignFrameSinkEmbeddedHere(sink)`. It is true only if the
    delegate (`ExoEmbedder::IsEmbeddedIn`, i.e. a granted link) links the
    sink to one of *this* router's views (`owner_map_`).
  - The viz-hit-test fast path (`MaybeRouteToForeignFrameSink`) now uses
    it. Before, it accepted any view-less sink.
  - `RouteToForeign` (the single chokepoint every foreign route passes
    through) also checks it, and drops a capture whose link has gone, for
    example after a grant is revoked mid-drag.
  - The renderer-targeter path (`RouteToForeignFrameSink`) already
    required `IsEmbeddedIn(sink, queried_view)`.
- **Exo** (`components/exo/embedded_windows.{h,cc}`): new `IsAttached(id)`.
  `Focus`, `DispatchMouseEvent` and the posted `DoDispatchMouseEvent`
  refuse windows with no attached element, so a window no page has
  attached can't get embedded keyboard focus or injected pointer events.
- **Viz hit-test aggregator** (`components/viz/service/hit_test/hit_test_aggregator.cc`),
  reviewed and tightened. The rewrite `(submitter_client, n) → (0, n)`
  now needs all of the following:
  - the submitter is a client (client id ≠ 0);
  - the region as submitted isn't already a valid child;
  - `IsChildOf(submitter, (0, n))`, a direct child in
    `FrameSinkManagerImpl`'s hierarchy.

  Only the browser registers hierarchy with client-id-0 children. A
  renderer only gets its own client id's sinks registered, through
  `EmbeddedFrameSinkProvider`. For renderer parents that means only
  `ExoEmbedder::LinkFrameSinks`, which now runs only after a grant check.
  The cycle check is repeated for the rewritten id. Spike comments were
  renamed `EXO-EMBED`.
- **Blink element** (`html_native_window_element.{h,cc,idl}`, plus `grant` in
  `html_attribute_names.json5`):
  - The element attaches only when connected *and* it has a `grant`
    attribute. `window` is optional.
  - A string that isn't a token fails locally, without asking the browser,
    but still asynchronously.
  - A refusal fires `windowchange` + `windowerror` and leaves `windowState`
    "failed".
  - New `windowId` attribute.
  - `requestDevGrant(windowId) → Promise<DOMString>` (dev-only, `""` when
    refused).
  - Attach replies are matched by an attach id, no longer by window id.

### Input paths checked

| Path | Why an ungranted page can't use it |
|---|---|
| Viz fast path (`MaybeRouteToForeignFrameSink`) | Needs a hit-test region for the sink in the page's subtree. The aggregator only accepts it if the browser linked it, i.e. a grant. The router also requires `IsEmbeddedIn` for one of the page's views |
| Renderer targeter (`RouteToForeignFrameSink`) | `IsEmbeddedIn(sink, queried_view)`. The renderer only knows the sink from `NativeWindowInfo`, which it only gets after a granted attach |
| Drag capture (`RouteToForeignCapture`) | Capture is only set by the two paths above, and `RouteToForeign` re-checks it |
| Keyboard | Embedded focus only comes from `EmbeddedWindows::Focus`. That is called by a routed press (gated above) or `NativeWindowHost.Focus` (grant re-checked), and Exo refuses unattached windows |
| `focusWindow()`/`blurWindow()`, `SetSize` | Renderer: need `info_`. Browser: `HasValidGrant()` |
| Cursor | `SetForeignFrameSinkCursor` only reaches routers in `ForeignHoverRouters()`, which only `RouteToForeign` fills (gated) |
| Showing pixels | The surface id (with its unguessable embed token) only reaches the page in `OnInfoChanged`, after a granted attach |

The grant is per document at the mojo level. At the viz/input level the
unit is the widget (the local root): same-process frames under one
`RenderWidgetHost` share the link. That's the renderer-process trust
boundary anyway (a compromised renderer owns all its frames). Cross-site
OOPIFs have their own widgets, so a grant for the main frame gives an OOPIF
nothing.

### Verification

Run on the Xvfb dev loop with kcalc and foot:
`PAGE_QUERY='?w=420&h=330' EXTRA_FLAGS='--vmodule=exo_window_broker=1,exo_embedder=1'
tools/launch-phase1.sh phase2-grant <kcalc> foot`. The launcher now adds
`--exo-broker-dev-grants` unless `DEV_GRANTS=0`. Log:
`logs/phase1-phase2-grant.log`.

- **Valid grant.** `spike/phase1.html` gets a dev grant per window
  (`window.grants`) and sets `grant` + `window`. Both windows attach.
  - kcalc: a click gives it the keyboard and `7*6=` shows 42
    (`shots/phase2-grant-valid-type.png`).
  - The Edit menu opens above the page (`phase2-grant-valid-menu.png`).
- **Refusals.** `spike/phase2-grant-checks.js`, run with
  `tools/cdp_eval.py phase1 "import('/phase2-grant-checks.js').then(m => m.run(1, 2))"`:
  ```
  validGrant: attached windowId=1          validGrantNoWindowAttr: attached windowId=1
  noGrant: none                            forgedToken: failed +windowerror
  malformedToken: failed +windowerror      otherWindowsGrant: failed +windowerror
  grantInIframe: failed +windowerror       devGrantUnknownWindow: (refused)
  ```
  Browser log: `attach refused: no valid grant for frame (36,5)` (forged),
  `grant is for window #2, not #1`, and `no valid grant for frame (36,1)`
  (the iframe).
- **Input at refused elements.** I clicked each refused element (no grant,
  forged, malformed, other window's grant, iframe) and typed `99`. All 5
  mousedowns and all 10 keys reached the page (`probeClicks
  [0,1,2,3,"iframe"]`, `pageKeys "9999999999"`). kcalc never got focus and
  still shows 42 (`phase2-grant-refused-probes.png`,
  `phase2-grant-after-refused.png`).
- **Reload.** A grant saved in `sessionStorage` and reused after a reload:
  `oldDocumentsGrant: failed +windowerror`. The log shows the old grants
  revoked and new ones issued to frame (36,8). The reload swapped the RFH, so
  this refusal comes from the frame check. The same-RFH document check is
  covered only by item 1's design, not exercised live.
- **Revocation on window close.** Killing foot logged `grant revoked: window
  #2`, then `detach: window #2 … (grant revoked)`, then `window removed: #2`.
  The element fired `windowclose`.
- **No dev switch** (`DEV_GRANTS=0 … launch-phase1.sh phase2-nogrant kcalc`,
  `logs/phase1-phase2-nogrant.log`): `dev grant refused`, the element stays
  `none`, kcalc isn't parked, and a click plus `12*3=` on the element all
  went to the page (`phase2-nogrant.png`).
- **Not done:**
  - no unit/browser tests;
  - a compromised renderer calling `Focus`/`SetSize` without attaching
    wasn't exercised (the browser re-checks the grant, by inspection only);
  - same-RFH cross-document reuse wasn't tested live;
  - cross-site OOPIF wasn't tested (the test server is single-origin).

### Notes for item 3

- **Grants.** Replace `RequestDevGrant`, `requestDevGrant()`,
  `kExoBrokerDevGrantsSwitch` / `DevGrantsEnabled()` in `exo_embedder.cc`,
  and the launcher's `DEV_GRANTS` with the shell-only `WindowBroker` mojom
  (`RequestGrant(window_id)` → `IssueGrant(&render_frame_host(), id)`).
  - Grep `DEV-ONLY` to find the dev pieces.
  - `spike/phase1.html` and `spike/phase2-grant-checks.js` call
    `requestDevGrant`. Switch them to the shell API.
  - The negative checks should then also run from an *ordinary* tab (a
    different origin) to prove it can't get the broker API at all.
- **Grant scope.** Grants are bound to the document that requested them, so
  the shell must request them from the document that hosts the
  `<native-window>`. If the shell ever needs to embed in a *different*
  frame (an iframe, another shell document), add an explicit
  `IssueGrant(target_rfh, …)` path rather than loosening `ResolveGrant`.
- **Revocation.** `RevokeGrant(token)` from the shell API needs nothing
  more: the host detaches and the element fires `windowclose`.
- **Element API.** `<native-window grant=…>` is what the shell sets. `window`
  is an optional consistency check, and `windowId` reports what was
  attached.

## Item 3: privileged shell origin

### Design decision: the shell is an origin given on the command line

`--plutonium-shell-origin=<origin>` names the shell. A document is the
**shell document** (`plutonium_shell::IsShellDocument(rfh)`, browser side)
only if all of these hold:

- it is in the primary main frame (`IsInPrimaryMainFrame()`). That excludes
  iframes, fenced frames, prerendered pages and back/forward-cached pages;
- its `WebContents` has no outer contents (not a guest or `<webview>`);
- it is live and not an error page;
- its committed origin **and** the origin of its committed URL are the
  shell origin. The URL check excludes about:blank, srcdoc and similar
  documents that inherit the origin. A CSP-sandboxed shell document has an
  opaque origin and fails the origin check.

The switch value must be an http(s) origin that is potentially trustworthy
(https, localhost or loopback). Anything else is ignored with an `ERROR` log
line, and then there is no shell. The renderer's claims never count:
everything above is read from the `RenderFrameHost`.

Why not a chrome:// WebUI:

- The shell is served from `spike/` in the dev loop and has to become an
  arbitrary ported web app in Phase 5. A WebUI would mean bundling it into
  Chromium's resources (or a custom data source) and rebuilding to iterate.
- WebUI's privilege machinery (WebUI bindings, the WebUI process lock) isn't
  needed. The broker API is a single interface with one check.
- An isolated web app would also fit Phase 5, since IWAs get an origin
  (`isolated-app://…`). The switch can name it later, as long as the
  scheme check is widened. Until then an http(s) origin keeps the dev loop
  as it is.

The cost: anyone who can start the browser with that flag picks the shell.
That's fine, because it's the same trust level as whoever launches the
session.

### What changed (Chromium, tagged `EXO-BROKER`)

- **New `chrome/browser/plutonium_shell.{h,cc}`** (in `exo_parts`):
  - the switch and the shell-origin parsing, plus `IsShellDocument()`;
  - **`WindowBrokerImpl`**, a `DocumentService<blink::mojom::WindowBroker>`
    and `ExoWindowBroker::Observer`. Each method re-checks `IsShellDocument`
    first:
    - `GetWindows()`;
    - `AddObserver(remote) => windows`, which forwards
      `OnWindowAdded/Changed/Removed` (for item 4);
    - `RequestGrant(id)` → `ExoWindowBroker::IssueGrant(&render_frame_host(),
      id)`;
    - `RevokeGrant(token)`, which revokes only if the token resolves for this
      document.
  - **`BindWindowBroker`**, registered in `chrome_browser_interface_binders.cc`.
    For a frame that isn't the shell document it drops the receiver (the
    pipe closes and JS calls reject with `NotAllowedError`) and logs
    `shell API refused for frame …` at `VLOG(1)`. It deliberately doesn't
    call `ReportBadMessage`. With `--enable-blink-features=PlutoniumShell` a
    healthy renderer can ask, and the shell's own same-process iframes would
    otherwise take the shell down with them.
  - **`ShellNavigationThrottle`**, registered in
    `chrome_content_browser_client_navigation_throttles.cc`. It runs at
    `WillProcessResponse` for primary-main-frame, cross-document navigations
    in top-level contents to a shell-origin URL. It calls
    `ForceEnableOriginTrials({"PlutoniumShell"})`, the same mechanism System
    Web Apps use. This only decides what script *sees*; the binder is the
    security boundary.
- **Mojom** `third_party/blink/public/mojom/native_window/window_broker.mojom`
  (same `native_window_mojo_bindings` target): `NativeWindowEntry`
  (`id, app_id, title, width, height, device_scale_factor, embedded,
  focused`), `WindowBroker` and `WindowBrokerObserver`.
- **Dev grants removed**: `NativeWindowHost.RequestDevGrant`,
  `HTMLNativeWindowElement.requestDevGrant()`, `kExoBrokerDevGrantsSwitch` /
  `DevGrantsEnabled()`, and the launcher's `DEV_GRANTS`. `grep -r DEV-ONLY`
  finds nothing.
- **Defence in depth on attach.** `NativeWindowHostImpl::Attach` refuses
  (`attach refused: frame … is not the shell`, element `windowerror`) for
  any document that isn't the shell document, before even looking at the
  grant. Grants can only be issued to the shell document anyway (the only
  `IssueGrant` caller is `WindowBrokerImpl`), and a grant only resolves for
  the document it was issued to. So the attach check is a second, independent
  wall. Any frame may still *bind* `NativeWindowHost`, so a refused element
  gets a proper `windowerror` instead of hanging in "attaching".
- **Blink.**
  - Runtime feature `PlutoniumShell` (`runtime_enabled_features.json5`). It is
    off by default and is an origin-trial feature with no token: no Google
    signature exists for it, so only the browser's force-enable turns it on.
  - New `core/html/native_window_broker.{h,cc,idl}`,
    `native_window_entry.idl` (dictionary) and
    `navigator_native_window_broker.{h,idl}`:
    `navigator.windowBroker` with `getWindows()`, `requestGrant(id)` →
    `Promise<DOMString>` (rejects `NotAllowedError` for an unknown window or
    a refused binding), and `revokeGrant(grant)`.
  - The interface object and the navigator attribute are `[RuntimeEnabled=
    PlutoniumShell, SecureContext]`. On ordinary pages `'windowBroker' in
    navigator` is false and `NativeWindowBroker` is undefined.

### Verification

Run on the Xvfb dev loop. The launcher now passes
`--plutonium-shell-origin=http://localhost:8765` (override with
`SHELL_ORIGIN`, empty for none) and serves `spike/` on both
`localhost:8765` (shell) and `127.0.0.1:8766`. The second is an ordinary
origin, and a different *site*, so it runs in a separate renderer. Command:
`PAGE_QUERY='?w=420&h=330' EXTRA_FLAGS='--vmodule=exo_window_broker=1,exo_embedder=1,plutonium_shell=1'
tools/launch-phase1.sh phase2-shell <kcalc> foot`.

- **Shell works** (`logs/phase1-phase2-shell.log`). The log shows:
  1. `exposing the shell API to http://localhost:8765/phase1.html…`;
  2. `shell API bound for frame (36,5)`;
  3. grants issued for #1 and #2;
  4. both attach.

  Clicking kcalc and typing `7*6=` gives 42 (`shots/phase2-shell-type.png`),
  and the Edit menu opens (`phase2-shell-menu.png`).
- **Shell checks** (`tools/cdp_eval.py localhost:8765/phase1
  "import('/phase2-grant-checks.js').then(m => m.run(1, 2))"`):
  ```
  exposure: windowBroker in navigator: true, NativeWindowBroker: function
  validGrant / validGrantNoWindowAttr: attached windowId=1
  noGrant: none     forgedToken / malformedToken / otherWindowsGrant: failed +windowerror
  iframeExposure (srcdoc) / urlIframeExposure (same-origin URL):
      windowBroker in navigator: false, NativeWindowBroker: undefined
  grantInIframe / grantInUrlIframe: failed +windowerror
  grantUnknownWindow: rejected NotAllowedError
  revokeGrant: attached -> windowclose closed      revokedGrantReuse: failed +windowerror
  ```
  The browser logged `attach refused: frame (36,1) is not the shell` and
  `(36,2)` for the two iframes. A reload, then `runAfterReload()`, gave
  `oldDocumentsGrant: failed +windowerror`. The reloaded document got the
  API again, and a new binding on frame (36,12). Log
  `logs/phase1-phase2-shell2.log`.
- **Ordinary tab** (`http://127.0.0.1:8766/phase1.html`, same page, opened
  in a second window). `runOrdinary(1, <grant copied from the shell>)`:
  ```
  exposure: windowBroker in navigator: false, NativeWindowBroker: undefined
  noGrant: none   forgedToken: failed +windowerror
  stolenShellGrant / stolenShellGrantNoWindowAttr: failed +windowerror
  ```
  The page shows "not the shell" and requests no grants
  (`shots/phase2-ordinary-tab.png`).
  - **Input:** with its `#w1` element set to the stolen grant and sitting
    exactly where kcalc is in the shell, I made five clicks (the kcalc
    display, the "5" and "7" buttons, foot's area, the display again) and
    typed `99+1=`. All 5 mousedowns hit the page's own elements and all
    keys reached the page (`downs ["w1","w1","w1","w2","w1"]`, `keys
    "99Shift+1="`).
  - Back in the shell, kcalc still shows 42 and isn't focused
    (`phase2-shell-before-ordinary.png` → `phase2-ordinary-probes.png` →
    `phase2-shell-after-ordinary.png`).
- **Browser boundary with the API force-exposed**
  (`EXTRA_FLAGS='--enable-blink-features=PlutoniumShell …'`,
  `logs/phase1-phase2-forced.log`). `forcedApi(1)` was run in the ordinary
  tab, then `forcedApi(1, 'srcdoc')` and `forcedApi(1, 'url')` in the shell:
  - all three see the API (`windowBroker in navigator: true`);
  - `getWindows` and `requestGrant` both give `rejected NotAllowedError`;
  - the browser logs `shell API refused for frame` for
    `(41,5) http://127.0.0.1:8766/…`, `(36,1) about:srcdoc` and
    `(36,2) http://localhost:8765/exo-surfaces.json?iframe=…`.

  The shell itself still bound and attached kcalc.
- **No acceptable shell** (`SHELL_ORIGIN=http://example.com:8765`,
  `logs/phase1-phase2-noshell.log`, `shots/phase1-phase2-noshell.png`):
  - `ignoring --plutonium-shell-origin=http://example.com:8765/ (needs …
    localhost or loopback)`;
  - the page at localhost:8765 has no API and gets no grants, and kcalc
    stays unembedded.
- **Not done:**
  - no unit or browser tests;
  - `AddObserver` / `WindowBrokerObserver` is implemented browser-side but
    nothing in Blink binds it yet, so it's unexercised (item 4);
  - a popup or `window.open()` from the shell, a `<webview>` / guest navigated
    to the shell origin, and prerender of the shell weren't exercised live.
    All are excluded by `IsShellDocument` by construction (primary main
    frame, no outer contents, URL origin check);
  - the patch wasn't regenerated.

### Notes for item 4

- **Events.** The channel exists:
  - `WindowBroker.AddObserver(pending_remote<WindowBrokerObserver>) =>
    (windows)` returns a snapshot and then forwards the broker's add, change
    and remove events;
  - `WindowBrokerImpl` already observes `ExoWindowBroker` and fans out to a
    `mojo::RemoteSet`. Item 4 needs the Blink side: make
    `NativeWindowBroker` an `EventTarget` (or add an observer callback),
    bind a `HeapMojoReceiver<WindowBrokerObserver>` on first listener, and
    dispatch `windowadded` / `windowchanged` / `windowremoved` with a
    `NativeWindowEntry`.
  - `OnGrantRevoked` isn't forwarded. The element already gets
    `windowclose`, so add it only if the shell needs it.
  - The snapshot-then-events ordering is safe because both run on the UI
    thread and the reply is sent before any later event.
- **Then remove** `EmbeddedWindows::PublishRegistry`, `$EXO_EMBED_REGISTRY`,
  the launcher's `exo-surfaces.json` / `echo '[]' >` and registry print, and
  `phase1.html`'s `poll()`. Use `navigator.windowBroker` instead.
  - `phase1.html` already creates a card per window id and requests the
    grant there, so only the list source changes.
  - Ordinary pages then have no window list at all. Today they can still
    fetch `exo-surfaces.json` from `spike/`, which is a dev-loop leak of
    titles and app ids, not of capabilities.
  - The forced-API iframe check fetches `/exo-surfaces.json?iframe=` as a
    same-origin document. Point it at any other spike file once the JSON
    goes.
- **Where to put new shell-only APIs.** Add methods to `WindowBroker` (or a
  sibling interface bound through `plutonium_shell::BindWindowBroker`-style
  binders that call `IsShellDocument`). Gate the Blink side with
  `[RuntimeEnabled=PlutoniumShell]`.

## Item 4: push events, no registry file

### What changed

Chromium (tagged `EXO-BROKER`):

- **Exo** (`components/exo/embedded_windows.{h,cc}`):
  `EmbeddedWindows::PublishRegistry`, `last_published_registry_` and the
  `$EXO_EMBED_REGISTRY` read are removed, with their now-unused includes.
  The chrome binary no longer contains the string `EXO_EMBED_REGISTRY`.
  Windows are only visible through `ExoWindowBroker`.
- **Mojom** (`window_broker.mojom`): `AddObserver` now takes a
  `pending_associated_remote<WindowBrokerObserver>`. The observer shares the
  `WindowBroker` pipe, so the reply (the snapshot) is ordered before every
  event sent after it, with no gap and no duplicates. Two separate pipes
  give no ordering guarantee on the receiving side.
- **Browser** (`plutonium_shell.cc`): `mojo::AssociatedRemoteSet`. Forwarding
  is skipped unless the document is still the shell (`StillShell()`), like
  every other method. A `VLOG(1)` line `shell observer added` is logged per
  subscription.
- **Blink**:
  - `NativeWindowBroker` is now an `EventTarget` (`event_target_names`
    `NativeWindowBroker`) and a `mojom::blink::WindowBrokerObserver`, with a
    `HeapMojoAssociatedReceiver`. It has `onwindowadded`, `onwindowchanged`
    and `onwindowremoved` (new `event_type_names`).
  - Adding the first listener of those types (`AddedEventListener`)
    subscribes once per document. The snapshot is dispatched as one
    `windowadded` per existing window, then live events follow. Removing
    listeners doesn't unsubscribe. `getWindows()` still exists. If the
    binding is refused the pipe closes, nothing is dispatched, and later
    calls reject with `NotAllowedError` as before.
  - New `NativeWindowEvent : Event` (`core/html/native_window_event.{h,cc,idl}`,
    `[RuntimeEnabled=PlutoniumShell, SecureContext]`) has `windowId` and
    `entry`. `entry` is a `NativeWindowEntry` (a fresh object per read,
    because WebIDL forbids dictionary-typed attributes, so it's `any`). It is
    null for `windowremoved`.

Repo:

- `spike/phase1.html`: `poll()` is gone. The shell builds its cards from the
  three events and keeps `window.windows` (id → entry) and `window.events`
  (an event log) for tools. Outside the shell there is no list. The status
  reads "not the shell · no window list", and `?ids=1,3` creates grantless
  cards for the given ids, for ordinary-tab probes. Window ids aren't
  capabilities.
- `tools/launch-phase1.sh`: the `echo '[]' > exo-surfaces.json`, the
  `EXO_EMBED_REGISTRY` env and the registry print are gone. At the end it
  prints the shell page's `window.windows` through `tools/cdp_eval.py`
  (`windows: ["1=org.kde.kcalc \"KCalc\"", …]`).
- `spike/phase2-grant-checks.js`: the URL iframe now loads
  `/phase2-grant-checks.js?iframe=…`. `run()` adds `pushedList` (the
  event-built list compared with `getWindows()`). `forcedApi()` adds `events`
  (subscribes and reports what arrives).
- The v0 spike (`tools/launch-cros-spike.sh`, `spike/index.html`) still
  expects the registry file and no longer works with this build. I left it
  alone apart from a NOTE in the script header. `.gitignore` keeps
  `spike/exo-surfaces.json`, now commented as v0-only.

### Verification

Xvfb dev loop, `PAGE_QUERY='?w=420&h=330'
EXTRA_FLAGS='--vmodule=exo_window_broker=1,exo_embedder=1,plutonium_shell=1'
tools/launch-phase1.sh phase2-push <kcalc> "foot -T start sh -c 'sleep 25;
printf \"\033]2;renamed-by-osc\007\"; exec sleep 3600'"` (log
`logs/phase1-phase2-push.log`).

- **Push only.** The shell bound and subscribed (`shell API bound for frame
  (36,5)`, `shell observer added`) *before* any client started. Its
  `window.events` then read:
  ```
  added 1 org.kde.kcalc "KCalc"        changed 1 "KCalc" 420x341 embedded
  added 2 foot "start"                 changed 2 "start" 696x488 embedded
  changed 2 "start" 416x318 embedded   changed 2 "renamed-by-osc" 416x318 embedded
  ```
  The last line is the client changing its title (OSC 2) 25 s later.
  There is no fetch and no timer in the page. No `exo-surfaces.json` exists
  in `spike/` or anywhere in the container (`find / -name 'exo-surfaces*'`),
  and the browser's environment has no registry variable.
  - One stray `[]` file did appear in `spike/` during the first launch,
    at 21:09:19, before Ash started. That content is what the old launcher
    used to write, and the current launcher and binary can't produce it. It
    didn't come back on the later launch or during any of the checks. Most
    likely another process ran an old launcher; I deleted it.
- **Snapshot.** After a reload the snapshot arrived as `added 1 …`, `added 2
  foot "renamed-by-osc"`, then live `changed` events.
- **Live add.** A third client (`foot -T live-client`, retitled 6 s later)
  started while the page was open. The card appeared live with `added 3`
  and later `changed 3 "live-renamed"` (`shots/phase2-push-added.png`).
- **Remove.** Killing the first foot logged `window removed: #2`, and the page
  got `removed 2`. The card went and the status read `2 windows: 1, 3`
  (`phase2-push-removed.png`).
- **No regression.** kcalc `7*6=` → 42, foot echoes typed text, and kcalc's
  Edit menu opens (`phase2-push-type.png`, `phase2-push-menu.png`). Focus
  changes arrive as `windowchanged … focused`.
- **Exit regression: `phase2-grant-checks.js` re-run.**
  - Shell `run(1, 3)`:
    ```
    exposure: windowBroker in navigator: true, NativeWindowBroker: function
    pushedList: events [1,3] getWindows [1,3] match
    validGrant / validGrantNoWindowAttr: attached windowId=1
    noGrant: none     forgedToken / malformedToken / otherWindowsGrant: failed +windowerror
    iframeExposure / urlIframeExposure: windowBroker in navigator: false, NativeWindowBroker: undefined
    grantInIframe / grantInUrlIframe: failed +windowerror
    grantUnknownWindow: rejected NotAllowedError
    revokeGrant: attached -> windowclose closed     revokedGrantReuse: failed +windowerror
    ```
  - After a reload, `runAfterReload()` gave `oldDocumentsGrant: failed
    +windowerror`.
  - Ordinary tab `http://127.0.0.1:8766/phase1.html?ids=1,3` (no API,
    `NativeWindowEvent` undefined, status "not the shell · no window list"),
    `runOrdinary(1, <shell grant>)`: noGrant `none`; forgedToken,
    stolenShellGrant and stolenShellGrantNoWindowAttr all `failed
    +windowerror`.
  - Input: with `#w1` holding the stolen grant and sitting exactly over
    the shell's kcalc, five clicks hit the page (`downs ["w1","w1","w1","w3","w1"]`)
    and so did `99+1=` (`keys "99Shift+1="`). kcalc kept 42
    (`phase2-push-shell-before-ordinary.png` → `phase2-push-ordinary-probes.png`
    → `phase2-push-shell-after-ordinary.png`).
- **Forced API** (`--enable-blink-features=PlutoniumShell`,
  `logs/phase1-phase2-push-forced.log`). In the ordinary tab, then in the
  shell from a srcdoc iframe and a same-origin URL iframe, `forcedApi`
  gave:
  - `getWindows` / `requestGrant`: `rejected NotAllowedError`;
  - `events`: `no events`.

  The ordinary page's own load-time subscription got nothing either: status
  `0 windows`, `events []`. That held even when a new client started while
  it was open, which the shell saw as `added 2 foot "forced-live"`
  (`shots/phase2-push-forced.png`).

  A fresh srcdoc iframe that *only* added `onwindowadded` /
  `windowchanged` listeners got nothing in 2 s. The browser logged `shell
  API refused for frame` for `(41,5) http://127.0.0.1:8766/…`, `(36,1)
  about:srcdoc`, `(36,2) …/phase2-grant-checks.js?iframe=…` and `(36,3)
  about:srcdoc`. `shell observer added` appears only for the shell's frame.
- **Not done:**
  - no unit or browser tests;
  - `OnGrantRevoked` still isn't forwarded (elements get `windowclose`);
  - unsubscribing on last-listener removal isn't implemented;
  - `NativeWindowEvent` has no script constructor;
  - patch not regenerated, nothing committed.

## Log

- 2026-10-15: Tracker created. Item 1: `ExoWindowBroker` added (registry
  mirrored from `exo::EmbeddedWindows`, add/change/remove events, per-document
  grants with revocation on window close and document destruction), plus an
  `attached` flag in `EmbeddedWindows::Info`. Built and verified with kcalc on
  Xvfb. Temporary grant hook removed; broker logging stays at `VLOG(1)`. JSON
  registry untouched. Not committed, patch not regenerated.
- 2026-10-15: Item 2 done.
  - `NativeWindowHost.Attach` takes a grant and resolves it through the
    broker. Hosts detach on revocation.
  - The input router only routes to sinks linked to the page's own views.
  - Exo refuses focus and input for unattached windows.
  - Hit-test aggregator rewrite tightened (client submitters only, re-run
    cycle check).
  - `<native-window grant>` added, with `windowerror` and `windowId`.
  - Dev-only `requestDevGrant` behind `--exo-broker-dev-grants`, which the
    launcher adds by default.
  - Verified on Xvfb with kcalc and foot (valid, forged, malformed,
    wrong-window, iframe, reload, window close, no switch).
  - Not committed, patch not regenerated.
- 2026-10-15: Item 3 done.
  - The shell is identified by `--plutonium-shell-origin` (http(s),
    potentially trustworthy). `IsShellDocument` checks primary main frame,
    top-level contents, committed origin and URL origin, all browser side.
  - `blink.mojom.WindowBroker` (`GetWindows`, `AddObserver`, `RequestGrant`,
    `RevokeGrant`) is bound only for the shell document.
  - `navigator.windowBroker` is exposed only there, via a browser
    force-enabled origin trial (`PlutoniumShell`).
  - `<native-window>` attach is also refused outside the shell document.
  - All dev-grant code is removed.
  - Launcher: `SHELL_ORIGIN`, plus a second, ordinary origin on
    127.0.0.1:8766.
  - Verified on Xvfb: the shell, an ordinary tab (exposure, stolen grant,
    input), same-origin iframes, forced exposure, invalid shell origin.
  - Not committed, patch not regenerated.
- 2026-10-15: Item 4 done; Phase 2 exit criterion met.
  - Exo's JSON registry (`PublishRegistry`, `$EXO_EMBED_REGISTRY`) is
    removed.
  - `navigator.windowBroker` is an `EventTarget`: the first listener
    subscribes, the snapshot arrives as `windowadded`, then live
    `windowadded` / `windowchanged` / `windowremoved` events carry
    `NativeWindowEvent` (`windowId`, `entry`). The observer is an associated
    interface, so the snapshot and events stay ordered.
  - `phase1.html` builds its list from events only (no `poll()`). The
    launcher writes no file and prints the shell's list over CDP.
  - Verified on Xvfb: live add, title change, remove, typing and menus.
    Re-ran the full `phase2-grant-checks.js` (shell, reload, ordinary tab
    with input probes, forced API incl. observer).
  - Not committed, patch not regenerated.
- 2026-10-15: Phase 2 closed. No debug leftovers in the Chromium tree
  (`DEV-ONLY`, `EXO_EMBED_REGISTRY`, `exo-surfaces` absent; the remaining
  `LOG(ERROR/WARNING)` lines in `plutonium_shell.cc` are deliberate config
  messages), so no rebuild. `patches/exo-phase2.patch` regenerated against
  `9f2eedcd653d` (87 files, untracked files included via intent-to-add, not
  committed); `git apply -R --check` passes. `PHASE2_REPORT.md` written;
  backlog, README and plan updated; `/tmp` helpers moved to
  `tools/{pm,xd,shot}.sh`. Nothing committed.
