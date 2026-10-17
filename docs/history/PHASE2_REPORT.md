# Phase 2: security model and broker

Date: 2026-10-15. Branch `exo-viability`, patch `patches/exo-phase2.patch` (all Chromium changes against `9f2eedcd653d`, a superset of `exo-phase1.patch`). Phase 2 code is tagged `EXO-BROKER`. Item-by-item detail and raw check output are in `PHASE2_PROGRESS.md`.

## Result

The exit criterion is met on the Xvfb dev loop: **an ordinary web page cannot embed or inject into any native window; the shell can.**

- **Shell** (`http://localhost:8765`, named by `--plutonium-shell-origin`): it lists windows from pushed broker events, gets grants and embeds kcalc and foot. kcalc's `7*6=` gives 42 and its menus open.
- **Ordinary tab** (`http://127.0.0.1:8766`, a different site): it has no broker API and gets no window list. A grant copied out of the shell is refused there. Its element sat exactly over the shell's kcalc, and all 5 clicks and every key of `99+1=` reached the page. kcalc kept 42.
- **API force-exposed** (`--enable-blink-features=PlutoniumShell`): the browser refuses to bind it for the ordinary tab and for srcdoc and same-origin URL iframes in the shell. They get no list, no events and no grants.

| # | Item | Result | Evidence (`shots/phase2-*.png`, `logs/phase1-phase2-*.log`) |
|---|---|---|---|
| 1 | Window broker: registry, lifecycle events, grants | ✅ `ExoWindowBroker` mirrors Exo's windows. It fires add/change/remove and issues per-document grants, which are revoked on window close and when the document goes away | `broker-type`, `broker-final`; `logs/phase1-broker{1,2}.log` |
| 2 | Grant-checked embedding; viz hit-test change limited to browser-registered children | ✅ Attach resolves a grant. No grant, a forged or malformed token, another window's grant, an iframe's use and a pre-reload grant were all refused, and input at refused elements stayed in the page | `grant-valid-{type,menu}`, `grant-refused-probes`, `grant-after-refused`, `nogrant` |
| 3 | Privileged shell origin | ✅ Only the shell document gets `navigator.windowBroker`, and the browser checks it. The dev-grant path is gone | `shell-{type,menu}`, `ordinary-tab`, `ordinary-probes`, `shell-{before,after}-ordinary`; logs `shell`, `shell2`, `forced`, `noshell` |
| 4 | Remove the JSON registry and polling; push events | ✅ `$EXO_EMBED_REGISTRY` and `poll()` are gone. Live add, title change and remove arrive as events. The snapshot and events are ordered | `push-added`, `push-removed`, `push-{type,menu}`, `push-ordinary-probes`, `push-forced`; logs `push`, `push-forced` |
| — | Exit re-run on the final build (`spike/phase2-grant-checks.js`) | ✅ shell `run(1, 3)`, `runAfterReload()`, ordinary `runOrdinary(1, stolen)` with input probes, `forcedApi` for every non-shell frame | `push-shell-checks`, `push-shell-{before,after}-ordinary` |

## How it works

**Broker.** `ExoWindowBroker` (`chrome/browser/exo_window_broker.{h,cc}`) is owned by `ExoParts` and lives as long as the Wayland server.
- It observes `exo::EmbeddedWindows` and keeps `WindowInfo` (`id`, `app_id`, `title`, size in DIPs, scale, `embedded`, `focused`).
- Observers get `OnWindowAdded`, `OnWindowChanged` (real field changes only) and `OnWindowRemoved`.
- Window ids are stable but aren't capabilities.

**Grants.** A grant is a `base::UnguessableToken` bound to one window and one document.
- The document is identified by its frame's global id *and* a random per-document id in `DocumentUserData`, so a same-RFH navigation can't inherit a grant.
- Grants are revoked on window close (before `OnWindowRemoved`) and when the document is destroyed.
- They are per document, not per element.

**Shell identification.** `plutonium_shell::IsShellDocument(rfh)` (`chrome/browser/plutonium_shell.{h,cc}`) reads everything from the `RenderFrameHost`, so renderer claims never count. The document must:
- be in the primary main frame (this excludes iframes, fenced frames, prerender and bfcache);
- be in top-level contents (no guest or `<webview>`);
- be live and not an error page;
- have both its committed origin and its committed URL's origin equal to `--plutonium-shell-origin`.

The switch must name an http(s), potentially trustworthy origin; anything else means no shell. This was chosen over a chrome:// WebUI so the shell can stay a served web app (Phase 5). An isolated web app origin can be allowed later by widening the scheme check.

**Shell API.** `blink.mojom.WindowBroker` (`GetWindows`, `AddObserver`, `RequestGrant`, `RevokeGrant`) is served by `WindowBrokerImpl`, a `DocumentService`.
- The binder drops the receiver for non-shell frames, and every method re-checks `IsShellDocument`.
- Blink exposure: `ShellNavigationThrottle` force-enables the `PlutoniumShell` origin trial (as System Web Apps do) on navigations to the shell origin. `navigator.windowBroker` and `NativeWindowEvent` are `[RuntimeEnabled=PlutoniumShell, SecureContext]`.
- Exposure only decides what script sees. The binder is the boundary.

**Push events.** `navigator.windowBroker` is an `EventTarget`. The first `windowadded`/`windowchanged`/`windowremoved` listener calls `AddObserver` with an *associated* observer. Because the observer shares the broker pipe, the snapshot reply (delivered as `windowadded` events) is ordered before every later event. The JSON registry (`EmbeddedWindows::PublishRegistry`, `$EXO_EMBED_REGISTRY`) is removed, and the binary no longer contains the string.

**Enforcement points.**
- **Attach.** `NativeWindowHostImpl::Attach(grant, window_id, client)`:
  - it refuses non-shell documents first;
  - it then resolves the grant, and the grant decides the window (a non-zero `window_id` is only a consistency check);
  - a refusal means no frame-sink link, no parking and no client. The element fires `windowerror`.
- **Revocation.** The host observes the broker and closes (`windowclose`) on revocation or window destruction. `SetSize`/`Focus`/`Blur` re-validate the grant.
- **Input router.** `IsForeignFrameSinkEmbeddedHere(sink)` requires a granted link to one of *this* router's views. It is used by the viz fast path and by `RouteToForeign`, the chokepoint every foreign route passes through, which also drops a stale capture. The renderer-targeter path already required `IsEmbeddedIn`.
- **Exo.** `Focus` and mouse dispatch refuse windows with no attached element.
- **Viz hit-test aggregator.** The `(client, n) → (0, n)` rewrite now needs all of: a client submitter, a region that isn't already a valid child, and `(0, n)` registered as a direct child of the submitter, which only `ExoEmbedder::LinkFrameSinks` does after a grant check. The cycle check runs on the rewritten id.

At the viz/input level the unit is the widget: same-process frames under one `RenderWidgetHost` share a link. That is the renderer trust boundary anyway. Cross-site OOPIFs have their own widgets.

## Bugs found

None recorded in `PHASE2_PROGRESS.md`. The item 2 review tightened two things the spike left loose:
- the input router's fast path accepted any view-less sink;
- the aggregator rewrite applied to any client-id-0 region.

## Known issues and limits

- **No unit or browser tests.** Everything was checked by hand on Xvfb, using the scripted checks in `spike/phase2-grant-checks.js`.
- **Not exercised live** (ruled out by construction, by inspection only):
  - a popup or `window.open()` from the shell, a `<webview>`/guest at the shell origin, a prerendered shell;
  - cross-site iframes (only same-origin srcdoc and URL iframes were tried);
  - a compromised renderer calling `Focus`/`SetSize` without attaching (the browser re-checks the grant);
  - grant reuse across a same-RFH navigation (reloads swapped the RFH).
- **`OnGrantRevoked` isn't forwarded to the shell.** The element's `windowclose` covers it for now.
- **Removing the last listener doesn't unsubscribe** from broker events.
- **`NativeWindowEvent` has no script constructor.**
- **The v0 spike is broken** (`tools/launch-cros-spike.sh`, `spike/index.html`), because it relied on the removed registry file. The script carries a note saying so.
- **Testing was Xvfb + shm only.** The DRM/dmabuf path wasn't re-run (still open from Phase 1).
- **Anyone who can set `--plutonium-shell-origin` picks the shell.** That's intended: it's the same trust level as whoever launches the session.

## Dev loop

```
tools/launch-phase1.sh <tag> "<client cmd>"...   # Ash on Xvfb :99; serves spike/ on :8765 (shell) and :8766 (ordinary)
tools/cdp_eval.py localhost:8765/phase1 "import('/phase2-grant-checks.js').then(m => m.run(1, 2))"
```

- **Launcher changes.**
  - `SHELL_ORIGIN` (default `http://localhost:8765`; empty for no shell).
  - `PAGE_ORIGIN` picks where the page opens. `http://127.0.0.1:8766` is the ordinary origin.
  - No registry file is written. The launcher prints the shell's `window.windows` over CDP at the end.
  - Broker logs: `EXTRA_FLAGS='--vmodule=exo_window_broker=1,exo_embedder=1,plutonium_shell=1'`.
- **`spike/phase2-grant-checks.js`**:
  - `run(ok, other)` in the shell;
  - `runAfterReload()`;
  - `runOrdinary(id, stolenGrant)` in an ordinary tab (`phase1.html?ids=1,3` gives grantless cards);
  - `forcedApi(id[, 'srcdoc'|'url'])` with the API force-exposed.
- **`spike/phase1.html`** builds its cards from broker events. Outside the shell it shows "not the shell · no window list".
- **Helpers**: `tools/pm.sh` (podman through `systemd-run --user`), `tools/xd.sh` (xdotool on `:99`), `tools/shot.sh` (screenshot of `:99`).

## Files

- **New:**
  - `chrome/browser/exo_window_broker.{h,cc}`
  - `chrome/browser/plutonium_shell.{h,cc}`
  - `third_party/blink/public/mojom/native_window/window_broker.mojom`
  - `third_party/blink/renderer/core/html/native_window_broker.{h,cc,idl}`, `native_window_entry.idl`, `native_window_event.{h,cc,idl}`, `navigator_native_window_broker.{h,idl}`
- **Changed:**
  - **Exo:** `embedded_windows.{h,cc}` (`attached`, `IsAttached`, registry removed)
  - **Browser:** `exo_embedder.cc` (grant-checked attach, revocation), `exo_parts`, `chrome_browser_interface_binders.cc`, `chrome_content_browser_client_navigation_throttles.cc`, `BUILD.gn`
  - **Input:** `render_widget_host_input_event_router.{h,cc}`
  - **Viz:** `hit_test/hit_test_aggregator.cc`
  - **Blink:**
    - `native_window.mojom` (grant attach, `window_id`)
    - `html_native_window_element.{h,cc,idl}` (`grant`, `windowId`, `windowerror`)
    - `html_attribute_names.json5`, `event_target_names.json5`, `event_type_names.json5`
    - `runtime_enabled_features.json5` (`PlutoniumShell`)
    - IDL/build lists
- **Repo:**
  - **Changed:** `tools/launch-phase1.sh`, `spike/phase1.html`, `.gitignore`, `tools/launch-cros-spike.sh` (note only)
  - **New:** `spike/phase2-grant-checks.js`, `tools/{pm,xd,shot}.sh`
