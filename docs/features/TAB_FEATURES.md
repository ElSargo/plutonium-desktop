# Browser features for tabs

**Status: the common plumbing is built ("As built: adding a feature"); the features are designs.** The tasks are in `BACKLOG.md`, "Browser features for tabs".

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

**Helpers.** `FindBarState::ConfigureWebContents()` (`chrome/browser/ui/find_bar/find_bar_state.cc`) creates `find_in_page::FindTabHelper` (`components/find_in_page/find_tab_helper.h`). `StartFinding()` and `StopFinding()` drive it, and results arrive through `FindResultObserver::OnFindResultAvailable()` (`components/find_in_page/find_result_observer.h`, from `WebContentsObserver::DidReceiveFindReply`). Chrome's find bar is `FindBarController` with a views `FindBarHost` in the `BrowserView`, and we don't use it.

**Shell.**
- `findrequest {requestId, tabId, initialText}` (cancelable), from Ctrl+F or `tabCommand(id, "find")`. `initialText` is the selection, or the last search (`GetInitialSearchText`).
- `shell.find(tabId, text, { forward, matchCase })`: starting a new search or moving to the next match is the same call, as in `StartFinding`.
- `shell.stopFind(tabId, "keep" | "clear" | "activate")`, matching `SelectionAction`. Activate clicks the match, as Enter in Chrome's bar does with a link.
- `findresult {tabId, matches, activeMatch, rect, final}`, from `FindNotificationDetails`. The rect lets a shell draw its own marker beside the tab, or scroll its layout to it.
- F3, Ctrl+G and Ctrl+Shift+G call `find` with the last text when no bar is open.

**Fallback.** The shell library's find bar: a small popover at the top right of the tab's element, with a text field, a count, next and previous, match case, and Escape to close. A shell with `findBar: false` and no library gets nothing, as today: Chrome's bar needs a `BrowserView`.

**Agents.** No need. They read the page (`read_tab`).

**Size.** S–M. S in Chromium (the helper, keys, two broker calls and an event), S for the library's bar.

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

## Permission prompts

**Helpers.**
- `permissions::PermissionRequestManager::CreateForWebContents()` (`components/permissions/permission_request_manager.h`). Without it, requests are denied, as they are today.
- `content_settings::PageSpecificContentSettings::CreateForWebContents()` with a `PageSpecificContentSettingsDelegate` (`chrome/browser/content_settings/page_specific_content_settings_delegate.h`): what the page used or was blocked from.
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

So a tab and a native app show one picker with the same places and the same recent files, as capture's picker serves both. When the portal backend doesn't exist yet, only tabs use the picker.

### Paths in the container

The answer is a host path, but Ash in the container doesn't see the user's home. Its `$HOME` is `$DATA_DIR/container-home` (`bin/plutonium`, `container create`), and only the checkout, `$DATA_DIR` and the runtime dir are shared. `HOST=1` sessions have no such problem. The target is Ash outside the container. Until then, container sessions mount the user's home at the same path (decided). The three ways considered:

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

## Downloads

**Helpers.**
- The download manager is the profile's (`ChromeDownloadManagerDelegate`, `chrome/browser/download/chrome_download_manager_delegate.h`), so downloads from tabs already happen. They land in the profile's download folder, and nothing shows them.
- On ChromeOS the download UI is `DownloadNotificationManager` (`chrome/browser/download/notification/download_notification_manager.h`, chosen in `download_ui_controller.cc`). It shows Ash notifications, and shell mode has none.
- `CanDownload()` in the delegate goes to `DownloadRequestLimiter` (see Permissions).
- A link opened in a new tab that turns out to be a download leaves an empty tab. `DownloadUIController` closes such a tab only when it is in a `Browser`'s tab strip. The registry should close it itself when the tab's first navigation becomes a download.

**Hook.**
- A `content::DownloadManager::Observer` and `download::DownloadItem::Observer` in the browser (`plutonium_downloads.{h,cc}`).
- At `OnDownloadCreated` it reads the tab from `content::DownloadItemUtils::GetWebContents()` and keeps its thread (the origin tag). The tab may be closed later.
- `ChromeDownloadManagerDelegate::OpenDownload()` and `ShowDownloadInShell()` call `platform_util`, which opens the Files app on ChromeOS. For Plutonium they go to the helper instead.
- A dangerous file's confirmation (`RequestConfirmation`) becomes a state of the download (below). Safe Browsing has no Google API keys here, so only Chrome's local file-type checks apply.

**Shell.**
- `downloadadded`, `downloadchanged` and `downloadremoved`, sent to every shell. Subscribing replays the current ones, as tabs do. Each carries `{id, tabId, thread, url, filename, path, mime, receivedBytes, totalBytes, state: "in-progress" | "paused" | "complete" | "cancelled" | "interrupted", danger?}`.
- `shell.downloads({ thread? })`.
- `downloadCommand(id, "pause" | "resume" | "cancel" | "open" | "show" | "keep" | "discard" | "remove")`:
  - `open` and `show` go to the helper, which opens the file in the download's thread: its `xdg-open`, with the thread's environment (`OPENING_LINKS.md`). Show uses `org.freedesktop.FileManager1.ShowItems`.
  - `keep` and `discard` answer a dangerous file's confirmation.
- Save As (Chrome's "ask where to save" setting, or "Save link as") opens the file picker in `save` mode.

### Downloads in a thread

Every download records its thread, so a shell can list a thread's downloads with the thread (T3's sidebar, the plain shell's thread view). The file goes to `~/Downloads` by default; the per-thread folders are options (decided):

- **One folder for everything** (`~/Downloads`, the user's choice), with the thread kept only as metadata. This is what users expect from a browser.
- **A folder per thread** (`~/Downloads/<thread label>/`), or a T3 thread's project folder. This keeps a thread's files together, and an agent can find them.

Either way, in a container session Chrome writes inside the profile under `$DATA_DIR`, which the host can see. When the download completes, the helper moves the file to its folder (normally on the same filesystem, so it's a rename). The alternative is mounting the folder into the container (see "Paths in the container" above).

**Fallback.** The library shows its own download list and a toast when a download starts and finishes. With `downloads: false` and no library, files land silently, as today.

**Agents.**
- `list_downloads` shows the thread's downloads with their paths.
- `download_action` takes the same commands, except `keep` on a dangerous file, which is the user's decision.
- Playwright's download events need `Browser.setDownloadBehavior` with events, and the helper's relays only acknowledge it today. The relay could pass on `Browser.downloadWillBegin` and `downloadProgress` for its own tab's frames, so `waitForEvent("download")` works.

**Size.** M: M in Chromium (the observer, the thread, the delegate overrides, the empty-tab close), S in the helper (moving, opening, showing), S for the library's list.

## Printing

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

**Fallback.**
- Chrome's print preview, as a dialog over the shell's window. The tab gets a `web_modal::WebContentsModalDialogManager` whose delegate gives the shell's widget as the host (`HasWebContentsModalDialogHost()` in `print_preview_dialog_controller.cc`).
- If the preview can't offer real printers (above), it still saves PDFs.

**Agents.** `Page.printToPDF` already works through Playwright (`page.pdf()`), so nothing is needed for PDFs. Agents may print to a physical printer too (`print_tab`), with no approval: an agent with a shell can already run `lp`.

**Size.** M–L:
- M in Chromium (the helpers, the hook, `printToPdf`, the modal dialog host for the fallback);
- M for the library's dialog and preview;
- S–M for the helper's CUPS side;
- M for the Print portal, later.

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
7. **The FileChooser and Print portals** on the same picker and dialog, with "Our own portal backend for the rest".
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
