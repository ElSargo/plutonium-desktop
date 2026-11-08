# Chrome extensions in tabs

**Status: design, nothing built yet** (2026-11-08). The goals:
- ordinary Chrome extensions work in the shells' tabs: content blockers (uBlock Origin Lite, and uBlock Origin if we keep Manifest V2 alive), password managers' extensions, Dark Reader, Vimium, user-script managers;
- what an extension shows (its toolbar button, badge, popup, permission prompts, keyboard commands) the shell shows, through the shell library, as it shows tabs' other browser features ([TAB_FEATURES.md](TAB_FEATURES.md));
- the browser part is one place in Chromium that makes the registry's tabs real tabs to the extensions system, so the APIs work unchanged;
- [SITE_EXTENSIONS.md](SITE_EXTENSIONS.md) runs on it: its v2 is one extension of ours, instead of a Chromium registry of its own.

## Today

- **Extensions load.** The build has the extensions system (it's Chrome on Ash); `tools/ime-test.sh` loads an unpacked one with `--load-extension` and drives it.
- **The registry's tabs aren't tabs to it.** A tab is a `WebContents` the registry owns, with the helpers TAB_FEATURES.md attaches (`Tab::AttachHelpers()` in `plutonium_tabs.cc`): zoom, find, permissions, downloads, printing. It has no `SessionTabHelper` (so no tab id), no extensions `TabHelper`, and no `Browser`. `ExtensionTabUtil::GetTabById()` and `tabs.query` look through `WindowControllerList`, which only has `Browser` windows, so an extension can't find, query or target a registry tab.
- **Nothing shows an extension's UI.** Toolbar buttons, popups and install prompts are views in a `Browser` window, and shell mode has none.

### What works today (checked 2026-11-08)

X11 session in slot 51, plain shell, build `out/Cros` of 2026-11-07, with uBlock Origin Lite 2026.1103.1743, Dark Reader 4.9.135 (MV3) and a probe extension (`tools/extension-probe/`: a manifest content script, and a page that calls the APIs that go by tab) loaded with `--load-extension`. Tabs were opened with `windowBroker.createTab` and driven with `plutonium cdp`.

| | Registry tab | Notes |
|---|---|---|
| Content scripts from the manifest | ✅ every frame, at document start | |
| `userScripts.register` | ✅ | The API is undefined until "Allow user scripts" is on for the extension (`developerPrivate.updateExtensionConfiguration({ userScriptsAccess: true })` from `chrome://extensions`) |
| `declarativeNetRequest`, dynamic rules | ✅ a blocked page shows `ERR_BLOCKED_BY_CLIENT`; blocked `fetch`es fail | |
| uBlock Origin Lite's blocking | ✅ six rulesets on, four content scripts registered; Google Tag Manager blocked | `adsbygoogle.js` loaded in a real Chrome tab as well: that's uBOL's default mode, not us |
| `chrome-extension://` pages in a registry tab | ✅ uBOL's dashboard, the probe page, and `chrome://extensions` all open with `createTab` | |
| `sender.tab` for a content script's messages | ❌ `undefined` | So any extension whose background answers "which tab is this" breaks |
| `tabs.query`, `tabs.get`, `windows.getAll` | ❌ registry tabs aren't listed | Listed: the shell page (a tab in an `app` window), and real Chrome windows |
| `scripting.executeScript`, `insertCSS`, `userScripts.execute`, `tabs.sendMessage` | ❌ no tab id to target | All work on a real Chrome tab |
| Dark Reader | ❌ in a registry tab; ✅ in a real Chrome tab (the same page went dark, 9 stylesheets) | Its content scripts run, but its background needs `sender.tab` |
| `tabs.create`, `windows.create`, an extension's "welcome" page on install | ⚠️ open a real Chrome window, which shell mode never shows | Dark Reader's help page opened this way at install |
| Toolbar button, popup, `commands` | ❌ nothing shows them | As expected |
| Extension items in the context menu | not checked | Needs a real right click in a shown tab |

### Extensions reach the shell page (security)

**The shell page is an ordinary page to extensions.** It's a tab in an `app` window, so it is listed by `tabs.query`, gets every `<all_urls>` content script (uBOL's, Dark Reader's), and accepts `scripting.executeScript`. A script the probe ran there, in the isolated world and in the page's own, called `navigator.windowBroker.getTabs()` and got every tab back. The broker is exposed in every world of a shell document. So any extension with access to all sites has the whole window broker: every window and tab, input to them, and the shell's tab automation. That's far more than a page or an extension should have, and true today for anyone who loads an extension.

**Fixed** on branch `shell-ext-guard` (patch 0014, and a fix-up to 0004), not merged yet. Checked 2026-11-08 on X11 slot 51 with the same three extensions: no content script in the shell page; `tabs.query`, `windows.getAll` and `tabs.get` on every nearby id no longer find the shell (it was also reachable by id through Chrome's search warm-up prerender inside the shell page); `executeScript` on its id fails with "Cannot access a Plutonium shell page."; `navigator.windowBroker` is null in an isolated world and present in the page's own; dynamic `declarativeNetRequest` rules block `example.org` and Google Tag Manager from a registry tab but not from the shell page, nor the shell's requests to its helper. Content scripts, uBlock Origin Lite's blocking and Dark Reader in a real Chrome tab work as before.

The fix, as designed: shell documents aren't scriptable by extensions, as the Web Store and `chrome://` pages aren't. `PermissionsData::IsRestrictedUrl()` (or the `ExtensionsClient` hook behind it) refuses a document the browser marked as a shell (`IsShellDocument()`, the same signal the broker uses), so no content script, `executeScript` or `debugger` reaches it, and `webRequest`/`declarativeNetRequest` don't see the shell's own requests. The window broker should also be bound to the main world only, as defense in depth.

## What full extensions give us

Over SITE_EXTENSIONS.md's v1 (scripts put in over DevTools):
- **Network rules.** `declarativeNetRequest` blocks, redirects and edits headers before a request is made. A content script can only hide what already loaded. This is what ad blocking, "strip tracking parameters" and "never load this script" need.
- **Proven injection.** Document-start timing in every frame, user-origin stylesheets (`scripting.insertCSS` with `cssOrigin: "user"`), and a CSP for the script's world (`userScripts.configureWorld`), all without a Chromium patch of ours.
- **The ecosystem.** Thousands of extensions, a format every agent knows, and an extension written here runs in any Chrome, and mostly in Firefox.
- **Other APIs** where a shell or a site wants them: context menu items, `commands`, `cookies`, `downloads`, a service worker that runs with no tab open.

What they cost: a tab-shaped surface for the APIs that go by tab and window (below), the UI, and following Chromium's extension churn (Manifest V2's removal is the current one).

## Tabs and windows for the extension APIs

One Chromium change, in `plutonium_tabs.cc` and `chrome/browser/extensions/`:
- **Tab ids.** `Tab::AttachHelpers()` attaches `SessionTabHelper` and the extensions `TabHelper` (with `ActiveTabPermissionGranter` and the script-executor), as `TabHelpers::AttachTabHelpers()` does for a `Browser`'s tabs.
- **A window per shell, on upstream's interfaces.** Upstream is moving the extensions code off `Browser` and onto three interfaces, so it can run where there's no `Browser` (desktop Android): `BrowserWindowInterface` (22 methods), `TabListInterface` (about 38: open, close, activate, move, groups, splits) and `TabInterface` (27). `TabsEventRouter` already listens through `TabListInterfaceObserver`, and `ExtensionTabUtil` reaches tabs through `TabListInterface::From(browser)`. Each shell gets a `BrowserWindowInterface` whose tab list is its registry tabs, each a `TabInterface`, registered with a `WindowController` in `WindowControllerList`. Its window id is stable for the session. Groups, splits, pinning and moving between windows are refused (`IsThisTabListEditable` and per-call errors).
- **The risk** is code that turns a `BrowserWindowInterface` back into a `Browser` (`GetBrowserForMigrationOnly()`) or expects a views window behind it. Each such place that an extension API reaches has to be found and given a branch, and Chromium rebases can add new ones.
- **Active and focused.** A tab is `active` while a shell shows it, and `highlighted` while it has the keyboard; `windows.getLastFocused` is the visible shell. These are what popups use to find "this tab".
- **Creating, moving, closing.** `tabs.create` opens a registry tab in the thread of the tab or popup that asked (its tag), as a page's `window.open` does. `tabs.update`, `reload`, `remove`, `goBack` map to the registry. `windows.create` opens tabs, not windows (a popup type window is a tab the shell is asked to float). `tabs.move` between windows and tab groups are refused with a clear error.
- **Thread tags** are exposed to nothing: an extension sees the shell's tabs as one window's, as today a page can't tell which thread it's in.

## The UI, through the shell

As TAB_FEATURES.md's features are: the browser raises it, the shell library gives it a shape, and each shell draws it.

| | Browser | Shell library (`shell.extensions`) |
|---|---|---|
| Toolbar buttons | Each extension's action: icon, title, badge text and colour, per tab, from `ExtensionActionManager` | `list()`, `on("change")`, `click(id, tabId)`. Hydra puts pinned ones in the browser panel's toolbar; the rest in a menu |
| Popups | `action.openPopup` and a click open the popup page as a registry tab marked `openedBy: "extension-popup"`, sized by the page | A popover the library ships, anchored to the button; closed by Escape or a click outside, which closes the tab |
| Install and permission prompts | `ExtensionInstallPrompt` and the permissions request go to the shell as a tab request (kind `extensionPrompt`), as permission prompts do | A dialog with the extension, its permissions, and Allow or Cancel |
| `commands` | An extension's keys | Actions in KEYS.md's catalogue (`extension.<id>.<command>`), so they're rebindable and listed; a command's default key without Super is the tab's, as any page key |
| Errors and management | `chrome://extensions` | Opened as a tab; `plutonium extensions` lists, enables, disables and removes from a terminal |

## Installing

- **From a folder or a `.crx`/`.zip`:** `plutonium extensions install <path>`, and dropping one on the shell's extension menu. Kept as an unpacked extension under `~/.pluto/extensions/<id>/`, loaded at every start (the helper passes `--load-extension`, or loads it over DevTools once the session is up).
- **From the Chrome Web Store:** its page in a tab, with Chrome's install flow sending its prompt to the shell (above). Updates come from the store as in Chrome.
- **Agents:** an agent can install an unpacked extension it wrote, like any other file it writes. Loading it asks you, through the same prompt (the prompt is the browser's, answered by real input).

## uBlock Origin

- **uBlock Origin Lite** (Manifest V3, `declarativeNetRequest`) is the path that lasts. Its blocking should work from step 1; its popup, per-site modes and counts need tab ids and the popup.
- **uBlock Origin** (Manifest V2, `webRequestBlocking`) blocks better: cosmetic filters, scriptlets, dynamic filtering, filters that need to see the response. In this Chromium (158), MV2 code is still there, and an MV2 extension is turned off by `ManifestV2Handler::ShouldBlockExtensionEnable()`. A patch that keeps that false would run it, installed from uBlock's own release (the Web Store no longer has it). But upstream is removing MV2 code a piece at a time, so each rebase may cost more, until a piece we can't keep goes. Worth doing while it's cheap, with Lite as the fallback.
- Policy: `webRequestBlocking` is still allowed for MV3 extensions installed by policy (`_permission_features.json`). That helps extensions we write ourselves (SITE_EXTENSIONS.md could use it), not uBlock.

## Site extensions on top

SITE_EXTENSIONS.md's v2 becomes one extension of ours, the **sites host**, loaded at every start:
- the helper keeps it in sync with `~/.pluto/sites/` over a native-messaging port or DevTools;
- scripts go in with `userScripts.register` (matches, run-at, all frames) in a world whose CSP has no network (`userScripts.configureWorld`), and into open tabs with `userScripts.execute`;
- styles with `scripting.insertCSS({ cssOrigin: "user" })`, removed with `removeCSS`;
- a site's `block` rules become dynamic `declarativeNetRequest` rules.

So the site-script registry patch SITE_EXTENSIONS.md planned isn't needed. The folder format stays the same: what the agent writes is still a CSS file and a JS module per site, which the host turns into the extension calls.

## The work, in order

1. ~~**Check what works now.**~~ Done 2026-11-08 (What works today, above).
2. **Keep extensions out of shell documents** (security, above). Built and checked on branch `shell-ext-guard` (patch 0014), 2026-11-08; to merge.
3. **Tab ids and the window controller,** with active and focused state; `tabs`, `windows`, `scripting` and `userScripts.execute` on registry tabs.
4. **Actions and popups** in the shell library, and Hydra's toolbar.
5. **Prompts:** install and permissions through the shell; the Web Store's install flow.
6. **`plutonium extensions`** and `~/.pluto/extensions/`; the helper loads them at start.
7. **The sites host extension** (SITE_EXTENSIONS.md, v2).
8. **`commands`** as KEYS.md actions, once its catalogue exists.
9. **MV2 for uBlock Origin,** as a separate small patch, dropped when it stops being small.

## Open questions

1. **Popups as tabs.** A popup is an `ExtensionViewHost` in Chrome, sized by its content and closed on blur. A registry tab in a popover is simpler for us; whether popups that call `window.close()` or read their own size behave is to check in step 3.
2. **Incognito and per-project profiles.** Extensions are per profile. With PROJECTS.md's per-project profiles, are extensions installed once for every profile, or per project?
3. **Native messaging** (password managers' extensions talk to their desktop app): the host manifests are looked up in the usual places; inside the container session they may need the helper's help.
