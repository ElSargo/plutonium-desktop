# Browser features for tabs

**Status: the common plumbing ("As built: adding a feature"), zoom, find in page, permission prompts with per-thread grants, downloads, file pickers (for native apps too, through the FileChooser portal) and printing are built; form autofill is not, for now (Decision 9).** The tasks are in `BACKLOG.md`, "Browser features for tabs".

A tab is a `WebContents` the registry owns (`plutonium_tabs.cc`, `TABS.md`). No `Browser` stands behind it, so whatever Chrome reaches through a `Browser` is missing: find-in-page, zoom, printing, permission prompts, downloads UI, file pickers and form autofill. Decided (2026-10-20): attach the tab helpers these features need to the tabs' `WebContents`, rather than hosting tabs in a hidden `Browser`.

Each feature works the way context menus do (`CHROME_UI.md`) and capture is planned (`CAPTURE.md`). The browser asks a shell through the broker. The shell library draws a default UI, which a shell can restyle or replace with its own. Chrome's own UI is the fallback when no shell takes the request. Passwords are not part of this: the helper types them in (`PASSWORDS.md`).

## Why not `TabFeatures`

In this checkout, `TabHelpers::AttachTabHelpers` is gone. Chrome attaches a tab's helpers in `TabFeatures::Init(tabs::TabInterface&, Profile*)` (`chrome/browser/ui/tabs/tab_features.cc`), and many of them need the `TabInterface`: its browser window, tab strip and page actions. Our tabs aren't `TabInterface`s, and making them one would bring the tab strip and the browser window in with it.

So the registry's `Tab` attaches, one by one, the `WebContentsUserData` helpers that only need a `WebContents`, using the same lines as `tab_features.cc`. It implements the `WebContentsDelegate` methods that `BrowserWebContentsDelegate` (`chrome/browser/ui/browser_web_contents_delegate/browser_web_contents_delegate.cc`) implements for these features. Where Chrome's UI then looks for a `Browser`, we hook in a request to the shell. Each section below lists its helpers.

## The common shape

All features use the same plumbing, written once (`plutonium_tab_requests.{h,cc}`, generalising `plutonium_context_menu.cc`'s `Pending`):

- **Who is asked.** For a tab, the shell page whose `<embed>` shows the tab, or else the visible shell (`PlutoniumTabs::shell()`), as for context menus. For a native app's portal request, the focused shell, as in `CAPTURE.md`.
- **Requests.** The broker sends a cancelable event, such as `filechooserrequest`. The shell calls `preventDefault()` to take it, and later answers with the request's id. If no listener takes it, the fallback runs at once. If a shell takes it and then goes away (it reloads, closes or crashes), the request is cancelled or falls back, depending on the feature (`WrapCallbackWithDefaultInvokeIfNotRun`, as context menus do). A request never hangs.
- **Pending state on the tab.** `BrowserTabEntry` gets `pending: {permission?, fileChooser?, print?}`, as it already has `dialogType`. Every shell, the switcher and agents can see a tab that waits on the user, mark it with a dot and bring it forward.
- **State goes to every shell.** Zoom, find results, downloads and devices in use are reported to every shell through `tabchanged` or their own events, as `capturestart` will be.
- **Commands.** `tabCommand(id, …)` gets `"find"`, `"print"`, `"zoom-in"`, `"zoom-out"` and `"zoom-reset"`, so a shell's own buttons and menus can start them, not only keys.
- **Keys.** Once the page has let a key through, a tab gets Chrome's key for each feature, as it got back, forward and reload (`plutonium_keys.cc`, `Tab::HandleKeyboardEvent`): Ctrl+F, F3, Ctrl+G and Ctrl+Shift+G, Ctrl+P, Ctrl+plus, Ctrl+minus and Ctrl+0. A page like Google Docs that takes Ctrl+F for itself keeps it.
- **Shell library.** `connect({ findBar, zoom, permissions, fileChooser, print, downloads })`. Each option is either `false` (leave it to Chrome), a function (draw it yourself and return true if you took the request), or left out (the library draws it). The look comes from custom properties, as with menus: `--plutonium-dialog-bg`, `-fg`, `-border`, `-radius`, `-shadow`, `-font`, `-accent`, plus the menu's `--plutonium-menu-*`.
- **Context menu.** Print, and "Save link, image or page as", come back to the tab's menu (`Keeps()` in `plutonium_context_menu.cc`) once printing and downloads work.

### As built: adding a feature

The plumbing is the patch "Plutonium: common plumbing for tab features", with the library and helper parts in this repo. A feature adds to it in these places, one or a few lines each:

- **Helpers.** Attach them in `Tab::AttachHelpers()` (`plutonium_tabs.cc`). Delegate methods go on `Tab`, next to the others it implements.
- **A request.** Call `PlutoniumTabRequests::Get()->Start(contents, params)` (`plutonium_tab_requests.h`), and keep the returned `Handle` for as long as the request may be answered. Destroying the handle cancels the request.
  - `params.kind` is the request type in lowerCamelCase, such as `"fileChooser"` or `"permission"`. `params.detail` is a `base::DictValue`: the shell's `request.detail`, and the tab's `pending.<kind>.detail`.
  - `on_answer(from, answer)` gets the JSON answer from `kShell` or `kAgent`. Return false to refuse it (for example, an agent's "allow"); the request then stays open.
  - `on_fallback(reason)` runs, posted, when no shell takes the request (`kNotTaken`) or the shell that took it goes away (`kShellGone`). It runs Chrome's UI, or cancels or dismisses.
  - Start() returns null for a page that isn't a registry tab. Callbacks never run from inside Start(). While the request is open, the tab's state has `pending.<kind> = {requestId, taken, detail}`.
  - The request goes to the shell whose `<embed>` shows the tab, or else to the visible shell (`PlutoniumTabRequests::ShellFor()`).
- **A state field.** `PlutoniumTabs::Get()->SetTabState(contents, "zoom", base::Value(110))` sets one; `base::Value()` removes it. Shells see it as `tab.zoom` in the library, with a `tabstatechange {tab, key, value, previous}` event, and as `BrowserTabEntry.stateJson` in the raw broker. Agents see it as `Plutonium.Tab.stateJson`, and the helper's `ThreadTab` shows it as `pending`, plus `state` for everything else.
- **A command.** Add it in the `PlutoniumTabs` constructor with `AddCommand("zoom-in", handler)`. The handler is `(WebContents*, const base::DictValue& args, CommandCallback done)`, and `done` takes a `base::Value` result, or `std::nullopt` for a failure. It runs from the shells (`shell.tabCommand(id, name, args)` resolves with the result), from agents (`Plutonium.tabCommand`, the helper's `POST /v1/threads/<t>/tabs/<id>/command {command, args}`), and from keys.
- **A key.** `plutonium_keys::GetTabCommandKey()` maps a key to a command name. Ctrl+F, F3, Ctrl+G, Ctrl+Shift+G, Ctrl+P and Ctrl+plus/minus/0 are already mapped, and a key does something once its command is added. The page gets the key first.
- **A library option.** For a request kind, `registerTabRequestKind(kind, {option, draw})` in `plutonium-shell.js`. With `connect({[option]: false})`, the shell leaves the request to the fallback. A function `(request) => boolean` draws it itself. Otherwise `draw(shell, request)` does, returning true if it took the request. `request` is `{requestId, tabId, kind, detail, tab, signal, answer(answer)}`, and `signal` aborts on `tabrequestend`. A feature without requests, such as zoom, reads `shell.options.<name>`. Dialogs use `ensureDialogStyle()` and the `.plutonium-dialog` class (the `--plutonium-dialog-*` properties); `shell.showTabToast(tabId, text)` and `shell.shownTabElement(tabId)` do what their names say.
- **An agent tool.** Add it in `helper/src/mcp.ts`, next to `answer_dialog`. It posts to `/v1/threads/<thread>/tabs/<id>/request {kind, answer}`, which answers the tab's `pending.<kind>` through `Plutonium.answerTabRequest`; the kind's `on_answer` decides whether an agent may give that answer. Agents see `pending` in `list_tabs`.

The raw broker API, for shells that don't use the library, is in `native_window_broker.idl`: `tabrequest` and `tabrequestend` (a `TabRequestEvent`), `answerTabRequest(requestId, answerJson)`, `tabCommand(tabId, command, argsJson)` returning the result as JSON, and `BrowserTabEntry.stateJson`.

## Find in page

**Built** (the patch "Plutonium: find in page for tabs", `plutonium_find.{h,cc}`; the library's find bar; the agent tool `find_in_tab`).

**Helpers.** `PlutoniumFind::Attach()` in `Tab::AttachHelpers()`: `FindBarState::ConfigureWebContents()` (`chrome/browser/ui/find_bar/find_bar_state.cc`) creates `find_in_page::FindTabHelper` (`components/find_in_page/find_tab_helper.h`) with the profile's last search, and `PlutoniumFind`, a `WebContentsUserData` that drives it (`StartFinding()`, `StopFinding()`) and observes its results (`FindResultObserver::OnFindResultAvailable()`). Chrome's find bar is `FindBarController` with a views `FindBarHost` in the `BrowserView`, and we don't use it.

**Commands** (`PlutoniumFind::AddCommands()` in the `PlutoniumTabs` constructor):

| Command | Keys | Args | Does |
|---|---|---|---|
| `find` | Ctrl+F | `{text?}` | Asks the shell for its find bar: a `find` tab request. Resolves with `{requestId}`. |
| `find-text` | | `{text, forward = true, matchCase = false, select = true, scroll = true}` | Searches, or moves to the next match of the same text, as `StartFinding`. `select: false` only counts and highlights (`find_match`). Resolves with the result once every frame has answered (at most 5 s). An empty text stops the search. |
| `find-next`, `find-previous` | F3, Ctrl+G; Shift+F3, Ctrl+Shift+G | | Searches again for the tab's text, else the last search anywhere (`GetInitialSearchText`), without opening the bar. With no text at all, opens the bar, as Chrome's F3 does. |
| `stop-find` | | `{action = "clear"}` | `StopFinding` with `"keep"`, `"clear"` or `"activate"` (`SelectionAction`; activate clicks the match, as Ctrl+Enter in Chrome's bar does with a link). Closes the bar. |

**The bar's request.** Kind `find`, detail `{initialText, fromSelection, matchCase}`. `initialText` is the page's selection (trimmed, up to 250 characters, as in Chrome), else the tab's current or last search, else the last search in the profile. The request stays open while the bar is, so `pending.find` means "this tab's find bar is open". The bar answers `{action}` (or `null`, which is `"keep"`) as it closes, and the search stops with that action; an agent may answer it too. Ctrl+F with the bar open cancels the request and asks again, so the bar opens again with focus. The bar takes the keyboard, as Chrome's does. A shown tab is an inner `WebContents` of the shell page, and the page can't take the keyboard from it (focusing its field only moves the focus within the page; `WebContents::Focus()` on the shell doesn't either). So when the tab had it, `find` moves it to the page with the tab's `SurfaceEmbedConnector::ClearFocusOnInnerWebContents()`, where the bar's field has the page's focus, and gives it back with `FocusInnerWebContents()` if no shell takes the request. A new page (`NavigationEntryCommitted` to a different document) stops the search and closes the bar, as Chrome's does.

**Fallback.** None: Chrome's bar needs a `BrowserView`. With no shell to take the request (`findBar: false` and no listener), Ctrl+F does nothing, as before. If the shell that took it goes away, the search stops and its highlights are cleared.

**State.** Every result is the tab's `find`: `{text, matchCase, matches, activeMatch, rect?: {x, y, width, height}, final}`, removed when the search stops. `rect` is the active match in the tab's view, in DIPs, as Blink reports it: where the match was when it was found, before the page scrolled to it (a match below the fold has a `y` past the view's height), and for a match in an out-of-process frame, relative to that frame's local root. So it says which way the match lies more than where it ends up. Shells see `tab.find` and `tabstatechange`; agents see `state.find` in `list_tabs`.

**Shell library.**
- `shell.openFind(tabId, text?)`, `shell.find(tabId, text, {forward, matchCase, select, scroll})` (resolves with the result), `shell.stopFind(tabId, action)`.
- A `findresult` event `{tabId, ...find}` for each new result, besides `tabstatechange`.
- The find bar (`drawFindBar`, option `findBar`): a `.plutonium-dialog.plutonium-find-bar` popover at the top right of the tab's element. It follows the element, and hides while the page doesn't show the tab. A text field, the count (`2/7`; red with no matches, `--plutonium-find-none`), match case (`Aa`), previous and next. Enter and Shift+Enter, F3, Ctrl+G and Ctrl+Shift+G move between matches; Escape closes and keeps the match selected; Ctrl+Enter clicks it. The text it opens with is highlighted and counted without scrolling, and a selection becomes the active match, as in Chrome. Closing gives the tab its focus back. A page that doesn't show the tab doesn't take the request.

**Keys on ChromeOS's top row.** Ash rewrites the top-row function keys of a keyboard it takes for a ChromeOS one into their media keys: F3 becomes refresh (which reloads the tab), unless Search is held. The X11 session's Xvfb keyboard is such a keyboard: there, Search+F3 and Ctrl+G find the next match. Ctrl+G and Ctrl+Shift+G work everywhere.

**Agents.** They read the page (`read_tab`), so the design needed nothing. The commands come with the plumbing anyway, so `find_in_tab {tab_id, text, match_case?, backwards?}` runs `find-text`: it highlights the matches, scrolls to the next, and returns the count. It's for showing the user a place in a page. Kept: the user asked for it (2026-10-24).

## Zoom

**Helpers.** `zoom::ZoomController::CreateForWebContents()` (`components/zoom/zoom_controller.h`), and `zoom::PageZoom::Zoom()` (`components/zoom/page_zoom.h`) for in, out and reset. Levels are saved per host in the profile (`HostZoomMap`, `chrome/browser/ui/zoom/chrome_zoom_level_prefs.h`), as in Chrome. Ctrl+wheel arrives as `WebContentsDelegate::ContentsZoomChange()`, which `BrowserWebContentsDelegate` turns into `IDC_ZOOM_PLUS`/`MINUS`. The tab does the same with `PageZoom`. Chrome's zoom bubble (`ZoomViewController`) is a page action, and we don't use it.

**Shell.**
- `BrowserTabEntry.zoom`: the percent (`ZoomController::GetZoomPercent`), plus `zoomDefault` (true at the default level). Changes come as `tabchanged`, from a `ZoomObserver`.
- `setTabZoom(id, percent)`, and `tabCommand(id, "zoom-in" | "zoom-out" | "zoom-reset")`.
- A shell can show the level in its address bar or as a short toast, and offer a reset. This also gives T3's Browser panel the zoom it lacks (`TABS.md`, "Not done for T3").

**Fallback.** Zoom works without any UI. The library shows a short "110%" toast over the tab's element when the level changes, unless `zoom: false` is passed.

**Agents.** No. They size pages with `Emulation`.

**Not this:** "Page zoom" in `BACKLOG.md`'s design questions is about zooming the shell page around native windows. That is a different thing.

**Size.** S.

**Built** (2026-10-23, `plutonium_zoom.{h,cc}`). As designed, with these details:
- The state is `zoom` (the percent) and `zoomDefault`. A new tab reports them as soon as it is registered.
- The commands are `zoom-in`, `zoom-out`, `zoom-reset` and `zoom-set {percent}` (clamped to 25–500, as Chrome's menu). `setTabZoom(id, percent)` in the library is `zoom-set`, and each command resolves with the new percent.
- Ctrl+plus (Ctrl+= and the keypad's +), Ctrl+minus and Ctrl+0 work once the page lets them through, and so does Ctrl+wheel (`ContentsZoomChange`). A page that takes them for itself keeps them.
- The level is per site and shared by every tab and thread on it, so all of them report the change. It survives a reload.
- The toast shows on the shell page that shows the tab, for any change of level, including going to a site that has its own level. `connect({ zoom: false })` turns it off; a function `(tab) => true` draws its own.
- Verified on X11 (2026-10-23): the commands and their sharing over DevTools, then keys and the wheel as real X input through xdotool. DevTools' `Input.dispatchKeyEvent` can't test the keys: its events skip the browser's handling of keys the page didn't take (`skip_if_unhandled`).
- **Not done:** T3's own zoom controls in its browser panel are still ignored by its bridge (`zoomIn`, `zoomOut`, `resetZoom`, `setZoomFactor` in patch 0012). T3 gets zoom through the keys, the wheel and the toast.

## Permission prompts

**Helpers.**
- `permissions::PermissionRequestManager::CreateForWebContents()` (`components/permissions/permission_request_manager.h`). Without it, requests are denied, as they are today.
- `content_settings::PageSpecificContentSettings::CreateForWebContents()` with a `PageSpecificContentSettingsDelegate` (`chrome/browser/content_settings/page_specific_content_settings_delegate.h`): what the page used or was blocked from.
- Cameras: off a Chromebook, Chrome's capture uses V4L2 as on desktop Linux (`create_video_capture_device_factory.cc`), and audio PulseAudio over the shared runtime dir. `plutonium container create` passes the `/dev/video*` and `/dev/media*` there at the time; a camera plugged in later needs the container made again (`plutonium doctor` checks).
- In the delegate, `RequestMediaAccessPermission()` and `CheckMediaAccessPermission()` call `MediaCaptureDevicesDispatcher` (`chrome/browser/media/webrtc/media_capture_devices_dispatcher.h`), as `BrowserWebContentsDelegate` does. Its `PermissionBubbleMediaAccessHandler` (`permission_bubble_media_access_handler.h`) goes through the request manager. Today the default delegate returns `NOT_SUPPORTED`, so `getUserMedia` fails in tabs.
- `FileSystemAccessPermissionRequestManager::CreateForWebContents()` (`chrome/browser/file_system_access/file_system_access_permission_request_manager.h`): write access for files the page opened. This is a prompt of its own, reported the same way.
- `CanDownload()` in the delegate goes to `DownloadRequestLimiter` (`chrome/browser/download/download_request_limiter.h`). Its "download several files" question is the `automatic-downloads` permission.
- `MediaStreamCaptureIndicator` (`chrome/browser/media/webrtc/media_stream_capture_indicator.h`): which tabs use the camera, microphone or screen right now.

**Hook.** Chrome builds a prompt in `CreatePermissionPrompt()` (`chrome/browser/ui/views/permissions/permission_prompt_factory.cc`, called from `PermissionPrompt::Create` in `components/permissions/permission_prompt_impl.cc`). For a registry tab, it returns a `PlutoniumPermissionPrompt` instead: a `permissions::PermissionPrompt` that asks the shell and answers through the `PermissionPrompt::Delegate` (`Accept`, `AcceptThisTime`, `Deny`, `Dismiss`).

**Shell.**
- `permissionrequest {requestId, tabId, thread, origin, embeddingOrigin, types, devices?}` (cancelable). `types` holds names such as `camera`, `microphone`, `geolocation`, `notifications`, `clipboard-read`, `midi-sysex`, `storage-access`, `automatic-downloads`, `window-management`, `local-fonts`, `idle-detection`, `keyboard-lock` and `file-write`. Several requests can be grouped into one, as Chrome groups camera and microphone.
- `answerPermission(requestId, "allow" | "deny" | "dismiss", { scope: "once" | "thread" | "everywhere" })`.
- `shell.permissions({ thread?, origin? })` lists the decisions Plutonium knows about, and `revokePermission(…)` removes one.
- `BrowserTabEntry.inUse: {camera, microphone, screen, geolocation}` changes through `tabchanged`, so a shell can draw a dot on the tab or the thread. Screen capture from a tab also reaches every shell as `capturestart` (`CAPTURE.md`).
- **Hidden tabs.** The request manager shows nothing while its tab is hidden, and shows the request when the tab becomes visible. A tab no `<embed>` shows is hidden, so a background tab's request waits. `pending.permission` lets the shell mark the tab, and bring it forward if it wants to.

### Grants and threads

Chrome stores decisions per origin, in the profile, and every thread's tabs share the shells' profile. Allowing the camera for meet.example.com in one thread would allow it in all of them. Plutonium's model is that a thread is the unit of reach: agents reach only their thread, and password fills can be allowed "for this thread and site" (`PASSWORDS.md`). So the prompt offers three scopes:

| Scope | Stored by | Lasts |
|---|---|---|
| `once` | Chrome's one-time grant (`AcceptThisTime`) | until the page's origin is closed or navigated away from, as in Chrome |
| `thread` | Plutonium, keyed by (thread, origin, permission) | until revoked, or the thread is archived or deleted |
| `everywhere` | Chrome's content setting (`HostContentSettingsMap`) | until revoked; also shown in `chrome://settings/content` |

- **The thread** is the tab's origin tag (its first tag), which never changes. A tab another thread borrowed (an added tag) keeps its origin thread's grants.
- **Thread grants.** For a thread grant, Chrome's own setting stays "ask". Two hooks make the grant hold:
  - `PlutoniumPermissionPrompt` answers a covered request with `AcceptThisTime` without asking anyone;
  - a check in `PermissionContextBase` (`components/permissions/permission_context_base.h`) reports "granted" for a registry tab whose thread holds the grant, so `navigator.permissions.query()` and `Notification.permission` say so too.
- **Deny** takes the same scopes.
- **Settling.** A thread's grants stay when it is settled, and go when it is archived or deleted.

**Fallback.** If no shell takes the request, it is dismissed (decided). That stores nothing, and the page can ask again. The tab's state records the blocked request (`blocked: [{origin, permission}]`), so a shell can show a badge and ask later. Chrome's bubble isn't used: its anchor lookup goes through `GetBrowser()` in `permission_prompt_factory.cc` and would need a patch, and the library's prompt covers the normal case.

**Agents.**
- `list_tabs` shows `pending.permission`.
- An agent can answer `deny` or `dismiss` (`answer_permission`).
- To grant, an agent asks the user (`request_permission`), through the same prompt, marked as the agent's. Playwright's `Browser.grantPermissions` (`helper/src/serverTabs.ts`, `pages.ts`) becomes such a request and resolves once the user answers.

**Size.** M–L. M in Chromium (the helpers, the prompt, the media delegate methods, indicators), M for thread grants (the store and the `PermissionContextBase` check), S for the library's prompt.

### As built (2026-10-23)

Patches "tabs' permission prompts ask the shell" and "per-thread permission grants" (`plutonium_permissions.{h,cc}`), with the library and helper parts here. It differs from the design above in these ways:

- **The request** is the plumbing's tab request of kind `permission`, not a `permissionrequest` event. Its detail is `{origin, embeddingOrigin, thread, types, scopes, by?, files?, directory?}`. `scopes` lists only the scopes that hold for these types, in this order: `thread` (not for automatic downloads or file access), `once` (only if Chrome has one-time grants for every type), `everywhere`. `by: "agent"` marks an agent's request. The answer is `{answer: "allow" | "deny" | "dismiss", scope}`, or just the answer (`shell.answerPermission(requestId, answer, {scope})`). Without a scope, allow takes `thread` (else the first scope) and deny takes `once`.
  - allow once: `AcceptThisTime`. Chrome's one-time grant covers the origin in every tab, across threads, while the origin stays open. That is Chrome's own behaviour.
  - allow or deny everywhere: `Accept` or `Deny`, Chrome's content setting.
  - deny once, or dismiss: `Dismiss`, which stores nothing.
  - allow or deny for the thread: the decision is stored for the thread, and the request is dismissed. `PermissionContextBase` reports the thread's decision as the request's result, and the embargo counts are reset, so it doesn't count as a dismissal.
- **Agents.** An agent can deny or dismiss, never allow (`on_answer` refuses it).
- **File access.** The File System Access write prompt (`ShowFileSystemAccessPermissionDialog`) is the same kind of request, with types `file-write` or `file-read`, `files` (the names), and only the `once` scope. The restore-permissions bubble isn't hooked.
- **Hidden tabs.** `PermissionRequestManager::set_prompt_while_hidden()` (a small patch to the component) lets a tab no `<embed>` shows ask anyway. Its shell and agents then see `pending.permission`. The library takes the request and draws it when the shell shows the tab.
- **Fallback.** The request is dismissed and recorded as `blocked: [{origin, permission}]` on the tab. This also happens if the shell that took it goes away. The record clears when the page navigates to another document, or when a later request for the same origin and permission is answered.
- **`inUse: {camera, microphone, screen}`** is in the tab's state while it captures (`MediaStreamCaptureIndicator`). Geolocation in use isn't reported.
- **Thread grants** live in local state (`plutonium.thread_permissions`: thread → origin → permission → allow or block), so they are browser-wide, not per profile. `PermissionContextBase::SetThreadDecisionCallback()` is checked where Chrome's own setting says "ask", for frames of that thread's tabs only, so `navigator.permissions.query()` agrees. Requests the thread covers resolve without a prompt. Unlike the design, the prompt doesn't auto-answer with `AcceptThisTime`: that grant would reach other threads.
- **Asking again, and agents granting.** The tab command `permission-request {permissions, origin?, by?}` asks the user through the same prompt, with the scopes `thread` and `everywhere`. It resolves once answered with `{answer, scope}`, or with `{answer: "allow", scope: "thread", asked: false}` if the thread already allows them all.
  - The library calls it as `shell.requestPermission(tabId, permissions, {origin})`.
  - The helper adds `by: "agent"` to an agent's call. Agents call it with the `request_permission` tool.
  - Playwright's `Browser.grantPermissions` in the thread relay (`pages.ts`) maps DevTools' names (`videoCapture` → `camera`, ...) and asks over a tab of the thread (one at that origin if there is one). It returns once the user allows, and fails if they don't. Playwright sends the command again after a failure, so a refusal is remembered for 5 s rather than asked twice.
  - `Browser.resetPermissions` is acknowledged and does nothing: the thread's grants are the user's.
  - The frontend server's relay (`serverTabs.ts`) asks the same way, over the server's tab itself (`ServerTabs.onRequestPermissions`, the tab command with `by: "agent"`), with the same 5 s memory of a refusal. A hidden page (a recording's encoder) can't ask, so its `grantPermissions` fails. Before 2026-10-27 that relay acknowledged it without asking.
- **Listing and revoking.**
  - The tab commands `permissions` (the tab's thread's decisions, plus Chrome's own for its origin) and `permission-revoke {scope, origin?, permission?}` replace `shell.permissions()` and `revokePermission()`. In the library they are `shell.tabPermissions(tabId)` and `shell.revokePermission(tabId, {...})`.
  - For any thread: the broker's new `permissionCommand("list" | "revoke", argsJson)` (`WindowBroker.RunPermissionCommand`), as `shell.threadPermissions({thread?, origin?})` and `shell.revokeThreadPermissions(thread, {origin?, permission?})`.
  - **Archive and delete:** the browser doesn't know about threads' lifecycles, so a shell calls `shell.forgetThreadPermissions(thread)` when it archives or deletes a thread. The plain shell can't delete threads.
  - **T3 Code** (T3 patch 0037) forgets on every `thread.archived` and `thread.deleted` event, whoever archived it (the user or an agent): its server calls the helper's `POST /v1/threads/<tag>/permissions/forget`. Only a shell page's broker can revoke, so the helper sends the bridge op `forget_thread_permissions` to a shell page, which calls `forgetThreadPermissions`. With no page connected it answers `{queued: true}`, and the next page to connect does it. A settled thread keeps its grants.
- **The library's prompt** is a popover at the top left of the tab's element. It has the site, the list of permissions, the scopes (this thread first, with the thread's label), Block, Allow and × (not now; Escape too). It ignores clicks for its first 400 ms. `connect({permissions: false})` leaves requests to the fallback, and a function draws them itself.

**Verified** on an X11 session in slot 23, with a test page on 127.0.0.1 and `--use-fake-device-for-media-stream`.

| Check | Result |
|---|---|
| Notifications: the library's prompt over the tab, Allow (default "In this thread") | `granted`. `permissions.query` says `granted`. Chrome's own setting unchanged (`tabPermissions` lists only the thread's) |
| The same origin in another thread | `prompt` |
| Camera and microphone, Allow "Only this time" | stream with 2 tracks. `inUse {camera, microphone}` |
| An agent's `allow` (POST `.../request`) | refused. The request stays open |
| `answer_permission` dismiss | the page gets `default`. The shell's prompt closes |
| `answer_permission` deny everywhere, on a tab the shell doesn't show | `pending.permission` while waiting (taken, not drawn). Then `denied` |
| `connect({permissions: false})` | dismissed. `blocked: [{origin, permission: "notifications"}]`, cleared by a reload |
| `request_permission` for notifications and geolocation | prompt marked `by: "agent"`. After allow (thread), the tool returns `{answer: "allow", scope: "thread"}` and both are `granted` in that thread only |
| Playwright `context.grantPermissions(["camera", "microphone"])` | asks once. Refused: throws "The user didn't allow camera, microphone". Allowed (thread): resolves, and `getUserMedia` works without a prompt |
| Deny for the thread | `getUserMedia` fails with `NotAllowedError` with no prompt |
| Restarting Ash | thread grants still hold |
| `forgetThreadPermissions(thread)` | `{revoked: 4}`. That thread goes back to `prompt`, the other keeps its grant |
| `revokePermission(tabId, {permission})` | `{revoked: 1}`. Back to `prompt` |

## File pickers

**Helpers.**
- In the delegate, `RunFileChooser()` and `EnumerateDirectory()` call `FileSelectHelper` (`chrome/browser/file_select_helper.h`), as `BrowserWebContentsDelegate` does. Today the default delegate cancels every `<input type=file>`.
- `FileSelectHelper` opens a `ui::SelectFileDialog` with a `ChromeSelectFilePolicy(web_contents)` (`chrome/browser/ui/select_file_policy/chrome_select_file_policy.h`). So do the File System Access pickers (`content/browser/file_system_access/file_system_chooser.cc`, `showOpenFilePicker`, `showSaveFilePicker`, `showDirectoryPicker`) and a download's Save As (`chrome/browser/download/download_file_picker.cc`).

**Hook.** Ash sets the dialog factory to `SelectFileDialogExtensionFactory` (the Files app; `chrome/browser/ui/ash/main_extra_parts/chrome_browser_main_extra_parts_ash.cc`). In shell mode a `PlutoniumSelectFileDialogFactory` wraps it (`ui/shell_dialogs/select_file_dialog_factory.h`). When the policy's source `WebContents` is a registry tab, it returns a dialog that asks the shell. Otherwise it returns the Files app's dialog. `ChromeSelectFilePolicy` needs a getter for its `source_contents_`. Every picker a tab can open goes through this one hook.

**Shell.** Tabs and native apps send the same request:

```
filechooserrequest {
  requestId,
  source: {tabId, origin} | {appId, pid, windowId},
  thread,
  mode: "open" | "open-multiple" | "folder" | "save",
  title, acceptLabel,
  filters: [{name, patterns, mimeTypes}], currentFilter,
  currentName, currentFolder,
  choices?            // the portal's extra choices, such as an encoding
}
```

- The shell answers with `answerFileChooser(requestId, { paths, filter?, choices? })`, or `null` to cancel.
- The library's picker lists the host's files through the helper, which runs as the user (`GET /v1/files?dir=`, recent files, the XDG user folders). It also offers the thread's own places: a T3 thread's project folder, and the thread's downloads.
- A shell can restyle the picker or replace it (`fileChooser: (request) => true`).

### One picker with the FileChooser portal

"Our own portal backend for the rest" (`BACKLOG.md`) has the helper implement `org.freedesktop.impl.portal.FileChooser` (`OpenFile`, `SaveFile`, `SaveFiles`) next to the capture interfaces, in the same `plutonium.portal` and `plutonium-portals.conf`.

1. A native app's request comes with a parent window handle. The helper maps it to the Exo window, and so to the thread. This is the same mapping the capture picker needs.
2. The helper sends the same `filechooserrequest` to the focused shell, with `source: {appId, pid, windowId}`. The shell can open the picker over the parent's element (see "Where do dialogs go?" in `BACKLOG.md`).
3. The answer's paths go back to the portal as URIs. For sandboxed apps, xdg-desktop-portal's frontend exports them through the document portal itself.

So a tab and a native app show one picker with the same places and the same recent files, as capture's picker serves both.

**Built** (2026-10-26; `helper/src/fileChooser.ts`, `portal.ts`, the library). These details differ from the design or fill it in:
- **The request** goes over the shell relay as `file_chooser` to the focused shell, not as a `filechooserrequest` event: `{handle, detail, source: {appId, pid, windowId, name, parent}, thread}`. `detail` is a tab's fileChooser detail: `mode` is `open`, `open-multiple` (`multiple`), `folder` (`directory`, and `SaveFiles`) or `save`, with `title`, `filters`, `currentFilter`, `currentName` and `currentFolder` (from `current_name`, `current_folder` and `current_file`), plus `acceptLabel` (mnemonic underscores dropped) and `choices` (`[{id, label, options: [{id, label}], value}]`; no options is a checkbox, "true"/"false"). The answer is the tab's, `{paths, filter?}`, plus `choices: {id: value}`, or null.
- **Filters.** Globs are kept, GTK's case-blind spelling (`*.[pP][nN][gG]`) as `*.png`; MIME types become their globs from shared-mime-info (`mime/globs2` in the XDG data dirs; `image/*` is every image type). A filter none of whose types is known shows every file. A `current_filter` not in the list is added to it, as GTK does.
- **The parent window.** The handle (`x11:<xid>`, `wayland:<xdg-foreign handle>`) names nothing Exo knows, so the helper takes the app's windows by the request's pid (else its app id): the focused one, else the newest. The library's picker opens over that window's `<native-window>` (`shell.shownWindowElement()`), else in the middle of the page, and takes the keyboard from the app while it's open (as the color picker does).
- **The library.** The `fileChooser` option covers apps too: false refuses them (the app gets an error), a function gets the request with `source` instead of `tabId` and answers through `request.answer()`. The picker's header names the app; the choices are a select or a checkbox each in the footer.
- **The answer** is file:// URIs (`SaveFiles`: the chosen folder joined with each of the app's names; nothing asks before overwriting those, as with GTK's backend), with the choices, the chosen filter (`current_filter`) and, for `OpenFile`, `writable`. For sandboxed apps, xdg-desktop-portal's frontend puts them in the document portal itself.
- **Cancelling.** The app going away (or `Request.Close`) closes the picker (`file_chooser_cancel` to every shell); a shell going away cancels the request (response 2). Without a shell there's no picker: response 2.
- **Verified** on X11 (slot 5, xdg-desktop-portal 1.20.4 on `tools/portal-bus.sh`'s bus; build 113d99ec5ee9's series):
  - zenity 4.2.2 (GTK 4, `GDK_DEBUG=portals`): `--multiple` with two filters (both files back), `--save` over an existing file (the picker's Replace, then the path), `--directory`; killing zenity while asked closed the picker;
  - gtk4-print-editor (GTK 4): Open and Save As from its window, the picker over that window, the saved file written;
  - Firefox (`widget.use-xdg-desktop-portal.file-picker` 1): Ctrl+O, its six filters, the picker over its window, the file opened in a tab;
  - `tools/portal-filechooser.py`: the accept label, a select and a checkbox (answered `latin1` and `true`), a MIME filter (`text/markdown` listed `.md` files) and the chosen filter back; `save-files x.png y.png` into a chosen folder;
  - Chromium 147.0.7727.137 (Wayland; it uses the portal by default, as Electron does): Ctrl+O, the picker over its window, the file opened;
  - a tab's `<input type=file multiple>` still opens the picker over the tab and gets the file.
  - Not tried: a Flatpak app (the document portal on a private bus would mount over the user's), an Electron app itself, and DRM.

### Paths in the container

(Built: the container mounts the user's home at the same path; see "Built" below.) The answer is a host path, but Ash in the container didn't see the user's home. Its `$HOME` is `$DATA_DIR/container-home` (`bin/plutonium`, `container create`), and only the checkout, `$DATA_DIR` and the runtime dir are shared. `HOST=1` sessions have no such problem. The target is Ash outside the container. Until then, container sessions mount the user's home at the same path (decided). The three ways considered:

- **Mount the user's folders** (the XDG user dirs, or all of `$HOME`) into the container at the same path. This is the simplest way, and the container already keeps paths the same inside and out.
- **The document portal.** The helper adds each chosen file to it (`org.freedesktop.portal.Documents.AddFull`), and Ash reads `$XDG_RUNTIME_DIR/doc/<id>/<name>`. The runtime dir is shared, but the FUSE mount has to reach the container. To check: whether podman's bind of the runtime dir carries it.
- **Staging.** The helper copies the chosen files under the runtime dir. Saving and folders make this awkward.

**Fallback.** The Files app's dialog (`SelectFileDialogExtension`). In a container session it only shows the profile's own My files, and whether it shows at all in shell mode is to check. If it can't open, the request is cancelled, as today. For the portal, if no shell takes the request, the helper can forward it to the GTK backend (`org.freedesktop.impl.portal.desktop.gtk`). Its dialog is an Exo window that a shell then has to show.

**Agents.**
- Playwright's file chooser handling (`Page.setInterceptFileChooserDialog`, `Page.fileChooserOpened`, `DOM.setFileInputFiles`) runs in content before the delegate. An agent driving a tab that way never opens the user's picker.
- For the helper's own tab tools, `choose_files {paths}` answers a pending chooser in the agent's thread.
- The paths must be visible to Ash (above). An agent already runs as the user and can read the files anyway, so this adds no reach.
- A native app an agent launched asks the user's shell like any other app.

**Size.** L overall:
- M in Chromium: the factory, the dialog, the delegate methods;
- M–L for the library's picker and the helper's file listing;
- S–M for the container paths;
- M for the portal interface, on top of the portal backend item.

**Built** (2026-10-23, the patch "Plutonium: file pickers for tabs ask the shell", `plutonium_file_chooser.{h,cc}`; `helper/src/files.ts`; the library's picker; the agent tool `choose_files`). Tabs only at first; native apps since, through the FileChooser portal (above). These details differ from the design or fill it in:
- The request is the plumbing's tab request, kind `fileChooser`, not a separate `filechooserrequest`. Its detail is `{mode, upload, title, origin, filters: [{name, patterns}], currentFilter, currentName, currentFolder, defaultExtension}`. `mode` is `open`, `open-multiple`, `folder` or `save`, and `upload` is true for `<input webkitdirectory>`. `currentName` is only set for `save`. The answer is `{paths, filter?}`, where `filter` is an index into `filters`, or `null` (or no paths) to cancel. A save answer with no extension gets `defaultExtension`. An answer with several paths for a single-path mode, or with a path that is relative or has `..`, is refused, so the request stays open.
- `PlutoniumSelectFileDialogFactory` wraps the Files app's factory in shell mode (`chrome_browser_main_extra_parts_ash.cc`). It knows the tab from `ChromeSelectFilePolicy::GetSourceContents()`, a new static getter. It returns null for a policy that isn't a `ChromeSelectFilePolicy`, and the policies are kept in a set because there's no RTTI to tell them apart. Every picker a registry tab opens goes through it: inputs, `showOpenFilePicker`/`showSaveFilePicker`/`showDirectoryPicker`, and a download's Save As. Chrome's own checks still run after the answer, such as "Upload 5 files?" for a folder upload and the File System Access blocklist.
- `Tab::RunFileChooser()` and `EnumerateDirectory()` call `FileSelectHelper`. In shell mode, `FileSelectHelper` doesn't cancel a registry tab's picker when the tab's window gets too small (`WebContentsBasedCanceller`'s window-size guard), because a shell that reloads drops the tab's embed. A hidden tab's picker is still cancelled before it gets anywhere (`WebContentsImpl::RunFileChooser`), as in Chrome. So an agent's tab has to be shown to open a picker, and agents that drive pages with Playwright intercept the picker anyway. The user is fine with that (2026-10-24).
- **Folder uploads** (patch "a folder upload the shell confirmed skips Chrome's dialog"). Chrome asks "Upload N files to this site?" after a folder is picked for `<input webkitdirectory>`. When a shell or an agent answered the request, that was the confirmation, and `FileSelectHelper` skips Chrome's tab-modal dialog for that folder (`PlutoniumTakeFolderUploadConfirmed()`). The library's picker asks itself: the first Upload counts the folder's files (`GET /v1/files/count?dir=`, as Chrome counts them) and shows "Upload N files from “X” to <site>?"; a second Upload sends it. A shell drawing its own picker should ask too. Behind the Files app's picker (the fallback), Chrome's dialog still shows.
- **Fallback.** If no shell takes the request, or the shell that took it goes away (a reload), the Files app's dialog opens over the shell. Verified on X11: it shows and works, and cancelling it cancels the page's input.
- **The library's picker** (`fileChooser` option; `false` leaves the request to the fallback, and a function draws your own). It's a `.plutonium-dialog.plutonium-file-chooser` popover over the tab's element (`shownTabElement()`). Places are on the left: Recent (from `recently-used.xbel`), Home, the XDG user dirs that exist, `/`, and the shell's own `filePlaces` (an array of `{name, path}`, or `(request) => array`, such as a thread's project folder). The folder's files are listed on the right with sizes and dates, folders first, filtered by the page's filter. There is an editable path field (`~` works) and an Up button, a Hidden files toggle, New folder (save and folder modes), a name field for save, and a filter select. Keys: arrows move the selection, typing jumps to a name, Shift and Ctrl select several in `open-multiple`, Enter opens a folder or accepts, Backspace goes up, and Escape cancels. When saving over a file that exists, the button asks again with "Replace".
- **The helper** (it runs as the user): `GET /v1/files?dir=<abs>[&hidden=1]` gives `{dir, parent, entries: [{name, path, kind, size, modified, hidden}]}`. `GET /v1/files/places` gives `{places, recent}`. `POST /v1/files/folder {path}` makes a folder. Errors are 400, 403, 404 or 409 with a message. Unit tests are in `helper/test/files.test.ts`.
- **Agents.** `choose_files {tab_id, paths}` answers `pending.fileChooser`; empty `paths` cancels. If the shell's picker is open, it closes when the agent answers.
- **Container.** `plutonium container create` mounts `$HOME` at the same path, and the container's `$HOME` env is `$DATA_DIR/container-home` (the directory it used to mount over `$HOME`), so depot_tools' and Chrome's own files stay where they were. An existing container keeps its mounts until it's recreated (`podman rm -f <name>`, then `plutonium container create`).
- Verified on X11 (2026-10-23), with a test page holding `<input>`s for one file (with an accept filter), several files and a folder, plus `showSaveFilePicker`:
  - the shell path: picking with the library's picker, with the filter applied, folder upload through Chrome's confirmation, and saving with the replace confirmation;
  - the agent path: `choose_files` on a multi-file input;
  - the fallback with no shell taking the request (`fileChooser: false`): the Files app's picker;
  - the fallback when the shell reloads with a picker open: the Files app's picker opens (before the window-size fix, the page got a cancel), and closing it cancels the input;
  - the container's home mount: an agent answer with a path under the real `$HOME`, which the old container couldn't see, reaches the page with its contents.

## Downloads

**Status: built** (2026-10-23), patch "Plutonium: downloads for the shells' tabs", with the library, helper and plain shell parts in this repo. Tested on X11 in a container session (below).

**Helpers.**
- The download manager is the profile's (`ChromeDownloadManagerDelegate`), so tabs' downloads already happened. Its UI on ChromeOS is `DownloadNotificationManager` (Ash notifications), which shell mode doesn't show. Nothing is attached to the tab: `Tab::AttachHelpers()` only makes `PlutoniumDownloads` observe the tab's profile.
- `CanDownload()` (`DownloadRequestLimiter`) is the permission prompts' business: a page's second automatic download asks the `automatic-downloads` permission.

**As built.**
- `PlutoniumDownloads` (`chrome/browser/plutonium_downloads.{h,cc}`) is a `DownloadManager::Observer` and `DownloadItem::Observer`. At `OnDownloadCreated` it reads the tab from `DownloadItemUtils::GetWebContents()` and keeps the tab's id and its thread (the origin tag; for an untagged link a shell opened, its first tag). Both stay after the tab closes. It lists only this session's downloads: Chrome's history (earlier runs) isn't listed, nor transient ones.
- **The empty tab.** When the tab's first navigation became the download (`IsInitialNavigation()`, Chrome's own test in `DownloadUIController`), the tab closes. Not an agent's tab (its automation holds the page) or DevTools'.
- **Where files go.** `DownloadTargetDeterminer::DoGenerateTargetPath()` asks `PlutoniumDownloads::FolderFor()` in shell mode, for downloads that don't prompt (Save As keeps Chrome's prompt, which goes to the file picker). The folder is created if needed. If it can't be written, `DownloadPathReservationTracker` falls back to Chrome's own folder and prompts (from the code; not tried).
- **Dangerous files** wait as Chrome's do: the download stays in progress with `danger` set (Chrome's danger type name) until `keep` (`ValidateDangerousDownload`, or `ValidateInsecureDownload` for an insecure one) or `discard` (`Remove`). Only Chrome's local file-type checks apply (no Safe Browsing keys).
- **Open and show** go to the helper (`POST /v1/downloads/open {path, thread, show}` on its socket, through `plutonium_helper`, set up in `ChromeBrowserMainExtraPartsAsh`). It runs `xdg-open` on the file, or for show on its folder, with the thread's environment, so the app opens in the thread and links in it come back as the thread's tabs. Not `FileManager1.ShowItems`: D-Bus would start the file manager outside the session's display and outside the thread. Chrome's own `OpenDownload()` (auto-open of a file type) isn't routed: shell mode doesn't offer it.

**Shell.**
- `navigator.windowBroker`: `downloadadded`, `downloadchanged`, `downloadremoved` (`BrowserDownloadEvent {downloadId, download}`), to every shell; listening replays the current ones as `downloadadded`. A download is `{id, tabId, thread, url, filename, path, mime, receivedBytes, totalBytes, state: "in-progress" | "paused" | "complete" | "cancelled" | "interrupted", danger?, error?, canResume, startTime}`.
- `downloadCommand(id, "pause" | "resume" | "cancel" | "open" | "show" | "keep" | "discard" | "remove")` rejects with the reason it can't. `remove` takes it off the list; the file stays.
- `setDownloadFolder(tag, folder)`, below.
- The library: `shell.downloads({thread?})`, `shell.downloadCommand(id, command)`, `shell.setDownloadFolder(thread, folder)`, `shell.showDownloads({thread?, anchor?})` (the list), and the same three events on the shell with `{download, previous}`.

### Downloads in a thread

Every download records its thread, so a shell can list a thread's downloads with the thread. The file goes to `~/Downloads` (the XDG download folder) by default; the per-thread folders are options (decided, Decision 6):

- `setDownloadFolder(tag, folder)` sets thread `tag`'s folder, or with tag `""` the default for every thread this shell owns (its groups) that has no folder of its own. `folder` is `"downloads"` (`~/Downloads`), `"thread"` (`~/Downloads/<thread label>/`, the group's label, or the tag, with `/` and other unsafe characters replaced), an absolute path (`~/` is the home folder), or `""` to clear it.
- A thread's own folder wins, from whichever shell set it. Then its owning shell's default. A download with no thread, or from a thread no shell owns, goes to `~/Downloads`.
- The settings live in the browser until it restarts. A shell sets them on connecting: `connect({downloadFolder: "thread"})` sets this shell's default. T3 can give a thread `<project>/.downloads` with `setDownloadFolder(thread, …)`.
- Agents' tabs carry the thread's tag, so their downloads follow the same setting.

The doc's earlier plan had the helper move each file into place after it completed. With Decision 5 (container sessions see the home at the same path), Chrome writes it there directly, and its paths stay true.

**Fallback.** The library shows a toast over the tab when a download starts and when it finishes or fails, at the top of the page if the tab closed (the empty-tab case). Clicking the toast opens the list. A dangerous file opens the list. The list (`.plutonium-dialog.plutonium-downloads`, a light-dismiss popover) shows progress and each download's actions. It closes with ×, Escape, a click outside it, or the keyboard going to an app or a tab (a click into a tab never reaches the shell page, so the popover's own light dismiss missed those); `showDownloads()` again from the same anchor closes it, so a Downloads button toggles it. `connect({downloads: false})` turns the toasts off. A function `(download, type) => boolean` returns true for what it shows itself. The plain shell has a Downloads button for the current thread's. With no library, files land silently, as before.

**Agents.**
- `list_downloads`: the thread's downloads (its own, and those of tabs now in the thread) with their paths (`GET /v1/threads/<t>/downloads`).
- `download_action {download_id, action}`: pause, resume, cancel, open, show, discard, remove (`POST /v1/threads/<t>/downloads/<id>/<action>`). Open and show are the helper's own. Not `keep`: a dangerous file is the user's decision. The browser refuses it from `Plutonium.downloadCommand` too (not tried: the helper refuses it first).
- The Plutonium domain has `getDownloads`, `downloadCommand` and `downloadAdded`, `downloadChanged`, `downloadRemoved` (JSON strings, as above).
- **Playwright's download events** (2026-10-27; `helper/src/relayDownloads.ts`). Both relays (the agents' `pages.ts`, the frontend server's `serverTabs.ts`) still only take note of `Browser.setDownloadBehavior`: the file goes where the user's would. With `eventsEnabled` and `allow` or `allowAndName`, a download that starts afterwards from one of the connection's pages gets `Browser.downloadWillBegin {frameId: <the page's target id>, guid, url, suggestedFilename}` once the browser knows the name, then `Browser.downloadProgress` (`inProgress`, then `completed`, or `canceled` for cancelled and interrupted), made from `Plutonium.downloadAdded/Changed`. Before `completed`, `<downloadPath>/<guid>` becomes a symlink to the file, so `waitForEvent("download")`, `download.path()` and `saveAs()` work, and `download.delete()` or Playwright's clean-up only remove the link. `Browser.cancelDownload {guid}` cancels it in the browser. Not covered: a download whose link opened a new tab (it has the new tab's id, which isn't the connection's page), downloads that began before the connection, and `deny` (the user's downloads aren't refused; no events).

**Verified** (X11, container session, slot 24):

| | |
|---|---|
| A link download in a thread's tab: `downloadadded`, then `downloadchanged` up to `complete`, with `tabId`, `thread` and `path` | ✓ |
| Default folder: `~/Downloads/report.txt`, the next one `report (1).txt` | ✓ |
| A `target=_blank` link that is a download: the new tab closes, and the download keeps that tab's id and the opener's thread | ✓ |
| Thread folder `"thread"` without a group: `~/Downloads/plain_thread_dltest/`; with a path: `~/proj/.downloads/` | ✓ |
| The shell's default `"thread"`: a thread it owns goes to `~/Downloads/Thread 1/`, a thread it doesn't own to `~/Downloads` | ✓ |
| pause, resume, cancel and remove on a slow download; `open` before it finished and `keep` on a safe file are refused with the reason | ✓ |
| `open` and `show` through the helper: `xdg-open` in the thread (the file opened in a terminal editor window tagged with the thread) | ✓ |
| Agents: `list_downloads` only lists the thread's downloads; another thread's id is "no download"; `remove` works; `keep` is refused | ✓ |
| An agent's tab (`open_tab` on a download URL) downloads into the thread's folder and stays open | ✓ |
| The library's list and toast | ✓ |
| A dangerous file's keep and discard | not tried (no file type here that Chrome's local checks flag on a user gesture) |
| Playwright through the agents' relay (2026-10-27, X11 slot 15): `waitForEvent("download")` on a link click gives the suggested name and URL; `download.path()` reads the file through the link; `saveAs()` copies it; `cancel()` on a slow one cancels it in the browser (`failure()` "canceled"). The server's relay: unit tests (`test/serverTabs.test.ts`) | ✓ |

**Container paths.** When this was tested, the container's `$HOME` was `$DATA_DIR/container-home`, so `~/Downloads` wasn't the host's and the helper couldn't open those files. The open and show test used a folder under `$DATA_DIR`. The same-path home mount (Decision 5, built with file pickers) fixes this in a recreated container; open and show on `~/Downloads` there is still to check by hand. `HOST=1` never had the problem.

**Size.** M, as estimated.

## Printing

**Status: built (2026-10-24), see "As built" at the end of this section.** The design below is kept as it was; where it differs, "As built" holds.

**Helpers.**
- `printing::InitializePrintingForWebContents()` (`chrome/browser/printing/printing_init.cc`) creates `PrintViewManager` (`chrome/browser/printing/print_view_manager.h`), and `PrintCompositeClient` (`components/printing/browser/print_composite_client.h`) for pages with out-of-process frames.
- Chrome's preview is `PrintPreviewDialogController` (`print_preview_dialog_controller.cc`). It is a tab-modal web dialog that needs a `WebContentsModalDialogHost`, found through `FindBrowserWithTab()` or the `WebContentsModalDialogManager`'s delegate.
- On a `target_os = "chromeos"` build, its printers come from Ash's CUPS printer manager, which expects ChromeOS's own printing service. Probably only "Save as PDF" works there (to check).

**Hook.** `PrintViewManager::PrintPreview()` and `ShowScriptedPrintPreview()` (`print_view_manager.cc`; Ctrl+P and `window.print()`). For a registry tab they send a request to the shell instead of opening Chrome's preview. `window.print()` blocks the page's script until the request is answered.

**Shell.**
- `printrequest {requestId, tabId, thread, title, url, hasSelection, scripted}` (cancelable).
- `shell.printToPdf(tabId, { pageRanges, landscape, scale, margins, paper, background, headerFooter, selectionOnly }) → Blob`. This uses `PrintViewManagerBase::PrintToPdf()` and `print_to_pdf::PdfPrintJob` (`components/printing/browser/print_to_pdf/pdf_print_job.h`), as DevTools' `Page.printToPDF` does. The shell calls it again whenever a setting changes, and shows the PDF as its preview.
- `shell.printers()` lists the host's printers, through the helper (CUPS on the host, over IPP or `lpstat`).
- `shell.print(requestId, pdf, { printer, copies, duplex, color })`: the helper sends the job to host CUPS. "Save as PDF" uses the file picker in `save` mode.
- `answerPrint(requestId, "done" | "cancel")` lets `window.print()` return.

**The Print portal** (`org.freedesktop.impl.portal.Print`, part of "Our own portal backend for the rest") uses the same dialog for native apps. `PreparePrint` shows the dialog without a preview and returns the settings, and `Print` hands the helper the document, which it sends to CUPS. So tabs and apps get one print dialog, as they get one file picker.

**Built** (2026-10-26; `helper/src/printPortal.ts`, `printportal.py`, the library's `PrintDialog`):
- **Its own process.** `Print` passes the document as a Unix fd, and Node can't receive fds. So `printportal.py` (plain Python, a small D-Bus client that negotiates fds) serves `org.freedesktop.impl.portal.Print` as `org.freedesktop.impl.portal.desktop.plutonium.print` (`helper/portal/plutonium-print.portal`; `plutonium-portals.conf` picks `plutonium-print` for Print). The helper starts it with the portal backend. Each call goes to the helper as a JSON line on its stdout, with Print's document copied to a file of its own under `$XDG_RUNTIME_DIR/plutonium/`, which the helper reads and removes. The answer comes back on stdin.
- **PreparePrint** asks the focused shell (`print_prepare` over the shell relay: `{handle, detail: {title, printer, copies, landscape, paper}, source: {appId, pid, windowId, name, parent}, thread}`, the starting values from the app's settings and page setup). The library's dialog has no preview, Scale, Margins, Headers or Background graphics, since the app lays out its own pages. It opens over the app's window (found as the file picker finds it) and takes the keyboard from the app. Its answer, `{printer, path, copies, duplex, color, paper, landscape, pageRanges}` (printer "" for Save as PDF), or null, becomes GTK's settings (`printer` "Print to File" with `output-uri` for a PDF; `n-copies`, `duplex`, `use-color`, `orientation`, `paper-format`, `print-pages` and zero-based `page-ranges`), a page setup (the paper in mm, quarter-inch margins), and a token. The `print` option covers apps too: false refuses them; a function gets the request with `source` and answers through `request.answer()`.
- **Print** takes the token's choice (or asks, without one): `lp` to the printer with two-sided and colour, but not the copies, since GTK puts them in the document; or the PDF written to the chosen path (`~/` works; an existing file gets " (1)").
- **Cancelling.** The app's `Request.Close` closes the dialog (`print_cancel`).
- **Verified** on X11 (slot 5, xdg-desktop-portal 1.20.4 on `tools/portal-bus.sh`'s bus), with gtk4-print-editor (`GDK_DEBUG=portals`): Print showed the dialog without a preview, named the app, and started from the app's own paper the second time; Save as PDF on A4 wrote a one-page A4 PDF with the text; landscape with two copies wrote two landscape A4 pages; Cancel cancelled, and the app carried on. A tab's print dialog is unchanged (preview, all fields). Not verified: a real printer (no CUPS client on this host), Qt apps, Flatpak apps.

**Fallback.**
- Chrome's print preview, as a dialog over the shell's window. The tab gets a `web_modal::WebContentsModalDialogManager` whose delegate gives the shell's widget as the host (`HasWebContentsModalDialogHost()` in `print_preview_dialog_controller.cc`).
- If the preview can't offer real printers (above), it still saves PDFs.

**Agents.** `Page.printToPDF` already works through Playwright (`page.pdf()`), so nothing is needed for PDFs. Agents may print to a physical printer too (`print_tab`), with no approval: an agent with a shell can already run `lp`.

**Size.** M–L:
- M in Chromium (the helpers, the hook, `printToPdf`, the modal dialog host for the fallback);
- M for the library's dialog and preview;
- S–M for the helper's CUPS side;
- M for the Print portal, later.

### As built

The patch "Plutonium: printing in tabs goes to the shell" (`plutonium_print.{h,cc}`), with the library, helper and agent parts in this repo.

**Chromium.**
- `Tab::AttachHelpers()` calls `plutonium_print::AttachHelpers()`. It attaches printing (`InitializePrintingForWebContents`), and a `WebContentsModalDialogManager` whose delegate hosts dialogs in the window of the shell that would be asked about the tab (`ShellDialogHost`). A tab no `<embed>` shows is hidden, so its dialog waits until one does.
- **Hook.** `PrintViewManager::SetPreviewOverride()` (a small patch to `print_view_manager.{h,cc}`). Where `PrintViewManager` would open Chrome's preview, for a user's print (`OnRequestPrintPreviewCallback`) or the page's `window.print()` (`OnScriptedPrintPreviewCallback`), it asks the override first. For a registry tab, the override starts a tab request of kind `print`, with detail `{title, url, thread, hasSelection, scripted, pdf}`. There's no `printrequest` event of its own: it's `tabrequest` with `kind: "print"`.
- **Answers.** `"done"` or `"cancel"`, from the shell or an agent (Decision 8). Either one ends the preview: the page gets `afterprint`, and `window.print()` returns.
- **A renderer can't print while it is in a print preview:** it stops answering, and was later killed. So the request's first `print-to-pdf` ends the preview in the renderer at once: `window.print()` returns then, while the request stays open until it is answered. A page that waits for `window.print()` to return before changing itself back still prints as it looked.
- **Fallback.** No shell takes it: Chrome's print preview opens over the shell's window (pinned to the top of it, as Chrome's tab-modal dialogs are). If the shell that took it goes away, printing is cancelled, and `window.print()` returns. `print-to-pdf` refuses while Chrome's preview is open.
- **Commands.**
  - `print`: Ctrl+P, and the shells' and agents' own buttons. It starts printing the way Chrome's Print command does, and resolves `true` if it started (`false` while a print is already open).
  - `print-to-pdf`: takes `Page.printToPDF`'s options, in inches (`landscape`, `displayHeaderFooter`, `printBackground`, `scale`, `paperWidth`, `paperHeight`, `marginTop` … `marginRight`, `pageRanges`, `headerTemplate`, `footerTemplate`, `preferCSSPageSize`), and returns `{data: <base64 PDF>}`. While a request is open, it prints the frame that asked. It goes through `PrintViewManagerBase::PrintToPdf()` and `PdfPrintJob`. "Selection only" isn't offered: that path DCHECKs on it.
- **Context menu.** A tab's menu keeps Print (`Keeps()`). `RenderViewContextMenu::IsPrintPreviewEnabled()` enables it for a page with no browser window in shell mode.

**Library** (`plutonium-shell.js`, at its end).
- `registerTabRequestKind("print", {option: "print"})`. `connect({print: false})` leaves printing to Chrome's preview; `print: (request) => true` draws it yourself.
- `shell.printToPdf(tabId, {paper, landscape, scale, margins, background, headerFooter, pageRanges}) → Blob`. `paper` is one of `PAPER_SIZES` (letter, legal, tabloid, a3, a4, a5); `margins` is default, none or minimum; `scale` 1 is 100%.
- `shell.printers(title?) → {available, printers: [{name, description, state, isDefault}], error?, defaultPdfPath}`.
- `shell.printPdf(pdf, {printer, copies, duplex: "none" | "long-edge" | "short-edge", color, title}) → {job}`.
- `shell.savePdf(pdf, {path, title, overwrite}) → {path}`. Without `overwrite` it doesn't replace a file: the name gets " (1)", " (2)" and so on.
- **Save as PDF through the file picker** (2026-10-27). The dialog has no path field. Its button reads "Save…" and opens the library's file picker (`FileChooser`, `save` mode, titled "Save as PDF", a PDF filter) over the tab, as the dialog is, starting in the folder the last PDF went to (else `~/Downloads`, the helper's `defaultPdfPath`) with `<title>.pdf`. The picker asks before replacing a file, so the save then overwrites (`overwrite: true`). Cancelling the picker goes back to the print dialog. The Print portal's dialog for apps does the same, and answers the chosen path (not tried with an app). Closing the print dialog (the page or app went away) closes its picker. Agents' `print_tab {save_to}` is unchanged.
- **The dialog**, over the tab's element: the PDF as its preview (Chrome's PDF viewer, in an iframe, re-made 300 ms after a setting changes), the page count, and the destination (the host's printers, or Save as PDF). Then pages (all or ranges), copies, layout, paper (Letter for en-US and similar locales, else A4), margins, scale, two-sided, colour, headers and footers, and background graphics. Escape or Cancel answers `"cancel"`. After printing or saving it answers `"done"`, and shows a toast ("Sent to …", "Saved …").

**Helper** (`src/printing.ts`). It uses the host's CUPS client tools, `lpstat -l -p -d` and `lp`, so the user's default printer and server (`~/.cups/client.conf`, `$CUPS_SERVER`) apply.
- `GET /v1/printers?title=`.
- `POST /v1/print?printer&copies&duplex&color&title`, with a PDF body.
- `POST /v1/print/save?path&title&overwrite`, with a PDF body. The helper writes the file, so it works in containers made before the same-path home mount.

**Agents.**
- `list_printers`.
- `print_tab {tab_id, printer?, save_to?, copies?, duplex?, color?, paper?, landscape?, scale?, margins?, background?, header_footer?, page_ranges?}`: `POST /v1/threads/<t>/tabs/<id>/print`. No approval (Decision 8). If the tab has a print waiting (`pending.print`), it answers it `"done"`, so the shell's dialog closes and `window.print()` returns.
- `cancel_print`: answers it `"cancel"`.
- T3 Code's agents get them too (T3 patch 0036): see "In T3 Code" in `AGENT_CONTROL.md`.

**Not built.** Printer options beyond copies, two-sided and colour (trays, quality, a printer's own paper sizes).

**Verified** on Xvfb (slot 26, the plain shell, a local test page), 2026-10-23/24, with stand-ins for `lpstat` and `lp` (this machine has no CUPS):

| | |
|---|---|
| `window.print()`: the library's dialog with the preview (4 pages, Letter), the two printers, the default selected; the tab's `pending.print` with its detail | ✓ |
| Landscape re-renders the preview (5 pages); Print with 2 copies: `lp -d Office -n 2 -o sides=one-sided -o print-color-mode=color -t "Print test page"`, a 5-page landscape PDF; the page logs `before [beforeprint] [afterprint] after` | ✓ |
| `tabCommand(id, "print")`, then Save as PDF to a path: a 4-page PDF written by the helper | ✓ |
| A real Ctrl+P (xdotool) in the tab opens the dialog; Cancel closes it, `pending` is empty, the page answers again | ✓ |
| The tab's context menu: Back, Forward, Reload, Print…; Print… opens the dialog | ✓ |
| `connect({print: false})`: Chrome's preview over the shell's window, with its own preview and Save as PDF; its Cancel (a real click) closes it, and `window.print()` returns | ✓ |
| `print-to-pdf` while Chrome's preview is open: refused | ✓ |
| An agent (`POST …/print`, A4, pages 1-2, 3 copies, short edge) while the shell's dialog was open: the job sent, a 2-page A4 PDF; the request answered, the dialog closed | ✓ |
| MCP `list_printers`, `print_tab {save_to, landscape}` (a 5-page landscape PDF), `cancel_print` on a waiting `window.print()` | ✓ |
| `npm test`-style `test/printing.test.ts`: lpstat parsing, lp arguments, saving without overwriting | ✓ |
| Save as PDF through the picker (2026-10-27, X11 slot 15, the plain shell, `window.print()`): "Save…" opens the picker over the dialog ("Save as PDF", the title as the name with its stem selected, the PDF filter, `~/Downloads`); its Cancel goes back to the dialog; Save in another folder writes the PDF; the next print starts in that folder, asks "already exists", and Replace overwrites it | ✓ |

**For a person to check:**
- A real printer through CUPS: the job prints, and two-sided and black-and-white take effect.
- Chrome's own preview on this ChromeOS build offers only Save as PDF ("Local printer not available").
- On DRM. On X11, real input to Chrome's preview sometimes waited for the next X event, as `CHROME_UI.md` notes for context menus.

## Form autofill

Addresses and payment cards. Passwords are not part of this (`PASSWORDS.md`), so `ChromePasswordManagerClient` is not attached.

**Helpers.**
- `AutofillClientProvider::CreateClientForWebContents()` (`chrome/browser/ui/autofill/autofill_client_provider.h`) creates `ChromeAutofillClient` (`chrome/browser/ui/autofill/chrome_autofill_client.h`) and its `ContentAutofillDriverFactory`.
- The suggestion popup is a views popup (`chrome/browser/ui/views/autofill/popup/`) parented to the tab's widget, so it may already show in the shell's window.
- Save and update prompts go through `autofill::BubbleManager` and page actions, which need a `TabInterface` (`tab_features.cc`). They won't work.

**Shell (later).** `autofillrequest {requestId, tabId, field, suggestions: [{id, label, sublabel, icon}]}`, answered with `answerAutofill(requestId, suggestionId)`. Chrome then fills the form itself (`AutofillSuggestionDelegate::DidAcceptSuggestion`). As with passwords, the shell sees only labels: a card shows as "•••• 1234" and its number never reaches the shell.

**Fallback.** Chrome's popup. Saving new addresses and cards would need its own UI.

**Agents.** No.

**Without Chrome's autofill.** There is no sync, so whatever Chrome's autofill stores stays local. Bitwarden and 1Password already keep identities and cards. The password adapter could fill them in the same way it fills logins. Decided: not now, and later through the adapter.

**Size.** S–M for Chrome's popup alone, L for a shell-drawn popup and saving.

## Suggested order

1. **The common plumbing, and zoom.** S–M. Zoom is the smallest feature, so it proves the request and state plumbing, the keys and the library options. It also gives T3 its zoom.
2. **File pickers for tabs.** L. Uploads fail on every site today. This includes the library's picker, the helper's file listing, and the container paths.
3. **Permission prompts.** M–L. Camera and microphone (video calls), notifications, clipboard. Thread grants can follow as their own step.
4. **Downloads.** M. Files already land; this adds the UI, threads, open and show.
5. **Find in page.** S–M.
6. **Printing.** M–L.
7. **The FileChooser and Print portals** on the same picker and dialog, with "Our own portal backend for the rest". Both are built (2026-10-26).
8. **Form autofill.** Only if it's wanted (below).

## Not covered here

- **Web notifications** (`Notification`). The permission is above, but showing them needs a notification UI. Shell mode has no Ash notifications. The shell (and the Notification portal for apps) should draw them, as a separate item.
- Translate, Cast, picture-in-picture windows, "Save page as" beyond the picker, and Chrome's site settings UI.
- Fullscreen requests from tabs already work (patch 0011).

## Decisions (2026-10-23)

**No fake restrictions on agents.** An agent with shell access can already print, read files and run programs. Limits that only the browser enforces, and that an agent can get around through its shell, are not added. A limit is kept only where it holds: a browser permission, or a secret the agent never sees.

1. **Permission scopes:** once, this thread and everywhere, all three. The default button is "this thread". "Everywhere" stays, for sites the user trusts (video calls).
2. **The permission fallback:** dismiss, and record the request as blocked on the tab so a shell can show it and ask again. No Chrome bubble.
3. **Agents and permissions:** an agent can deny or dismiss. To grant, it asks the user, through the same prompt a page's request uses, marked as the agent's. `Browser.grantPermissions` becomes such a request in the agent's thread, and resolves once the user answers.
4. **Grants and settling:** a thread's grants stay when it is settled, because settling is easy to undo. They go when the thread is archived or deleted.
5. **Paths:** the target is Ash outside the container (`HOST=1`), where host paths just work. Until then, container sessions mount the user's home at the same path, so the features can be built and tested there. The document portal and staging copies are not built.
6. **Downloads:** one `~/Downloads` by default, with the thread kept as metadata. Options, per shell or per thread: a `.downloads` folder in the thread's working directory, or `~/Downloads/<thread>/`. Agent downloads follow the same setting.
7. **Zoom:** Chrome's per-site zoom, shared by every thread.
8. **Printing by agents:** allowed, with no approval, like any other print job (see above).
9. **Form autofill:** not built for now. Identities and cards come later through the password adapter (`PASSWORDS.md`).
10. **Several monitors:** a request from a tab no shell is showing goes to the focused shell.
