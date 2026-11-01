# The dock in Hydra

**Status:** design agreed 2026-10-27. Step 1 is T3 patch 0031 and the sidebar's dock 0032 ("Step 1 as built", "The dock in the sidebar", below); sites kept per project or everywhere are 0034 ("Sites in a scope"). Since 2026-11-01 a slot holds one window or tab, not every one that looks like it ("Identity-based slots", patch 0048).

Hydra works well for agents, less well as the desktop you use all day: everything has to be in a thread, nothing is a key away, and there is no clock or tray. The dock is nine slots on Super+1…9, each an app, a site or a group, each in a scope (one thread, the thread's project, or everywhere). With a status cluster at the title bar's right end, it makes Hydra a desktop without changing how its chat works.

## Slots

A slot has:
- **a target:** Hydra's own terminal (the drawer below the chat), an app (a desktop entry), a site (a URL), or a group of apps and sites;
- **a scope:** `thread`, `project` or `global`. The scope decides which copy the key finds: "Super+1 = thread terminal" is thread A's terminal in thread A and thread B's in thread B, started if the thread has none;
- **a layout:** `split` (the chat and the app side by side) or `fold` (the chat folds away);
- **what it holds:** one window or tab in each copy of its scope, the one put in it or the one its key opened, wherever that tab browses ("Identity-based slots", below). An app or a site in a single slot is the recipe for a new one, not a pattern.
- **a rule** (groups, step 3, not built): which tabs belong to it, such as `github.com/<org>/<repo>/*`, so a link followed in it, or a tab an agent opened there, is part of it.

Slots are defined once, with templates (`{project.githubUrl}`, `{project.dir}`, `{thread.worktree}`), so one dock serves every project; a project can override single slots. The default dock has slot 1 as the thread's terminal (Hydra's drawer), which can be changed to any app.

```json
{
  "1": { "scope": "thread",  "terminal": true },
  "2": { "scope": "project", "site": "{project.githubUrl}" },
  "3": { "scope": "thread",  "app": "code", "args": ["{thread.worktree}"], "layout": "fold" },
  "4": { "scope": "project", "group": [{ "site": "{project.githubUrl}/pulls" }, { "match": "localhost:*" }] },
  "5": { "scope": "global",  "group": "rest" }
}
```

## Scopes are tags

Every window and tab has tags: the first is its origin and never changes, shells add and remove others ([ARCHITECTURE.md](../ARCHITECTURE.md)). A scope is a tag:

| Scope | Tag |
|---|---|
| thread | `t3:thread/<id>` (as before) |
| project | `t3:project/<id>` |
| global | `t3:global` |

An app started for a slot runs with its scope's tag as `PLUTONIUM_THREAD_ID`, so its windows carry it. Moving something that's open adds the new scope's tag; the last scope tag T3 added wins over the origin. Single-instance apps (Firefox, Slack) put every window in their first process's tag, which suits them being global.

## Keys

| Key | Command | What |
|---|---|---|
| Super+1…9 | `dock.slot.N` | The slot, in its layout |
| Super+Ctrl+1…9 | `dock.slotOther.N` | The slot, in the other layout this time |
| Super+Shift+1…9 | `dock.assign.N` | Put the focused tab, app or terminal in slot N |
| Super+Up | `dock.toggleLayout` | Split ↔ fold for the slot you're in; the thread remembers it |

Pressing a slot's key:
1. nothing of it in its scope: start it (into the scope's tag, in the right folder);
2. running, not shown: show it and give it the keyboard;
3. shown, keyboard elsewhere: give it the keyboard;
4. shown and focused: back to where you were before (the chat, unfolded, or the panel as it was);

Just after switching threads, step 3 doesn't apply: the switch gave the composer the keyboard, so a slot's thing already showing in the new thread is taken as focused and its key hides it (step 4). Typing or clicking in the thread ends that (patch 0035). Going back (step 4) never shows the slot's own thing again: if it was showing when the slot's key was first pressed, the slot is put away.

A group slot raises its last-used member, and pressing again cycles. Super+Shift+Alt+N (to be decided) opens a fuzzy picker of the group, with its members not open yet and "add the current tab". The `"rest"` group is everything in its scope no other slot claims.

They are all T3 keybinding commands, so `keybindings.json` can change them. They are shell shortcuts too: they reach Hydra while an app or tab has the keyboard. Alt+1…9 stays with apps (Firefox, terminals and editors use it).

## Layouts

- **split:** the panel beside the chat (as today).
- **fold:** the chat column folds away. For a panel app or tab this is the panel's maximize (patch 0010). For the terminal drawer, the conversation hides and the drawer takes the column.
- Folded, the chat leaves a thin strip with the thread's title and the agent's state (working, done, waiting for you); a question from the agent lights it and shows a toast. (Not in step 1.)

## The dock in the sidebar

A row of nine buttons just above the sidebar's settings row, wrapping when the sidebar is narrow (all nine fit at its default width). Each shows the slot's icon (the terminal, the app's own icon, the site's own icon: an open tab's, then the one T3 remembers, then the site's `/favicon.ico`; no third-party icon service) and its number: faint when empty, dimmed when set but nothing of it runs in the thread's scope, normal when running, ringed when it shows. Hovering says the key, what it is, where it's kept and what a click does.

- **Click:** what Super+N does. Clicking the one that shows goes back, or puts it away (panel hidden, drawer closed) when there's nowhere remembered to go back to. The click doesn't take the keyboard.
- **Right click** (or a click on an empty slot): the slot editor, above the dock, each change applied as it's made. It opens a terminal, an app (a searchable list of installed apps) or a site (the address a new tab of it opens at), or takes the panel's tab; a name; where it's kept (this thread, this project, everywhere; the terminal is always the thread's); beside the chat or chat folded, saying when the thread has its own choice from Super+Up; clear.
- **Panel tabs** in the dock show their slot's number.

ChatView publishes the active thread's context (`publishDockContext`) for the sidebar, which is outside it.

## Setting it up

- Right-click a panel tab: **Dock ▸ Super+1…9**, **Dock scope ▸ thread / project / everywhere**, **Remove from dock**.
- Super+Shift+N assigns what has the keyboard.
- The file (`~/.pluto/dock.json`, project overrides) is the source of truth once templates exist (step 2); step 1 keeps the slots in the page's storage.

## Agents

An agent reaches its own thread's and its own project's windows and tabs. Global ones need permission, asked the way passwords are (an Ash prompt, so no agent can answer it): once, for this thread, or always for this app or site. T3's server passes the caller's thread with each forwarded tool call (patch 0017); it would pass the tags the thread may reach, and the helper's check takes a set. T3's `preview_*` tools get the same rule in the server. Grants go with the thread's permissions (`forgetThreadPermissions`).

Until that's built, project- and global-scoped windows are out of every agent's reach (their tag names no thread). A site's tab in a scope carries the tag of the thread showing it, so that thread's agent reaches it, and the thread it was opened in, whose tag is its origin.

## The tray

**Changed 2026-10-30 (patch 0047):** not the sidebar's footer, which hides with the sidebar, but the title bar's right end, the one place that shows whatever else is open (sidebar hidden, panel open or maximized, chat folded, settings).

- **Always shown:** the time; the battery when it isn't on AC (or is low and not charging). An icon only for something wrong: offline, muted. The date is in the button's label and the popover.
- **A click** opens quick settings: the time and date (click: a calendar), volume (the icon mutes; an output picker with several outputs) and brightness, Wi-Fi and Bluetooth (a switch each; open for the networks in range, a password for a new one, wired and VPN connections, or the paired devices), what's playing, the battery's line, and lock, suspend, log out, restart and power off (asked first, as in the plain shell).
- **Room for it:** its width is `--plutonium-status-width` on the document; `--workspace-controls-right` adds it, so the panel and terminal toggles sit left of it, and the chat header, the panel's tab strip and the settings pages' headers reserve it.
- Only in the Plutonium shell (`isPlutoniumShell()`): a remote client or a browser paired to the server doesn't show the host's battery.
- `apps/web/src/plutonium/PlutoniumStatus.tsx` over `systemServices.ts` (`useSystemService`, the shell library's `shell.system.<name>`). Hydra's `shell.json` uses audio, power, media, network, bluetooth and session (version 4).
- Not yet: an OSD for the volume and brightness keys, the StatusNotifier tray, pairing new Bluetooth devices, notifications in the popover.

## Steps

1. Slots for the terminal, apps and sites; run, raise, minimise; split and fold; Super+Shift+N and the tab menu. Sites only in the thread scope (T3's browser tabs are per thread on the server). Sites in project and global scope followed (patch 0034).
2. Templates, `dock.json`, project overrides, an app's folder for project scope (the helper's `/v1/apps/launch` takes a `cwd`).
3. Groups, `"rest"`, the group picker.
4. Agents' reach and the permission prompt.
5. The folded chat's strip.
6. The tray (independent of the rest): the status cluster, patch 0047.

## Step 1 as built (2026-10-27)

- `apps/web/src/plutonium/dock.ts`: the slots (kept in the page's storage, `t3code:plutonium-dock:v1`), finding a slot's windows and tabs, run, raise and go back, assigning and the scope. `panelKeys.ts` handles the keys; ChatView lends the dock the thread's panel and terminal.
- Keybinding commands `dock.slot.N`, `dock.slotOther.N`, `dock.assign.N`, `dock.toggleLayout`; their defaults have `when: "plutoniumShell"`, a new context that is true in the Plutonium shell only, so Cmd+1 on a Mac stays T3 Code's.
- The terminal fold: the drawer takes the chat column (`fill`), the conversation is hidden.
- Fixed on the way: a browser tab's page or an app's window given the keyboard lost it to the composer a frame later, when the shell window's `focus` event followed. `shouldRefocusComposerOnWindowFocus` now leaves `EMBED` and `NATIVE-WINDOW` alone, as it did `IFRAME` and `WEBVIEW`.
- Not yet: the folded chat's strip. (Sites in project or global scope: below.)

Verified on Xvfb (slot 14, its own T3 data, keys as synthetic events in the page, so not through Ash):

| Check | |
|---|---|
| Super+1: the drawer opens with a terminal, which has the keyboard | ✅ |
| Super+Ctrl+1: the conversation folds away, the terminal takes the column | ✅ |
| Super+1 again: drawer closed, unfolded, composer focused | ✅ |
| Super+2 (foot, global): started with `PLUTONIUM_THREAD_ID=t3:global` on the slot's socket, shown split | ✅ |
| Super+2 again: back (panel hidden as before); again: the same foot, no second process | ✅ |
| A new thread, Super+2: the same foot in its panel | ✅ |
| Super+3 (example.com, fold): a new browser tab, chat folded; Super+Up: split, kept for the thread | ✅ |
| Super+3 from a hidden panel: the page has the keyboard (after the fix above); again: back to the tab that showed before | ✅ |
| Super+Shift+4 on the tab: slot 4 is "Example Domain", a site | ✅ |
| Tab menu: "In the dock (Super+3)", the nine slots with 3 checked, "Remove from the dock" | ✅ |
| On DRM, through Ash: Super+N from inside an app, and typing into it after | not yet |

## Sites in a scope (patch 0034, 2026-10-27)

T3's browser tabs belong to one thread on the server, so a site kept per project or everywhere can't be one tab every thread lists. It is one browser tab that moves:
- The slot's tab carries its scope's tag (`t3:project/<id>`, `t3:global`), as an app's windows do. The dock opens it with that tag as its origin; a thread's own tab gets the tag added when its slot's scope changes (the editor or the tab menu's **Keep it**). Super+Shift+N on a tab keeps the scope its tags say.
- Pressing the slot: the scope's tab, if this thread shows it; else it comes here from the thread showing it (that thread's preview tab closes, the browser tab stays, that thread's tag comes off) and is imported as a new preview tab; else a new one opens. The button is "running" while the tab exists anywhere in the scope, "showing" when it shows here.
- Closing its preview tab closes it, wherever it was opened.
- The server opens a tab of its own for each new preview (patch 0017); a tab the page brings from elsewhere (an import, or the dock's) now replaces that one (`showServerTab(..., { replace: true })`, the helper's `ServerTabs.attach`). Before, the helper's blank tab won and the brought tab was closed, so importing from Elsewhere lost the tab too.

Verified on Xvfb (slot 14), through the dock's buttons in the page:

| Check | |
|---|---|
| Editor: a site's **Kept** offers this thread, this project, everywhere, with the scope's hint | ✅ |
| Everywhere, thread A: a `t3:global` tab opens and shows; the helper's own tab closes; the button is "showing" | ✅ |
| A new thread: the button is "running"; pressing it moves the same tab there (A's tag off, the new thread's on), A's panel loses it | ✅ |
| Back in A: the same tab comes back | ✅ |
| Closing it in the panel closes the tab; the button goes idle | ✅ |
| This project, from A's own example.com tabs: they get `t3:project/<id>`; the other thread of the project takes the newest; closing it there closes it | ✅ |
| On DRM, an agent driving a moved tab | not yet |

## Identity-based slots (patch 0048, 2026-11-01)

Before, a slot kept a description and claimed whatever fit it: a site slot every tab whose address started with its prefix (the editor's "Tabs start with", else the site's origin), an app slot every window of the app in its scope, cycling when there were several. Unrelated tabs of the same site joined the slot (the button showed "showing" for them, the tab menu labelled them, presses cycled through them); a docked tab that left the site dropped out, and the next press opened a new one; changing a slot's scope tagged every matching tab; two slots with overlapping prefixes both claimed a tab; and starting an app bound the first new window with the scope's tag, whatever app it was.

Now a slot holds one thing:
- **The slot's tag.** Each slot has a stable id, and what it holds carries `t3:dock/<id>` beside its scope's tag. Putting a tab or a window in a slot (Super+Shift+N, the tab menu, the editor's **Use the panel's tab**) tags exactly that one; what the slot held in the same scope copy loses the tag, and the thing leaves any other slot it was in.
- **Finding it.** A press, the button's state and the panel tab's number all look for what carries the slot's tag and its scope's: the thread's tag (one per thread), the project's or `t3:global` (one, which moves between threads as before). No addresses or app ids are compared.
- **Nothing found:** the press makes one from the slot's recipe and tags it. A site's tab is created with the scope's tag as its origin and the slot's tag, then shown here (a thread's own, too, now goes the way a project's tab does: `createDockTab`, then the import). An app is started in the scope; the window it binds is the first new one of the process started (its pid), or else a new window of the app in the scope, not any new window. A slot set up in the editor with just an address or an app works this way on its first press.
- **Tabs a docked tab opens** (links with `target=_blank`, popups) aren't the slot's. Chromium gives a page's new tab its opener's tags; the preview bridge takes the slot's tag off it when it first shows up, and the lookup ignores a slot tag that the opener carries too, until then.
- **The id changes** when the slot names another app or site (another desktop entry, another host): then what it held anywhere loses the tag. The same site at another address (`github.com/a` to `github.com/a/pulls`), a new name, layout or scope keep it, so what it holds in other threads stays.
- **Changing the scope** retags only what the slot holds here: it gets the new scope's tag, and loses a project's or `t3:global` (a thread's tag stays: the thread shows it, its agent reaches it). Copies in other threads of a slot kept per thread are no longer found.
- **Clearing a slot** (the editor, **Remove from the dock**) takes its tag off everything.
- **Stored slots** (`t3code:plutonium-dock:v1`, version 2) get an id and lose `match`. Nothing carries the new id, so the first press opens a fresh one, or Super+Shift+N binds what's open. Tags live in the browser, so a reload of the page keeps them; after a browser restart the press opens a fresh one.
- **Gone:** the "Tabs start with" field, `siteMatchOf`, `match` on sites, cycling through copies. Groups and their rules (step 3) are still to come.
- **Not done: dialogs following their window.** An app's dialog shown as its own panel tab isn't the slot's, so the button says "running" while it shows, and the key raises the main window (Exo then gives a modal dialog the focus). The shells don't see which window a dialog belongs to: Exo knows the parent (`xdg_toplevel.set_parent`, `xdg_wm_dialog_v1`), but the broker's window entry doesn't carry it. That needs a Chromium patch adding the parent to the entry; then the lookup can count a window's dialogs as part of it.

Verified on Xvfb (slot 35, its own T3 data, a scratch project, two draft threads; clicks and keys as synthetic events in the page, tags read from `navigator.windowBroker`):

| Check | |
|---|---|
| Stored version-1 slots: ids added, `match` dropped, version 2 | ✅ |
| Slot 3 (example.com, per thread): one new tab with the thread's tag and the slot's; button "showing", tab numbered 3 | ✅ |
| A popup from it (`window.open`, same site): only the thread's tag (the slot's came off); button "running" while it shows; no number on it; the key raises the docked tab | ✅ |
| The docked tab goes to iana.org: still slot 3 ("showing", numbered); pressed away and back, the same tab, no new one | ✅ |
| Super+Shift+3 on the popup: it holds slot 3, the iana tab loses the tag (another host: a new id) | ✅ |
| Editor: no "Tabs start with"; **Everywhere**: only the held tab gets `t3:global`, the iana tab nothing | ✅ |
| Another thread: slot 3 "running"; pressed, the same tab moves there; back in the first thread, it left the panel; pressed there, it comes back and the other thread's tag comes off | ✅ |
| Slot 2 (migrated, everywhere, example.com) with a global example.com tab open: opens its own tab, leaves the other alone | ✅ |
| Slot 4 (foot, per thread) with another foot open in the thread: "idle"; pressed, a new foot starts and only its window (matched by pid) gets the slot's tag | ✅ |
| Slot 4 to **This project**: only its window gets `t3:project/<id>`; **Clear** takes the slot's tag off | ✅ |
| Super+Shift+5 on the foot window: slot 5 holds it, kept per project (its tags) | ✅ |
| Reloading the page: the slots find what they held | ✅ |
| On DRM, through Ash; an app's dialogs | not yet |
