# The dock in T3 Code

**Status:** design agreed 2026-10-27. Step 1 is T3 patch 0031 and the sidebar's dock 0032 ("Step 1 as built", "The dock in the sidebar", below).

T3 works well for agents, less well as the desktop you use all day: everything has to be in a thread, nothing is a key away, and there is no clock or tray. The dock is nine slots on Super+1…9, each an app, a site or a group, each in a scope (one thread, the thread's project, or everywhere). With a tray in the sidebar's footer, it makes T3 a desktop without changing how its chat works.

## Slots

A slot has:
- **a target:** T3's own terminal (the drawer below the chat), an app (a desktop entry), a site (a URL), or a group of apps and sites;
- **a scope:** `thread`, `project` or `global`. The scope decides which copy the key finds: "Super+1 = thread terminal" is thread A's terminal in thread A and thread B's in thread B, started if the thread has none;
- **a layout:** `split` (the chat and the app side by side) or `fold` (the chat folds away);
- **a rule** (sites and groups): which tabs belong to it, such as `github.com/<org>/<repo>/*`, so a link followed in it, or a tab an agent opened there, is part of it.

Slots are defined once, with templates (`{project.githubUrl}`, `{project.dir}`, `{thread.worktree}`), so one dock serves every project; a project can override single slots. The default dock has slot 1 as the thread's terminal (T3's drawer), which can be changed to any app.

```json
{
  "1": { "scope": "thread",  "terminal": true },
  "2": { "scope": "project", "site": "{project.githubUrl}", "match": "{project.githubUrl}/*" },
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
5. several copies: pressing again cycles through them.

A group slot raises its last-used member, and pressing again cycles. Super+Shift+Alt+N (to be decided) opens a fuzzy picker of the group, with its members not open yet and "add the current tab". The `"rest"` group is everything in its scope no other slot claims.

They are all T3 keybinding commands, so `keybindings.json` can change them. They are shell shortcuts too: they reach T3 while an app or tab has the keyboard. Alt+1…9 stays with apps (Firefox, terminals and editors use it).

## Layouts

- **split:** the panel beside the chat (as today).
- **fold:** the chat column folds away. For a panel app or tab this is the panel's maximize (patch 0010). For the terminal drawer, the conversation hides and the drawer takes the column.
- Folded, the chat leaves a thin strip with the thread's title and the agent's state (working, done, waiting for you); a question from the agent lights it and shows a toast. (Not in step 1.)

## The dock in the sidebar

A row of nine buttons just above the sidebar's settings row, wrapping when the sidebar is narrow (all nine fit at its default width). Each shows the slot's icon (the terminal, the app's own icon, the site's own icon: an open tab's, then the one T3 remembers, then the site's `/favicon.ico`; no third-party icon service) and its number: faint when empty, dimmed when set but nothing of it runs in the thread's scope, normal when running, ringed when it shows. Hovering says the key, what it is, where it's kept and what a click does.

- **Click:** what Super+N does. Clicking the one that shows goes back, or puts it away (panel hidden, drawer closed) when there's nowhere remembered to go back to. The click doesn't take the keyboard.
- **Right click** (or a click on an empty slot): the slot editor, above the dock, each change applied as it's made. It opens a terminal, an app (a searchable list of installed apps) or a site (an address and the prefix its tabs start with), or takes the panel's tab; a name; where it's kept (this thread, this project, everywhere: apps only); beside the chat or chat folded, saying when the thread has its own choice from Super+Up; clear.
- **Panel tabs** in the dock show their slot's number.

ChatView publishes the active thread's context (`publishDockContext`) for the sidebar, which is outside it.

## Setting it up

- Right-click a panel tab: **Dock ▸ Super+1…9**, **Dock scope ▸ thread / project / everywhere**, **Remove from dock**.
- Super+Shift+N assigns what has the keyboard.
- The file (`~/.pluto/dock.json`, project overrides) is the source of truth once templates exist (step 2); step 1 keeps the slots in the page's storage.

## Agents

An agent reaches its own thread's and its own project's windows and tabs. Global ones need permission, asked the way passwords are (an Ash prompt, so no agent can answer it): once, for this thread, or always for this app or site. T3's server passes the caller's thread with each forwarded tool call (patch 0017); it would pass the tags the thread may reach, and the helper's check takes a set. T3's `preview_*` tools get the same rule in the server. Grants go with the thread's permissions (`forgetThreadPermissions`).

Until that's built, project- and global-scoped windows are out of every agent's reach (their tag names no thread).

## The tray

The sidebar's footer gets a row: the clock and date on the left; network, volume, battery, Bluetooth, the tray and power on the right, each opening a popover. They are the plain shell's modules (`shells/plain/{audio,battery,…}.js`, each `default(shell, container)`), on the shell library T3 already loads; `osd.js` shows volume and brightness keys over everything. With the sidebar hidden, the clock moves to the panel's header.

## Steps

1. Slots for the terminal, apps and sites; run, raise, minimise; split and fold; Super+Shift+N and the tab menu. Sites only in the thread scope (T3's browser tabs are per thread on the server).
2. Templates, `dock.json`, project overrides, an app's folder for project scope (the helper's `/v1/apps/launch` takes a `cwd`).
3. Groups, `"rest"`, the group picker; sites in project and global scope.
4. Agents' reach and the permission prompt.
5. The folded chat's strip.
6. The tray (independent of the rest).

## Step 1 as built (2026-10-27)

- `apps/web/src/plutonium/dock.ts`: the slots (kept in the page's storage, `t3code:plutonium-dock:v1`), finding a slot's windows and tabs, run, raise and go back, assigning and the scope. `panelKeys.ts` handles the keys; ChatView lends the dock the thread's panel and terminal.
- Keybinding commands `dock.slot.N`, `dock.slotOther.N`, `dock.assign.N`, `dock.toggleLayout`; their defaults have `when: "plutoniumShell"`, a new context that is true in the Plutonium shell only, so Cmd+1 on a Mac stays T3's.
- The terminal fold: the drawer takes the chat column (`fill`), the conversation is hidden.
- Fixed on the way: a browser tab's page or an app's window given the keyboard lost it to the composer a frame later, when the shell window's `focus` event followed. `shouldRefocusComposerOnWindowFocus` now leaves `EMBED` and `NATIVE-WINDOW` alone, as it did `IFRAME` and `WEBVIEW`.
- Not yet: sites in project or global scope (a site slot uses the thread's tabs whatever its scope), the folded chat's strip.

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
