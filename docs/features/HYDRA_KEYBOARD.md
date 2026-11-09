# Hydra from the keyboard: one normal mode, jumps, `g` and `z`

**Status: a first version to try, off unless `PLUTONIUM_VIM=1`** (2026-11-09; "What's built" below says what is and isn't). Stock T3 is built for the mouse. It has about 120 bindings, but nearly all of them open or toggle something: the sidebar, the terminal, the palette, a picker. Once you're in the UI, almost nothing moves to an item or acts on one. The exception is the file manager, which has a full vim grammar. The goal: **everything in Hydra is as fast from the keyboard as with the mouse, or faster**, and comfortable to do all day.

It sits on two other designs:
- [PLUTO_VIM.md](PLUTO_VIM.md): the vim engine in every text field. This doc changes its base keymap.
- [KEYS.md](KEYS.md): the desktop's keymap, contexts, chords, modes and `config.js`. That's the plumbing this doc's Super keys and modes need.

## Principles

1. **One normal mode.** No second, nested normal mode for the UI. The composer's normal mode, Pluto Vim's in every field, is the normal mode: keys that act on the UI sit in it next to the text keys, on keys vim leaves free or barely uses. It's one mode for the whole desktop (One input model, below).
2. **Jumps first.** Most of the time you want to *be somewhere*, not move there step by step. Every place and every visible thing is a jump away, and going back is one key (the jump list).
3. **Bare keys for what's frequent.** A bare letter, Space, Tab or Backspace beats any chord. Modifiers are for insert mode and for getting in from outside a field. Super is the fallback from anywhere, not the main way in.
4. **Vim's keys earn their place by use today, not by history.** What prose and chat use rarely goes (Dropped, below). What vim never had (labeled jumps, spelling fixes, structure motions, folds over UI) gets the keys.
5. **Modes only where you repeat.** A separate UI mode is for doing the same thing many times in a row (resizing). Everything else is a key in normal mode. A mode shows a badge and its keys, takes every key while it's active, and Escape leaves it back where you were: the same field, mode and cursor.
6. **Pages fill slots.** The base map is the same in every field. Keys that only mean something in an app (the next thread, page the context) are slots that the page fills through `data-pvim-actions`. A slot a page doesn't fill does nothing.
7. **Focus always lands somewhere.** Closing, hiding or leaving anything puts focus back where it came from, never on `<body>`.

## One input model

Built 2026-11-09, after the first version's keys turned out to depend on where focus happened to be. That version had five places deciding whether a key was Pluto Vim's, each with its own key table and its own idea of the mode:
- the composer and the timeline, each a field session with its own mode;
- Hydra off a field, with a hand-written table of its own;
- a browser tab off a field, with another;
- the composer's yields, set by React a render after the mode changed;
- native fields, whose page keys never reached Hydra.

The model now:
- **One mode for the desktop**, normal or insert: Hydra, every tab and every app share it. The helper keeps it (`mode.set`, `mode.get`) and tells every page's engine and the native one. A field takes it when it gets the keyboard. Only keys and the actions that say so change it: `i` and its kin, Caps Lock, `gi`/`gA`/Super+Enter, a send (back to normal).
- **Normal mode: Pluto Vim first.** Every key goes to the engine before the page, and one it has no use for goes on. **Insert mode: the page or app first**, but for Caps Lock and the keys a page gives up (`data-pvim-yield`).
- **Caps Lock is normal mode, everywhere**: in a field, off one, in a terminal, in an app. **Escape is always the page's or the app's**: it never changes the mode. In normal mode it cancels what's in progress (a pending command, visual mode, a jump, the `:` line), and otherwise goes on.
- **Off a field is a place too:** a page session (the page itself, or a native window with no field) has the page keys, counts, `j`/`k`/`h`/`l`/`gg`/`G`/Ctrl+D/Ctrl+U to scroll, `gw`, `gi`, `gA`, `y`/`n` on an approval, and `i` `a` `A` `I` `o` `O`. Those go to the page's insert (Hydra's: the composer), or else to insert mode, where the page or app has every key. A tab's `H`/`L` are back and forward. In an app, scrolling is the app's own arrows and Page Up/Down. Other keys are the page's, except in Hydra, which takes every key in normal mode (`data-pvim-page="all"`), so typing doesn't go to the composer.
- **Ctrl+D and Ctrl+U page the context from anywhere in normal mode**, a field included, as Space and Backspace do: Hydra's timeline, the page around a tab's field, never the field's own text (vim's Ctrl+D scrolls the window, not the buffer). Not in insert mode, where Ctrl+U deletes to the line's start and terminals need both.
- **Held `j` or `k` glides** off a field: a line at once, then after 180 ms a scroll that speeds up from 900 to 4500 px/s until the key is let go. With a count, just that many lines.
- **`gw` alone is always the whole screen**: the page's own `jump.word` where it has one (Hydra), else the shell's labels (a tab's field relays it), so a word anywhere is a jump away; after an operator (`y gw`) it's the field's words.
- **Places for typing** are insert mode while they have the keyboard: a single-line input, a password, a terminal, an editor with its own keys. When focus leaves one, the mode it had before comes back, unless you changed it there. So `gt`, `gB` and the palette are ready to type, and leaving them puts you back where you were.
- **A click into a field, a terminal or an editor** is insert mode.
- **One table:** `PAGE_KEYS` and `PAGE_ACTIONS` in `commands.js`, matched by the engine's own parser (counts, prefixes, the timeout). Hydra declares its actions on the document, so they work from the composer, the timeline and off a field alike. While Hydra's labels show, the engine takes no keys (`data-pvim-paused`).
- **The mode pill**, in the title bar's status cluster: the mode, where the keyboard is (Composer, Timeline, a tab's site, an app), the keys typed so far and a macro being recorded. After a prefix (`g`, `z`, `]`) waits 400 ms, a which-key list shows what can follow it. Pluto Vim reports it as `pvim:state` in each page; the helper relays the tab's or app's with the keyboard to the shells (`plutonium:pvim-state`).

## The audit

Every mouse interaction in Hydra, by surface, with its keyboard path today and the plan. This is the "as good or better" test: a row is done when the keyboard path takes no more effort than the mouse. It comes from reading T3's code (2026-11-09), so it lists what the code has, and each row still needs checking on screen.

| Surface | With the mouse | Keyboard today | Plan |
|---|---|---|---|
| **Sidebar: threads** | Click to open; double-click to rename; hover card; drag to reorder or into a group; inline settle, snooze, wake, unpin, dismiss; a context menu (copy, path, branch, pin, settle, snooze, rename, regenerate title, mark unread, share with guest, filter by project, turn into project, auto-settle, discard draft) | Previous and next thread (Ctrl+Shift+[ ]), Nth thread, pin, settle, copy reference; Tab focus | `H`/`L`, `Tab` (recently used), `gp`; `S` labels on rows; `K` the hover card; `:` for every menu item (`:snooze 1h`, `:rename`); the Menu key or Shift+F10 opens the menu on a focused row; moving with `:move <group>` until there's a better key |
| **Sidebar: chrome** | Search; new thread; project groups collapse; filters; the update pill | New thread (Ctrl+N), sidebar toggle (Ctrl+B) | `gs` then `/`; `za` on a group, `zR`/`zM`; `zs` |
| **Timeline: messages** | Copy prompt link; edit from here; scroll with the wheel or the minimap; select text for the selection toolbar (quote, cite, comment) | Find (Ctrl+F) | `Space`/`Backspace` page it; `gm` the latest; `S` labels on messages; a read-only Pluto Vim buffer over a message for selecting (PLUTO_VIM.md, later); `:` for copy and edit from here |
| **Timeline: work** | Expand a tool call or work log; open a subagent's thread | Tab, then Enter | `za`/`zo`/`zc`, `zR`/`zM` for every tool call; `S` labels; `gx` on a subagent row |
| **Timeline: content** | Code blocks (copy, run in terminal, actions menu); links; images open; citations | Tab | `S` labels; `gx` on a link or file; `:` for a code block's actions |
| **Composer** | Attach files (button, drop); model, effort, mode, host, workspace, branch pickers; stop; previous question; implementation actions; queued runs; stash | Most pickers have Ctrl+Shift keys; steer and edit queued messages; stash | Pickers keep their keys, all with the same list keys (Ctrl+N/P, Ctrl+Y, Enter); `gi`/`gA`/`gc` and Super+Enter to get here; `zm` for a full-height composer; `:` for the rest (`:model`, `:attach`) |
| **Approvals and questions** | Buttons in the pending-input panel | Its own key handling (to check) | `gp` lands there; `y`, `n`, `a` (always) answer |
| **Header** | Double-click the title to rename; context menu; relationships; PR row; thread details; git actions; project scripts | Thread details (Ctrl+Shift+B) | `S` labels; `:` (`:rename`, `:pr`, `:script <name>`) |
| **Right panel: tabs** | Click; double-click to rename; context menu; add a surface, a browser in a profile, a private tab; scroll arrows; drag between threads | Ctrl+Tab, Alt+1…9, Ctrl+T, Ctrl+W (Hydra's page only after KEYS.md step 1) | `gb`/`gt`/`ga` with a count; `S` labels on tabs; `zb`; `:tab` for the rest |
| **Right panel: browser chrome** | Back, forward, reload, address, zoom, the more menu | Reload, address, zoom while the preview has focus | `gB` the address bar; `H`/`L` in the page are history (the slots); `:` for the menu |
| **Terminal drawer** | Resize by dragging; split; new; close; context menu | Toggle (Ctrl+J); split, new and close while it has focus | `gt` (insert mode, ready to type), `zt`; resize mode |
| **Diff panel** | File tree; hunks; copy a path; open a file | Toggle (Ctrl+D), nothing inside | `gd`; `]f`/`[f` by file, `]h`/`[h` by hunk (in the diff); `za` a file; `gx` opens in the editor |
| **PR panel** | Many buttons and tabs | None | `S` labels and `:` first; its own keys once it's used enough to say which |
| **Resize handles** | Sidebar width, right panel width, drawer height, file preview, diff | None | `zm`, the resize mode |
| **Dock** | Slots; a slot's editor | Super+1…9 and its Shift and Ctrl forms | As now |
| **Toasts** | Their actions (Show, Give access) | None | `:` and the notification area (BACKLOG, "Hydra's toasts in one notification area") |
| **Dialogs, settings** | Everything | Tab, mostly | `S` labels; lower priority |

## The base map

In normal mode, in every field Pluto Vim is on in. **New** marks a key that changes from vim's.

### Dropped

These go, or stop being defaults (an `init.js` can bring any of them back):
- `s`/`S` (`cl`/`cc` already do it);
- `H`/`M`/`L` (top, middle or bottom of the screen);
- `K` (keywordprg);
- `U` in normal mode (undo the line);
- `Q` (Ex mode);
- `R` (replace mode);
- `=` (reindent);
- `-` `+` `_` `|` `&`;
- `Ctrl+A`/`Ctrl+X` (increment, decrement);
- `g?`, `gJ`, digraphs, folds over text;
- `zt`/`zb`/`zz` (scroll the cursor's line);
- `Space`, `Backspace`, `Tab` and Enter as motions (`l`, `h`, Ctrl+I and `+` again).

What stays is the core: `hjkl`, `w b e`, `0 ^ $`, `gg G`, `f t ; ,`, `i a I A o O`, `d c y p P x`, text objects, `v V`, `.`, `/ ? n N * #`, `u`, `q`, `m`, Ctrl+O and Ctrl+I.

### Moving in the text

| Key | Does |
|---|---|
| `s` + 1–2 characters | **New.** A labeled jump around here (Jumps, below) |
| `(` `)` | Sentences, **new** in Pluto Vim (it doesn't have them yet) |
| `{` `}` | Paragraphs |
| `]h [h`, `]l [l`, `]c [c` | **New.** Markdown headings, list items, code blocks |
| `ic/ac`, `il/al`, `ih/ah`, `iu/au` | **New** text objects: a code block, a list item, a section under a heading, a URL |
| `U` | **New.** Redo (helix's); Ctrl+R stays |

### Fixing text

| Key | Does |
|---|---|
| `=` | **New.** Fix the nearest misspelling at or before the cursor with the first suggestion, without moving the cursor. `=` again puts the next suggestion in its place. One undo step |
| `]s [s` | The next or previous misspelling |
| `K` | **New.** Details for what's under the cursor: a misspelling's suggestions (pick by number), a link's preview, a file mention, a thread's hover card |
| `>` / `<` | **Changed.** Quote and unquote as Markdown (`> `), not indent |
| `ds"`, `cs"'`, `s` in visual mode | **New.** Surround. After an operator, `s` is surround, not a jump |
| insert mode: Ctrl+L | **New.** Fix the last misspelling and keep typing |

### Around the field

| Key | Does | Slot |
|---|---|---|
| `Space` / `Backspace` | **New.** Half a page of the context down or up, without moving the cursor: in Hydra the timeline, in a browser tab the page. In insert mode, PageDown and PageUp | `context.pageDown`, `context.pageUp` |
| `Tab` | **New.** The last thread, and further back through the recently used ones while you keep pressing it within a moment, as Alt+Tab does | `item.recent` |
| `H` / `L` | **New.** The previous or next thread in the sidebar's order; history in a browser tab | `item.previous`, `item.next` |
| `:` | The command line and the palette as one (KEYS.md, "One command line") | |
| insert mode: Ctrl+O | One normal command from insert mode (Pluto Vim has it). The only modifier a jump needs: Ctrl+O `s…`, Ctrl+O `gt` | |

Enter still sends from either mode in the composer (PLUTO_VIM.md, 2026-11-08). That's why opening the thing under the cursor is `gx`, not Enter.

## Jumps

Three, by distance. Labels use the home row first, and the nearest or most likely targets get the shortest ones.

| Key | Covers | How |
|---|---|---|
| `s` + 1–2 characters | **Around here:** the field you're in, then the visible lines near the cursor | Flash-style: matches get labels as you type, so the usual jump is `s`, two characters and one label. A match that's alone needs no label |
| `S` | **Significant things on screen:** the composer, the sidebar's threads, the panel's tabs, messages, tool calls, code blocks, links, buttons, a waiting approval, the terminal | There are few targets, so most labels are one key. **A fixed place's label is its `g` letter:** `S t` is the terminal, as `gt` is, so the labels you use most get learned |
| `gw` | **Any word on screen**, in every region | Helix's `gw`, without typing characters first. It's the experiment of the three: if it turns out to be noise, it goes |

A jump is a jump in the jump list, so Ctrl+O comes back. A jump into a field lands in normal mode (the mode follows you), except into a terminal, which lands ready to type.

Where labels can go, in order: Hydra's own page (its DOM, from the engine's world there), then the panel's browser tabs (through the helper's DevTools sessions, as site extensions are), then native apps (the accessibility tree the agents' `snapshot_window` already reads).

## `g`: go to a place

`g` is helix's goto menu, with vim's meanings kept where they're already right (`gg`, `gi`, `gx`). Going to a place that's hidden shows it. A count picks one of several: `2gt` is the second terminal.

| Key | Goes to |
|---|---|
| `gi` | The composer, in insert mode where you last left insert mode (vim's `gi`) |
| `gA` | The composer, at the end, in insert mode |
| `gc` | The composer, in normal mode, with the cursor where it was |
| `gm` | The latest message in the timeline |
| `gp` | The next thread waiting on you, with its approval or question focused: `y`, `n`, `a` answer it |
| `gt` | The terminal drawer, ready to type |
| `gb` / `gB` | The panel's browser: the page / its address bar |
| `ga` | The last native app in the panel |
| `gf` | The files |
| `gd` | The diff |
| `gs` | The sidebar |
| `gx` | What's under the cursor: a URL in the thread's browser, a file in the viewer, an `@thread` in its thread, a subagent's row in its thread |
| `gw` | Any word on screen (Jumps) |

**Super+Enter** is `gA` from anywhere, in any app: "write a message". It's a shell shortcut once Hydra's keys are on Super (KEYS.md, step 1).

From a field outside Hydra's page (a textarea in a panel tab), the places go through the helper to Hydra, as uppercase marks already do.

## `z`: show, hide and fold

**`g` goes to something, `z` shows or hides it without moving focus**, with the same letters.

| Key | Does |
|---|---|
| `za` / `zo` / `zc` | Toggle, open or close the item at the cursor: a tool call, a work log, a long message, a code block, a diff file, a sidebar group |
| `zR` / `zM` | Open or close every item of that kind in view: every tool call closed reads only the conversation |
| `zt` `zb` `zs` `zf` `zd` | Show or hide the terminal drawer, the right panel, the sidebar, the files, the diff |
| `zm` | Maximize the region with focus, and again to restore. In the composer, a full-height composer; in the panel, the full width |
| `z` + Space | The resize mode |

## The resize mode

Entered with Super+R from anywhere, or `z` + Space from normal mode. It acts on the region with focus.

| Key | Does |
|---|---|
| `h`/`l`, `j`/`k` | Move the region's edge; `H`/`L`, `J`/`K` in bigger steps |
| `1`–`9` | Preset sizes: 1 is a third, 5 half, 9 almost everything |
| `=` | Back to the default layout |
| `m` | Maximize, as `zm` |
| `Tab` | The next region, without leaving the mode |
| Escape, Enter | Leave |

While focus is in Hydra's page, the page takes these keys itself, so the first version needs no keyboard grab. Started from a native app or a tab, it needs KEYS.md's grab.

## Where each part lives

| Part | Where |
|---|---|
| The base map, `s`, text objects, spelling keys, `U`, `>`, surround | Pluto Vim's engine (`helper/web/vim/commands.js`, `engine.js`), so every field gets them |
| Slots (`context.*`, `item.*`), places (`g…`), shows and folds (`z…`), approvals | `data-pvim-actions` from the page: Hydra's in T3 patch 0013. The engine maps the keys onto actions; a slot a page doesn't declare does nothing |
| `S`, `gw` labels, the resize mode | Hydra's page first, then the helper for tabs and native apps |
| Super+Enter, Super+R | Shell shortcuts, after KEYS.md step 1 |
| Spelling suggestions | To decide (Open questions) |

## What's built

From 2026-11-09, for trying out:

**In every field** (Pluto Vim's engine):
- the base map's drops;
- `(` `)`, `]h [h`, `]l [l`, `]c [c`;
- `ic` `il` `ih` `iu`;
- `U`;
- `>` `<` as quotes (`vim.opt.shift = "indent"` for vim's);
- surround (`ds`, `cs`, `ys`, `s` in visual mode);
- `gi`, `gA`;
- `s`, with labels over web fields;
- `gw` after an operator or in visual mode: labels on every word of the field, and the operator takes the word it lands on (`y gw` yanks from here through that word); alone, the page's `jump.word` where it has one;
- one mode for the desktop, Caps Lock to normal mode and Escape always the page's, page sessions off a field and in apps without one, places for typing, and the mode pill (One input model, above);
- a page's read-only text (`data-pvim-readonly`) is a field: its cursor is drawn, motions, visual mode and `y` work, what would change it does nothing, and `i`, `a` or `c` ask the page to insert;
- a place, a show or a jump the field's page doesn't have goes to the shell (a browser tab's `gc`, `zt`, `S`), also off a field in a page.

While a jump or the `:` line is typed, every key is Pluto Vim's before the page's (so Enter never sends).

**In Hydra** (T3 patch 0013, `plutonium/{hydraKeys,hints}.ts`):
- `Space`/`Backspace` page the timeline by half pages;
- the timeline is a read-only field: `gw` onto one of its words, or `gm`, puts the cursor there, so `gw` `y` `gw` (or `v`…`y`) yanks agent output, and `gi` `p` puts it in the composer; `i` there goes back to the composer, typing;
- after Enter sends a message, the composer is back in normal mode;
- off a field, `i`, `a` and `A` go to the composer, typing (`A` at its end), and in normal mode letters don't type into it (T3's type-to-focus does in insert mode);
- keys relayed from a browser tab in the panel run here, and the page takes the keyboard for places and labels;
- Super+Enter: the composer, at its end, in insert mode, from anywhere (a browser tab, an app); Hydra's other keys on Super as KEYS.md's table says;
- `S` and `gw` label the panel's browser tabs too: Pluto Vim in each tab collects its targets (`web/vim/hints.js`), the helper gathers them (`hints.collect`), and Hydra labels them with its own, over the tab, so labels never clash; a typed label gives the tab the keyboard and goes to its target there (`hints.go`);
- the labels and the read-only cursor are in Hydra's theme (its tokens; Pluto Vim reads `--pvim-caret` and `--pvim-label-*`), and the cursor follows the timeline as it scrolls or grows;
- while labels show, Pluto Vim takes no keys (`data-pvim-paused`);
- `Tab` goes through threads by recent use, drafts included, and `H`/`L` by the sidebar's order;
- `gt` `gb` `gB` `ga` `gf` `gd` `gs` `gm` `gp` `gx` `gc`;
- `zt` `zb` `zs` `zf` `zd`, and `zm` (the panel maximized);
- `S` and `gw` labels on Hydra's page;
- `y`/`n` on an approval `gp` went to;
- the same keys when the keyboard isn't in a field, from the same table.

**Checked in a slot's Hydra:** `)`, Backspace not deleting in normal mode, `s`, `ysiw*` and `ds*`, `S`, `zt` keeping the keyboard, `gt`, `Tab` between drafts.

**Not yet:**
- spelling (`=`, `]s`, Ctrl+L), `K`, folds (`za`…), the resize mode and Super+R;
- `gp` across threads, and `a` on an approval;
- a full-height composer for `zm`;
- labels in native apps.

**Known issues:**
- `>>` in Hydra's composer: the editor turns the quote into a block quote but keeps the `> ` text in it, and `<<` leaves the empty block. The composer should do quoting itself, as a page action.
- `place.sidebar`'s selector is a guess, not checked.

## The work, in order

Each step is something to try for real before the next one.

1. **The engine's base map:** drop the list above, `(` `)`, `U`, `>`/`<` as quotes, Markdown motions and text objects, surround, `s` inside the field. All in the engine, with tests, no Hydra change.
2. **Hydra's slots and places:** `Space`/`Backspace` on the timeline, `Tab` and `H`/`L` through threads, `gi` `gA` `gc` `gm` `gp` `gt` `gb` `gB` `ga` `gf` `gd` `gs` `gx`, and `y`/`n`/`a` on an approval, through `data-pvim-actions` (patch 0013).
3. **`z`:** showing and hiding regions, `zm`, and folds on tool calls, work logs, code blocks and sidebar groups.
4. **`S` and `gw`** in Hydra's page.
5. **Spelling:** `=`, `]s`, `K`'s suggestions, insert mode's Ctrl+L.
6. **Super+Enter and the resize mode**, with KEYS.md step 1 (Hydra's keys on Super).
7. **`:` and the palette as one**, with every menu item from the audit as a command.
8. **Labels in tabs, then native apps.**
9. **The audit on screen:** each row checked, timed against the mouse, and updated.

## Decisions

- 2026-11-09: one normal mode, not a nested one for the UI. Separate modes only where something repeats (resizing).
- 2026-11-09, after trying it: paging is half pages (a full page lost the reader's place, and the composer covers part of the timeline); web fields start and stay in normal mode, since `i` is cheap; the timeline is a read-only field, so agent output can be selected and yanked from the keyboard; a browser tab's places and shows reach Hydra.
- 2026-11-09: vim's keys stay by use today. The dropped list above, and what vim never had gets the keys.
- 2026-11-09: three jumps: `s` around here, `S` significant things, `gw` any word on screen (to see whether it's worth its key).
- 2026-11-09: `Tab` goes through threads by recent use, `H`/`L` by the sidebar's order.
- 2026-11-09: no agent rewrite operator (`ga` as "ask the agent to rewrite"). In Hydra, the composer already is a prompt to an agent, so rewriting it with another agent adds little. `ga` is the last native app instead.
- 2026-11-09: `g` goes, `z` shows and hides, with the same letters. Vim's `gi` is the composer.
- 2026-11-09: one input model (above). One mode for the desktop; normal mode is Pluto Vim's first and insert mode the page's; native apps without a field get our keys in normal mode too; a click into a field is insert mode; Caps Lock is normal mode everywhere and Escape is always the page's, so the two never mean the same thing.

## Open questions

1. **Spelling suggestions.** Blink's spellchecker marks words, but an isolated world can't ask it for suggestions, and native fields have none to ask. Options: a small hook in the Chromium patch for the web, or one spellchecker in the helper (hunspell's dictionaries) for every backend. The helper's would be the same everywhere.
2. **`Tab` in fields that use it.** Some editors take Tab in normal mode (CodeMirror's indent). Principle 1 of PLUTO_VIM.md (the page's handlers come first) means they keep it; check that's enough.
3. **`H`/`L` outside Hydra.** History in a browser tab is a guess at what that slot should be there.
4. **`S`'s targets.** Which targets count as significant is a list to tune by use. Too many and its labels get as long as `gw`'s.
