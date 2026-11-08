# Pluto Vim: vim mode in every text field, one engine, JS for config

**Status: steps 1–10 built and merged (2026-11-09), off unless `PLUTONIUM_VIM=1`:** the engine, the web backend, Blink's key hook, registers, pages that integrate (Hydra's composer), native apps over text-input-v3, the primary selection, the command line, marks and macros across the desktop, and the AT-SPI fallback; each step's "Step N (built)" section says what was verified. Not built: what waits on KEYS.md's keymap and `config.js`. Pluto Vim is the desktop's vim mode. Its names: `~/.pluto/vim/` for the config, `plutonium vim` for the CLI, `plutonium_vim` / `PlutoniumVim` inside Chromium (as `plutonium_keys.cc`), and the short `pvim` where pages can see it (`data-pvim-*` attributes, `pvim:*` events), so it can't clash with a page's own vim (CodeMirror's, Monaco's). Inside `init.js` the API is `vim` (the argument `setup` gets), so neovim habits carry over. The goals:
- vim's modal editing in every text field: web pages, shell pages and native apps;
- one engine everywhere, so keymaps, registers, marks and macros work the same in every field;
- configured and extended in JavaScript, as neovim is in Lua: `~/.pluto/vim/init.js`, with an API close to neovim's, so habits and plugin ideas carry over;
- part of the desktop: registers shared across apps and scoped to threads or projects, marks that name a field in a window, and `:` commands that run desktop actions.

It sits next to [KEYS.md](KEYS.md): the desktop's keymap decides what Super combinations do, and vim mode decides what keys do inside a text field.

## How it fits together

```
  web pages and shell pages                         native apps
 ┌────────────────────────────────┐   ┌──────────────────────────────────────┐
 │ renderer, per frame            │   │ browser process: Exo, text-input-v3  │
 │  isolated world: engine +      │   │  key held, as for an async IME       │
 │  init.js  ⇄  Blink's vim core  │   │        ⇅                             │
 │  (synchronous)                 │   │ vim host: engine + init.js           │
 └──────────────┬─────────────────┘   └───────────────────┬──────────────────┘
                │        DevTools binding, engine's world │
                └──────────────►     helper     ◄─────────┘
                     register store (memory only), marks, jumps,
                     thread and project scopes, init.js,
                     config.js (KEYS.md), agents' tools
```

- **The engine** (modes, counts, operators, motions, text objects, registers, macros, the `:` line) is JavaScript. It is shipped as the default runtime, like neovim's `runtime/`, and `init.js` can change or replace any part of it.
- **A backend** gives the engine a field as a buffer (Buffer interface, below). Blink is one backend, text-input-v3 another, and AT-SPI a fallback.
- **The register store** is in the helper, so every backend shares it, and in its memory only: registers never touch the disk. The helper knows each field's thread and project. The engine reaches it through a DevTools binding that only the engine's world has.

## Principles

1. **Vim yields to the page.** A page's keydown handlers see every key first. Vim only acts where Blink would otherwise insert text or run a default editing action. Editors with their own key handling (Monaco, CodeMirror, xterm.js) keep working. A page that integrates can give keys up to the engine (Pages that integrate, below).
2. **Fields start in insert mode,** unless you choose otherwise for a field, a site or a page that integrates (Pages that integrate, below). Typing into a search box never changes. Normal mode starts with Caps Lock or Ctrl+[, which are Pluto Vim's before the page, or with Escape where the page leaves it alone.
3. **Escape in normal mode belongs to the page.** The first Escape enters normal mode; the second closes the dialog or cancels the edit, as the page expects.
4. **Edits go through the editor, not around it.** Operators run Blink's editing commands, so pages get real `beforeinput` and `input` events (`deleteWordForward`, `historyUndo`) and frameworks (React, ProseMirror, Lexical, Tiptap) keep their own models. Native apps get edits through text-input-v3 and their own undo.
5. **Passwords are never touched.** Password fields (web) and fields marked `password`, `sensitive_data` or `hidden_text` (text-input-v3) are always in insert mode, and no config can change that.
6. **The decision to take a key is synchronous; its effect may not be.** As in KEYS.md: on the web the engine decides in the renderer with no IPC; for native apps the key is held for at most a few milliseconds. A paste from the register store may land a moment after its key.
7. **One engine.** Every backend runs the same JS, with the same config, so nothing works in one kind of field and not another unless the backend can't do it. Each backend documents the limits it has.

## The engine

### The first version

- **Modes:** normal, insert, visual, visual line, operator-pending, replace (`r`, `R`).
- **Motions,** with counts: `h j k l`, `w b e W B E ge`, `0 ^ $`, `gg G`, `f t F T ; ,`, `{ }`, `%`.
- **Operators:** `d c y` with motions and text objects, `dd cc yy`, `D C Y`, `x X`, `s S`, `~`, `>` and `<` (where the field has indentation), `J`.
- **Inserting:** `i a I A o O`, `p P`, `u` and Ctrl+R, Ctrl+W and Ctrl+U in insert mode.
- **Text objects:** `iw aw iW aW`, `i" a" i' a' i\` a\``, `i( a( i[ a[ i{ a{ i< a<`, `it at`, `ip ap`.
- **Repeat:** `.`.
- **Registers:** all of vim's (Registers, below).

### Insert mode extras

Insert mode is the field's own typing plus a few of vim's insert-mode keys, so registers are within reach without leaving it. They work in every field Pluto Vim is on in, single-line inputs included:
- **Ctrl+R {register}** puts a register (`Ctrl+R +`, `Ctrl+R a`, `Ctrl+R #1`); Ctrl+R Ctrl+R puts it literally, as in vim.
- **Ctrl+O** runs one normal-mode command and comes back to insert mode (`Ctrl+O "ayiw`, `Ctrl+O p`).
- **Caps Lock** and **Ctrl+[** enter normal mode, before the page. In multi-line fields Escape does too, where the page doesn't take it first; in single-line inputs Escape stays the page's (it clears search boxes and closes autocompletes).
- Ctrl+W and Ctrl+U, as in the first version above.

Each one is an ordinary insert-mode mapping, so `init.js` can move or remove it. Two limits:
- On the web, Principle 1 still applies: a page that handles Ctrl+R itself keeps it.
- In native apps, insert mode passes keys on, except the ones Pluto Vim maps, which it takes before the app sees them. Ctrl+R and Ctrl+O mean things in some apps (reload, open), so the native defaults may need to be narrower than the web's; to be decided at step 7, with the apps we use.

### Single-line inputs

Most `<input>` fields are search boxes, address bars and forms, so normal mode doesn't start by itself there. `vim.opt.inputs`:
- `"manual"` (the default): insert mode with its extras; Ctrl+[ enters normal mode, and the field stays in Pluto Vim's hands until it loses focus;
- `"on"`: as a textarea, Escape included;
- `"off"`: Pluto Vim stays out entirely.

In normal mode in a single-line input, Enter submits, as it does in insert mode: there is no next line to go to.

Later: macros (`q`, `@`), `/` and `?` search (Blink's find-in-page on the web, the surrounding text elsewhere), marks and the jump list across the desktop, the `:` line and its commands, `gv`, visual block where a backend can draw it, `g~ gu gU`, `<C-a>` and `<C-x>`.

### The Buffer interface

What the engine needs from a field. Every backend implements it. A backend that can't do something says so in `caps`, and the engine falls back or refuses the command with a message, but never guesses.

```ts
interface Buffer {
  readonly kind: "web" | "native" | "atspi";
  readonly field: { singleLine: boolean; purpose?: string; site?: string; appId?: string; thread?: string };
  readonly caps: { exactMotions: boolean; wholeText: boolean; selection: boolean; undo: "own" | "keys" };

  /** The text around the cursor, with the cursor and selection as offsets into it. */
  text(): { text: string; start: number; cursor: number; anchor: number };

  /** Moves or extends the selection: Blink's granularities, or a target offset. */
  move(to: { by: "char" | "word" | "line" | "paragraph" | "document"; dir: -1 | 1; count?: number; extend?: boolean } | { offset: number; extend?: boolean }): Promise<void>;

  /** Replaces a range, as one edit the field can undo. */
  edit(range: { from: number; to: number }, insert: string): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;

  /** How the cursor looks: a block in normal mode, a bar in insert, an underline in operator-pending. */
  setCaret(shape: "block" | "bar" | "underline"): void;
}
```

`move` and `edit` return promises because the native backends need them to. On the web they resolve at once.

## Backends

### Web: Blink (`core/editing/plutonium_vim/`, one Chromium patch)

What Blink gives the engine:
- **Motions:** `FrameSelection::Modify(alter, direction, granularity)` for character, word, line, paragraph and document, so `move` is exact, including visual lines in wrapped text.
- **Edits:** editing commands, with the `beforeinput` and `input` events pages expect.
- **Text:** the field's whole value (an `<input>` or a `<textarea>`), or the editing host's text around the selection (a contenteditable).
- **The caret:** `caret-shape` (`block`, `bar`, `underline`), which Blink already supports, set on the editing host for the engine.
- **The key hook:** `Editor::HandleKeyboardEvent`, the default action of a key in an editable field, after the page's handlers. When the engine is in normal, visual or operator-pending mode, the key goes to the engine instead of being inserted. In insert mode, only the keys the engine maps (`jk`, Ctrl+W) are taken.

**The isolated world.** The engine and `init.js` run in an isolated world in each frame, with a world id of our own (`content/public/common/isolated_world_ids.h`). This is the same mechanism extensions' content scripts use:
- the world sees the page's DOM, but not the page's JavaScript, and the page can't see or change the engine or the config;
- it's made on the first focus of an editable field, so a page without one pays nothing; the engine and `init.js` are compiled once, using V8's code cache;
- the Buffer calls are bindings into Blink's Pluto Vim core, which exist only in that world.

**When vim stays out**, by default (each one a setting):
- password fields, always (Principle 5);
- single-line `<input>` fields: insert mode with its extras, normal mode only by Ctrl+[ (`vim.opt.inputs`, above);
- hidden or off-screen textareas, which terminals (xterm.js) and editors use to read keys;
- fields inside `.monaco-editor`, `.cm-editor` and `.xterm`, which have their own key handling (and often their own vim);
- sites and shells you turn it off for (`vim.disable({ site })`).

Shell pages are pages too: Hydra's composer, Charon's search and the switcher's fields all get vim mode, unless the shell opts out of it for a field (`data-pvim="off"`).

### Pages that integrate

Principle 1 makes a page's own keys win, which is right for pages that know nothing of Pluto Vim. A page that does know can do better, and Hydra's composer is the first: it should be usable entirely in vim mode, starting in normal mode if you choose.

The page and the engine share the DOM, not JavaScript, so the protocol is attributes and DOM events on the field:
- **`data-pvim-start="normal" | "insert"`**: the page's default starting mode. Your config overrides it: `vim.enable({ site, shell, selector, start })` for some fields, or `vim.opt.startInInsert` for every field.
- **`pvim:mode` events** on the field, with `{ mode }`, whenever the mode changes, and `data-pvim-mode` on it. The detail reaches the page's own world (Blink clones it across worlds).
- **`data-pvim-actions="submit history.prev history.next …"`**: what the field can do that isn't editing text. The engine runs one by dispatching `pvim:action` with `{ name }` on the field. Default keys map onto the common ones:
  - normal mode: Enter → `menu.select` or `submit`; `j` and `k` → `menu.next` and `menu.prev`, or past the last or first line `history.next` and `history.prev`;
  - insert mode, for an open menu, as vim's completion popup: Ctrl+N → `menu.next`, Ctrl+P → `menu.prev`, Ctrl+Y → `menu.select`, Ctrl+E → `menu.close`. Without the action, the key is the page's.
  - `init.js` maps the rest: `vim.keymap.set("n", "<leader>m", { action: "model" })`.
- **`data-pvim-commands="model stash"`**: names a mapping's `<Cmd>…<CR>` (and the `:` line, step 9) runs as the action of the same name, when `init.js` has no command by that name.
- **`data-pvim-yield="<C-n> <C-p>"`**: keys, in vim's notation, the page's own handlers give up for as long as the attribute says so. They're claimed before the page, as `vim.opt.claim` is. The page sets and clears it as its state changes (Hydra yields Ctrl+N/P/Y/E only while a menu is open, since Ctrl+N is otherwise a new thread).

The names are settled (`data-pvim-*`, `pvim:*`) and are a public contract from here.

For Hydra this is a T3 patch (`apps/web/src/plutonium/plutoVim.ts`, one hook call in `ChatComposer.tsx`): the composer declares `submit`, the prompt history, the menu actions while a `/` or `@` menu is open, and `model` and `stash`. Each action runs the composer's own key handling (`submit` is its Enter, `history.prev` its ArrowUp), so it does what that key would, with the same conditions. Enter in normal mode is the composer's own Enter, which sends: its handler is the page's, and comes first. A menu is driven from insert mode, because entering normal mode moves the cursor back onto the `/`, and the composer closes the menu. To start the composer in normal mode: `vim.enable({ shell: "hydra", selector: ".composer-tiptap", start: "normal" })`.

### Native apps: text-input-v3 (Exo)

Exo implements `zwp_text_input_v3` ([IME.md](IME.md)); GTK 3 and 4, Qt 6, foot and Chromium-based apps (with Wayland IME on) use it. It runs in the browser process, where keys already arrive, with no D-Bus.

What it gives:
- **Focus:** the client enables text input when a field takes focus and disables it when the field loses it.
- **What kind of field it is:** the content type's purpose and hints. `password`, `pin`, `sensitive_data` and `hidden_text` are insert only (Principle 5); `terminal` is off.
- **Text:** the surrounding text (up to about 4 KB around the cursor), with the cursor and anchor, so the selection too. Yank, text objects and reading back where a motion landed all work from it.
- **Edits:** `delete_surrounding_text` and `commit_string`, so `edit` is exact.

What it lacks, and what's done instead:
- **No request moves the cursor or the selection.** `move` sends navigation keys over `wl_keyboard` (Left and Right, Ctrl+Left and Ctrl+Right, Home and End, Up and Down, Ctrl+Home and Ctrl+End, and Shift with them for visual mode). Motions here are **best effort**: nobody expects a native app to behave exactly like vim, and jank is worse than a word boundary in a slightly different place. So:
  - where the surrounding text covers the target, the engine works out the offset itself and sends the Left or Right presses to reach it in one batch (`5w` is one batch, not five motions);
  - it checks the next surrounding-text update once, and corrects once if the cursor is off; then it accepts where the cursor is;
  - where the text doesn't cover the target, or for lines in wrapped text, it uses the toolkit's keys (Ctrl+Right, Up, Down) and accepts the toolkit's idea of words and lines;
  - a budget caps each motion (a first guess: one correction, and no more than about 8 ms waiting on the app), tuned at step 7.
  
  `caps.exactMotions` is false for this backend; operators (`dw`, `ciw`) still use offsets computed from the surrounding text, so what they delete is vim's idea wherever the text is known.
- **No text past 4 KB.** `gg` and `G` use Ctrl+Home and Ctrl+End; searching past the window isn't possible (`caps.wholeText` is false).
- **No undo request.** Undo and redo send Ctrl+Z and Ctrl+Shift+Z (`caps.undo` is `"keys"`). A delete and commit is one edit for most toolkits.
- **No caret shape.** The mode shows in a small badge by the cursor, outside insert mode. The shell draws it (the shell library's `_vimBadge`, from the helper's `vim_mode` notice) over the element that shows the window, at the cursor rectangle the client reports, since a native window is drawn inside the shell's page. A shell can draw its own (`vimmode` event, `preventDefault()`).

**Where the engine runs: in the helper** (`helper/src/vimNative.ts`), the same engine and `init.js` as the pages', in a vm context, sharing the register store directly. Exo (`components/exo/plutonium_vim.cc`) talks to it over the Plutonium DevTools domain:
- **Fields:** each text-input-v3 field that's enabled is announced on every commit (`vimFieldChanged`: its surrounding text, cursor and anchor in UTF-16, content hint and purpose, window, and cursor rectangle), and its end (`vimFieldGone`). Password, PIN, sensitive, hidden-text and terminal fields are never announced.
- **Keys:** Exo's `Keyboard::OnKeyEvent` holds a key the field wants (`setVimHold`: every key outside insert mode; in insert mode Escape, Ctrl+[ and the first keys of `init.js`'s insert mappings), and every key behind it, in order, until `answerVimKey`. A key the engine took is swallowed with its release and repeats (so holding `j` repeats `j` in the engine); one it left goes on to the app through the agents' key path (`EmbeddedWindows::InjectKeyEvents`), its release after it. Super's keys, modifiers, shell shortcuts and keys the IME has are never held. A key not answered in 100 ms goes on by itself, and nothing is held while no helper listens.
- **Order:** a key the engine takes is answered at once. One it leaves is answered once the engine's edits for the keys before it are out, so `cw` then typing puts the typed text after the change. While the engine works, every key waits behind the last.
- **The IME's composition always wins:** while a preedit is showing, vim takes nothing.
- **Edits** are `editVimField`: delete around the cursor and commit, then `done`, one edit the app can undo.
- **Motions** are arrow presses (`dispatchWindowKeyEvents`), counted in graphemes, as toolkits move: one batch, then one correction. An app reports each press in turn, so a motion waits until the app reports the target, or goes quiet for 10 ms after a report, or 60 ms pass; only then does it correct.
- **Undo and redo** are the app's own Ctrl+Z and Ctrl+Shift+Z, with the app's own steps: in GTK a change (`cw`) is a delete and an insert, and `u` takes back the insert first. GTK reports no new state after its undo, so if the app is silent, a Shift+arrow there and back (selecting a character and letting it go) makes it report.
- **Every native field is multi-line** to the engine (the first Escape is vim's): GTK's text views don't send the MULTILINE hint, so its absence says nothing.
- **GTK 4 needs its Wayland input method** to use text-input-v3 at all: the thread environment (`helper/src/threads.ts`) sets `GTK_IM_MODULE=wayland` unless the user chose one (ibus, fcitx).

**A Plutonium extension protocol, later:** `plutonium_text_input_v1` with `set_selection(cursor, anchor)` and the whole text on request. Toolkits won't implement it, but our own clients (the terminal drawer, foot builds we patch) could, and the engine would then use exact motions there.

### Fallback: AT-SPI (the helper)

For apps without text-input-v3: Xwayland apps, older SDL and toolkits, a GTK app without its Wayland input method. The helper (`helper/src/vimAtspi.ts`) listens on the accessibility bus for focus on editable text (`object:state-changed:focused`). For one in a window that has no text-input-v3 field, it asks Exo to hold that window's keys as a text-input-v3 field's are (`Plutonium.setVimWindowField`), and the same engine as native apps' (`vimNative.ts`) runs over an `AtspiBuffer`:
- the text, caret and selection come from `Text`, read again before each key (the app may have changed them);
- motions are exact, by `Text.SetCaretOffset` and `SetSelection`, so `caps.exactMotions` is true here;
- edits are `EditableText.DeleteText` and `InsertText`; undo and redo are the app's Ctrl+Z;
- AT-SPI counts characters (code points), the engine UTF-16 units: the buffer converts;
- password text is never vim's; focus leaving the element ends it;
- every motion and edit is a D-Bus round trip (a read was 1 to 3 ms in GNOME Text Editor), so it's the slowest backend.

The accessibility bus is the session's (`org.a11y.Bus`, at-spi2-core), or `AT_SPI_BUS_ADDRESS` when set.

## Registers

### The store

- **In the helper** (`helper/src/vimRegisters.ts`). Every page's engine, and the vim host (a page too, step 7), share it, so a yank in one tab puts in another, and a yank in a native app will put into a web textarea.
- **In memory only.** Registers hold whatever you yanked, passwords and tokens included, so they never touch the disk: nothing like neovim's shada file. They go when the helper does (a restart, a log out). `"+` is the exception that outlives it, because it's the system clipboard.
- **Each register keeps** its text and whether it's linewise or characterwise. One holds at most 8 MB; a bigger yank is cut.
- **Reads are asynchronous.** `p` is consumed at once, and the text arrives a moment later (a round trip to the helper, about a millisecond). The engine keeps edits in order, so `.` and macros replay correctly.
- **How a page reaches it.** The helper adds a binding, `plutoVimStore`, to each page's DevTools session, named for the engine's world, so the page's own scripts can't call it. The engine's `RemoteStore` (`helper/web/vim/remoteStore.js`) calls it with the register, its scope and the value, and the helper answers in the same world. Where there's no helper (a browser without it, a test), or it doesn't answer in 2 seconds, the page keeps its registers itself.

### Vim's registers on the desktop

| Register | Here |
|---|---|
| `"+` | The system clipboard: Exo's `wl_data_device` selection, what apps' Ctrl+C and Ctrl+V use. Clipboard managers and `wl-copy` see it through `ext_data_control_v1` ([WAYLAND_PROTOCOLS.md](WAYLAND_PROTOCOLS.md)). The helper reads and writes it with `wl-paste` and `wl-copy`; text that ends in a newline is linewise, and a linewise yank gets one. Without wl-clipboard, `"+` is an ordinary register |
| `"*` | The primary selection: what's selected in an app, what middle-click pastes. Exo's own (`zwp_primary_selection_v1`, step 8); the helper reads and writes it with `wl-paste --primary` and `wl-copy --primary`. Always global |
| `""` | The unnamed register. With `vim.opt.clipboard = "unnamedplus"`, it is `"+` |
| `"0`, `"1`–`"9`, `"-` | The last yank, the delete history, and the last small delete, as in vim |
| `"a`–`"z`, `"A`–`"Z` | Named registers (capitals append), scoped by your config |
| `".`, `":`, `"/` | The last inserted text, the last `:` command, the last search |
| `"=` | The expression register, which evaluates JavaScript (in the engine's world, so the page's CSP doesn't apply) instead of vimscript: `"=new Date().toISOString()<CR>p`, or `Ctrl+R =` in insert mode. A promise is waited for, an array is lines (linewise), an object is its JSON. An empty expression puts the last one's value again. It isn't drawn while you type it until the `:` line (step 9); `init.js` can draw it from `CmdlineChanged` |
| `"_` | The black hole |

**Clipboard history** (`vim.opt.clipboardHistory = true`): every copy on the desktop, not only vim's yanks, goes into a ring of its own, newest first, read with `:registers` and put with `"#1`…`"#9` (or `Ctrl+R #1` in insert mode). The helper watches the clipboard with `wl-paste --watch` (Exo's `ext_data_control_v1` hears apps' and pages' copies alike) only while the option is on, and keeps the nine in memory, like the registers; copying the same text again moves it to the front. Ash's own clipboard history is off in shell mode ([CHROME_UI.md](CHROME_UI.md)), so this can be the desktop's.

### Scopes

Each register has a scope: global, project or thread. Your config decides. The defaults are vim's: everything global.

```js
vim.registers.scope("a-z", "global");
vim.registers.scope("t", "thread");     // "t: each thread its own
vim.registers.scope("p", "project");    // "p: each Hydra project its own
vim.registers.scope("0-9", "thread");   // each thread keeps its own yank and delete history
```

- A field's thread is its window's or tab's thread tag. A field in a shell page is in the shell's current thread (Hydra's open thread). A thread's project is Hydra's, for Hydra's threads. A field with no thread (an untagged app) and a thread with no project use global.
- Built so far: tabs' threads. Shell pages, and every project scope, use global until the shell tells the helper its thread and project (step 6).
- `"+` and `"*` are always global: they're the system's.
- `:registers` shows each register's scope.
- Scopes apply to marks too (Across the desktop, below).

### Agents

An agent running in a thread can read and write that thread's registers, and global registers, through two MCP tools (`read_register`, `write_register`; built, step 9). An agent can leave a snippet in `"t` for you to put, or read what you just yanked. Project registers are open to every thread in the project. As with the window tools, the scope is the agent's thread. They go through the helper's socket (`/v1/threads/<thread>/registers/<name>`), with each register's scope from your `init.js`; clipboard history is read-only.

## Across the desktop

- **Marks.** Lowercase marks (`m{a-z}`, `'a`, `` `a ``) are per field, and move with the text as it's edited, whoever edits it. Uppercase marks name a field in a window or tab: the helper keeps them (`helper/src/vimMarks.ts`), and `'A` from anywhere shows that window or tab (asking its shell, as the agents' `focus_window` does), then puts the cursor at the mark in that field, in normal mode. `''` and ` `` ` go back to where the last jump left from. Not yet: scoping marks like registers, and a mark whose window has closed saying so (it does nothing).
- **The jump list** is per field so far: `gg`, `G`, `%`, `{`, `}`, searches and marks are jumps, and Ctrl+O and Ctrl+I go back and forth over them. Across fields, windows and tabs it isn't built.
- **Macros** (`q{register}`, `@{register}`, `@@`, a count, a capital register appends) are the keys as typed, before mappings, kept as a register's text, so they replay in any field and any backend, and `"ap` puts one. In a native field, recording holds every key so typed text is in the macro too.
- **The `:` line** and searches (`/`, `?`, `n`, `N`, `*`, `#`, after an operator too: `d/foo<CR>`) are typed into the engine's command line (`CmdlineChanged`), drawn by the backend's host: under the field on the web (a closed shadow root), and by the shell for native apps (the shell library's badge, which also shows messages and "recording @a"). Commands: `:s` with a range (`%`, `'<,'>` from visual mode, `n`, `n,m`, `.`, `$`) and flags `g` and `i`, vim's `&` and `\1` in the replacement; `:g/pat/d` and `:v/pat/d`; `:n` to go to line n; `:registers`, `:marks` (as messages); `:noh`; commands `init.js` adds (`vim.command`) and a page's (`data-pvim-commands`); `@:` repeats the last. **Patterns are JavaScript regular expressions**, not vim's. Not yet: the desktop's actions (`:Run launcher.open`, `:Thread new`), which wait for KEYS.md's actions.
- **Contexts for the keymap.** The mode (`vimMode == "normal"`) and the field's focus (`editableFocus`) are to be contexts in KEYS.md, so a desktop binding can depend on them. Not yet: KEYS.md's keymap and `config.js` aren't built, and neither is `vim.desktop.call`.

## `init.js`

`~/.pluto/vim/init.js` is an ES module, run in the engine's world: in each frame's isolated world on the web, and in the vim host for native apps. It's your code with your trust (as `config.js` is in KEYS.md), but it isn't Node: it has to answer keys synchronously, in the renderer. Anything that needs the system goes through `vim.desktop.call` to `config.js`, asynchronously.

```js
export default function setup(vim) {
  vim.opt.startInInsert = true;
  vim.opt.clipboard = "unnamedplus";
  vim.opt.inputs = "off";

  vim.keymap.set("i", "jk", "<Esc>");
  vim.keymap.set("n", "Y", "y$");
  vim.keymap.set("n", "gs", () => vim.desktop.call("askAgent", { text: vim.selection() }));

  vim.textobject("u", (buf, around) => buf.matchAround(/https?:\/\/\S+/, around));   // iu, au: a URL
  vim.operator("gq", (buf, range) => buf.edit(range, wrap(buf.slice(range), 80)));
  vim.command("Upper", (buf) => buf.edit(buf.line(), buf.line().text.toUpperCase()));
  vim.keymap.set("n", "<leader>u", "<Cmd>Upper<CR>");

  vim.on("InsertLeave", ({ field }) => { /* … */ });
  vim.disable({ site: "docs.google.com" });
  vim.registers.scope("t", "thread");
}
```

| | |
|---|---|
| `vim.opt` | Options: `startInInsert`, `inputs` (`"manual"`, `"on"`, `"off"`), `clipboard` (`""`, `"unnamedplus"`), `shiftwidth`, `claim`, `timeoutlen`, `mapleader`. Each is checked as it's set; `clipboardHistory`, `whichwrap` and `iskeyword` come with later steps |
| `vim.keymap.set(modes, lhs, rhs, opts)` / `.del` | Mappings, in neovim's notation (`<Esc>`, `<C-w>`, `<leader>`). Modes `"n"`, `"i"`, `"v"` (`"x"` is `"v"`, `""` is both), or a list. `rhs` is keys or a function; `<Cmd>Name args<CR>` runs a command. `opts`: `remap` (default false, as in neovim), `expr` (the function's result is the keys), `nowait`, `desc` |
| `vim.motion(lhs, fn, { kind, arg })` | `fn(buf, { count, hasCount, arg, operator })` returns where the cursor goes, or null. Works after operators too, by `kind`: `"exclusive"`, `"inclusive"`, `"linewise"` |
| `vim.operator(lhs, fn)` | `fn(buf, range, { count, register })` changes the range with `buf.edit()`. Works with motions, text objects, its doubled form (`gqq`), visual mode and `.` |
| `vim.textobject(key, fn)` | `i{key}` and `a{key}`: `fn(buf, around, { count })` returns a range, or null |
| `vim.command(name, fn)` / `vim.cmd(line)` | A command (a capital first letter, as in neovim): `fn(buf, { args, bang })`. Run from a mapping's `<Cmd>…<CR>`, or `vim.cmd`; the `:` line comes at step 9 |
| `vim.on(event, fn)` | Neovim's autocmd events that make sense here: `ModeChanged`, `InsertEnter`, `InsertLeave`, `TextYankPost`, `FieldEnter`, `FieldLeave`, `CmdlineChanged` (`cmdline`: the `:`, `/`, `?` or `"=` line as it's typed, or null), `Message` (`text`), `RecordingChanged` (`register`, or null); `fn` gets `{ field, mode, … }` |
| `vim.registers` | `get` (a promise), `set` (a capital letter appends), `scope` (Scopes, above) |
| `vim.disable` / `vim.enable` | Rules by `site` (a host and its subdomains), `shell`, `selector`, or `app` (native apps, step 7); the last rule that matches wins |
| `vim.mode()`, `vim.selection()`, `vim.feedkeys(keys, { remap })` | In a mapping's function: the field's mode, its selected text (visual mode's, or the field's own), keys into it |
| `vim.desktop.call(name, args)` | A call to a function `config.js` exports; a promise. Rejects until KEYS.md's `config.js` is built |

The `buf` a function gets (`helper/web/vim/userBuffer.js`) is the field's text as offsets: `text`, `cursor`, `slice(range)`, `line(n)` and `lineAt(offset)` (ranges with `text` and `number`), `lineCount`, `search(re, { from, backward })`, `matchAround(re, around)`, and for operators and commands `edit(range, text)` and `move(offset)`. A range is `{ from, to, linewise }`, `to` exclusive.

**Mappings wait as vim's do.** A key that starts a mapping is held, unseen by the page, until the mapping is complete, until a key that can't continue it (then the held keys are typed, in order), or until `timeoutlen` (1000 ms) passes. So with `jk` mapped in insert mode, `j` appears when the next key isn't `k`, or after a second. A held key is dropped if the field loses focus. Normal and visual mappings apply at the start of a command, after a register and a count, not after an operator or `f`, `t`, `r`; operator-pending mappings (`"o"`) aren't supported yet.

Names follow neovim's where the idea is the same (`vim.keymap.set`, `vim.opt`, the event names), so habits carry over. Once plugins exist, this API is a public contract, so it should be settled with the engine, before plugins.

**Plugins** are ES modules `init.js` imports, from `~/.pluto/vim/` (`import surround from "./plugins/surround.js"`). The isolated world has no network access of its own, so a plugin is whatever files you put there, imported by a relative path. The helper bundles them into one script, as it does the engine, and reads `import x / { a, b } / * as ns from "./file.js"`, `export default`, `export function / class / const / let` and `export { a, b }`; anything else (a bare `"lodash"`, a re-export) is an error that says so. Lines stay where they were, so an error names the file's own line.

**Reloading.** Saving anything in `~/.pluto/vim/` checks it first: the helper loads it in Node against the engine, as a page would. A version that loads is committed in `~/.pluto/vim/.git` (made with a starter `init.js` the first time) and goes into every page at once, its old mappings and commands gone. One that throws keeps the last good one running, with a notification of the error; a session that starts with a broken `init.js` runs the newest committed version that loads. `plutonium vim check` is the same dry run: what the config sets up, errors with their file and line, and warnings (a mapping that makes a built-in wait, like `xx` making `x` wait; one mapping that's a prefix of another; something set twice; a built-in replaced).

## Trust

- `init.js` and its plugins run in every frame's isolated world, banking sites and shell pages included, with the DOM. That's the trust an extension that can read every page gets, and that neovim plugins get. It's your code, so that's fine; a plugin someone else wrote is something you choose to install, as with neovim's.
- The page can't reach the engine, `init.js`, or the register store: the world is isolated, and the store's binding is only in that world.
- Registers can hold anything you yanked, including from a page you trust more than others. Thread and project scopes keep them apart if you want that. They're kept in the helper's memory and never written to disk. `"+` is the system clipboard, as every app sees it.
- Password fields: Principle 5.

## The work, in order

1. **The engine** in plain JS, against a fake Buffer, with unit tests: modes, counts, operators, motions, text objects, in-memory registers, `.`, the insert mode extras. No Chromium build, so the engine's shape is settled before any C++.
2. **A stand-in web backend** in page JS (`Selection.modify`, `execCommand`), loaded into a test page and the shell pages. Pluto Vim works in real fields, Hydra's composer included, and shows what only Blink can do.
3. **Blink's key hook and the isolated world** (built, above): the hook in Chromium, the engine in its own world from the helper over DevTools. Since the extensions work's fix-up to patch 0004, `navigator.windowBroker` is null outside a page's main world, so anything the engine needs from the broker (marks that focus a window, `:` commands) goes through the helper, as the register store does (step 5).
4. **The `init.js` API** on the engine: `opt`, `keymap.set`, `motion`, `operator`, `textobject`, `command`, events; reload on save; `plutonium vim check`.
5. **The register store** (built, below) in the helper, in memory only; scopes; `"+` and `"=`.
6. **Pages that integrate** (built, below), and Hydra's composer on it (a T3 patch): actions, `:` commands, yielded keys, starting in normal mode.
7. **text-input-v3** (built, below): the engine in the helper, the async key path, best-effort motions, the mode badge.
8. **`zwp_primary_selection_v1`** in Exo (built, below), for `"*` and middle-click paste.
9. **Across the desktop** (built, below, but for what waits on KEYS.md): marks, the jump list, macros, the `:` line, `vim.desktop.call`, the agents' register tools, clipboard history, the `vimMode` and `editableFocus` contexts in KEYS.md.
10. **AT-SPI** (built, below), for apps without text-input-v3.

### Step 1: the engine (built)

`helper/web/vim/`, plain ES modules with no DOM, so the same files load in a page's isolated world, the vim host and the helper's Node: `engine.js` (modes, the parser, what each command does), `commands.js` (the motions, text objects, operators and actions, as tables), `text.js` (offsets over a string), `registers.js`, `keys.js` (neovim's notation, and DOM key events to it), and `stringBuffer.js`, a Buffer over a string that the tests drive and that shows what a backend must do. Tests: `helper/test/vim.test.ts`.

What it settled:
- **The engine works out offsets; a Buffer only moves to them.** Motions and text objects are functions over the text, and the engine calls `move({ offset })`. The granular `move({ by })` stays in the interface for backends that need it (`gj` over wrapped lines, later) but nothing uses it yet. Native backends turn an offset into key presses (best effort, above).
- **Deciding and doing are split.** `session.feed(key)` answers at once from the mode and the pending keys; the command runs on a queue. The mode a command leaves is set at once too, so the next key is decided right even while the field is still catching up. A backend holds keys the engine didn't take until `session.idle()`, so text typed after `cw` lands after the delete.
- **`u` undoes a whole change.** The engine counts the field's undo steps each change made (its own edits, plus a step for what was typed), and `u` undoes that many. This assumes a field groups a run of typing into one step, as browsers do; step 3 checks it against Blink.
- **`.` replays the command, then the text typed.** What was typed is the difference between the field's text when insert mode started and when it ended, so it works whatever the field did with the keys (an IME, autocorrect).
- **What's not in it yet:** `"=` and `"#n` (step 5), `gv`, macros, search, marks, the `:` line (step 9), and counts on `iw`/`ip` beyond words.

### Step 2: the stand-in web backend (built)

`helper/web/vim/dom.js`: `attach(document)` puts Pluto Vim in every field of a page, in ordinary page JS. The helper serves the engine at `/v1/vim/` (beside `/v1/ui/`), so a shell page loads it with `import("<helper>/v1/vim/dom.js")`. Tests: `helper/test/vimDom.test.ts`, real key events in headless Chromium into a `<textarea>`, an `<input>`, a contenteditable and a ProseMirror editor (from T3 Code's checkout).

- **Keys:** a keydown listener on the window in the bubble phase, so the page's handlers on the field and the document see a key first, and a key one of them took is never vim's. The keys in `vim.opt.claim` (Ctrl+[, and Caps Lock, which is Ctrl+[ to vim) are taken in the capture phase instead, before the page.
- **Text and edits:** an `<input>`'s or `<textarea>`'s value and selection; a contenteditable's text with a line per block and per `<br>` (not the placeholder `<br>` that holds an empty line open), no-break spaces read as spaces. Edits are `execCommand`, so pages get `beforeinput` and `input`. A newline is `insertParagraph`, or `insertLineBreak` first in a field of one paragraph (a composer); whichever the editor keeps, checked after its mutation observer has run (a microtask, still before the next key). At a block's end Chrome adds a second `<br>` to hold the line open, which ProseMirror keeps as a real break, so the extra one is deleted.
- **Editors with a model** (ProseMirror, Lexical) only learn of a selection change on the next `selectionchange`; the backend fires one after each move, or an edit lands at the editor's old selection. Undo and redo are a synthetic Ctrl+Z (Ctrl+Shift+Z, Ctrl+Y) to the editor's own history, falling back to the browser's.
- **The caret:** `caret-shape` (Plutonium's Chromium has it), and `data-pvim-mode` on the field, and `pvim:mode` events.

What it found:
- **Pages take Escape.** ProseMirror's base keymap binds it (select the parent node), and Hydra's composer takes it, so by Principle 1 Escape never reaches vim there, in insert mode or normal. T3 also binds Ctrl+[ (`navigation.back`). Hence `vim.opt.claim`: Ctrl+[ is Pluto Vim's in any field it's on in, before the page, so normal mode is always one key away. Hydra's integration (step 6) gives Escape back in the composer.
- **`u` can't rely on counting the field's undo steps.** ProseMirror's history groups everything within 500 ms into one step, so `u` undoes until the field's text is what it was before the change, and stops when it is. Changes made faster than that (a test, a macro) still undo together in such editors; an editor's integration can close its history group per change.
- **Hydra's composer is one paragraph** (lines are hard breaks; a paragraph split is joined back), so `o` and puts of lines use line breaks there.
- **Hydra's composer groups its own undo history widely:** keys under ~500 ms apart (a script) undo together; at a person's pace `u` undoes one change at a time, as it should.
- **Verified in Hydra's composer** on a slot (Plutonium's Chromium, a release Hydra): Ctrl+[ to normal mode with a block caret, `b`, `dw`, `u`, `cw`, `o`, `yy` and `p`, `dd`, `u u`, `viw` then `U`, `A`; the composer's own text matched the engine's after each.
- **A Blink DCHECK in a dev build:** in two of five runs with spellcheck on, vim's edits in Hydra's composer crashed its renderer, painting a stale spelling marker (`fragment_item.cc:1189`, `start_offset >= StartOffset()`, from `HighlightPainter::PaintOneSpellingGrammarDecoration`). Typing and deleting the same misspelled words without vim didn't. It's intermittent, and never happened in four runs with spellcheck off. Release builds don't check it, so the live desktop paints a wrong underline at worst. Step 3's edits go through the same editing code, so it needs a look there, with a repro.

### Step 3: Blink's key hook and the isolated world (built)

Step 2 showed that the engine needs nothing from Blink to read text, move and edit: the DOM does all of it, from any world. What only Blink can do is give the engine a key **after every handler of the page's and before the field acts on it**. So step 3 is smaller than the design above assumed:

- **Chromium patch 0014, "Pluto Vim's key hook"** (`keyboard_event_manager.cc`, `local_dom_window.cc`; 52 lines, no IDL or mojom). In `KeyboardEventManager::DefaultKeyboardEventHandler`, a keydown no handler cancelled, in a text control or an editable element, and not composing, is first offered as a trusted `plutoniumvimkey` event (a copy of the keydown) at its target. A listener that cancels it takes the key: the keydown counts as default-handled, so Blink's editing doesn't act and its keypress (the text) is suppressed. Nothing is sent unless the window has a listener for it. Adding one gets a `plutoniumvimready` event, a task later, so the engine knows to use the hook.
- **The engine in its own world, from the helper** (`helper/src/vimInject.ts`, `vimBundle.ts`): no Chromium code. The helper bundles `web/vim` into one classic script and adds it to every web page, shell pages and tabs, with `Page.addScriptToEvaluateOnNewDocument` and `worldName: "pluto-vim"` over the browser's DevTools. It keeps a session per page (a script lives as long as its session), and starts again whenever it connects to the browser anew. The page can't see the engine (`window.plutoVim` is undefined in the main world). Off unless the helper has `PLUTONIUM_VIM=1`.
- **Keys:** Ctrl+[ (`vim.opt.claim`) from the window's capture phase, which the engine's world, injected before the page's scripts, is first to register. Everything else from `plutoniumvimkey`, once ready; before that, or in a browser without the patch, from keydown as in step 2.

Verified on a slot (out/Cros, main's series plus 0014; a release Hydra): the engine in Hydra's page in its own world, `plutoniumvimready` received, Ctrl+[ to normal mode, `b dw`, `x`, `u`, `A`, `o`, `k J` in the composer, again after the session restarted. A window keydown listener the page added after the engine took `x`, and vim left it alone, which the step 2 backend couldn't do.

A script added to a page while its document commits reaches neither that document nor, as a new one, the next (Chromium's `runImmediately` misses a document mid-commit), so a tab opened as the helper attached could go without the engine. The injector now auto-attaches to new pages with `waitForDebuggerOnStart`, so mostly the engine is in before the page's own scripts. Waiting doesn't always hold the first commit back, though, so after adding the script it also runs it in the page's world as it is (it skips itself where the engine already is). Every page gets the script, which goes on only in http(s) documents, so a tab that starts at `about:blank` gets it too. Found by step 4's test, which drives a real headless Chromium through the injector.

Not yet: frames inside a page (out-of-process iframes need `Target.setAutoAttach` on each page), registers shared between pages (each world has its own until step 5's store), and Blink-side motions (`gj` over wrapped lines) for later.

### Step 4: `init.js` (built)

- **The API** (`helper/web/vim/api.js`): `configure(vim, setup)` runs `init.js`'s default export on a Vim from its built-ins, so running it again leaves nothing of the last version. Every call is checked and throws with what was wrong. Tests: `helper/test/vimApi.test.ts`.
- **The engine** (`engine.js`): mappings with vim's typeahead (held keys, `timeoutlen`, `remap`, `nowait`, a limit on mappings expanding each other), init.js's motions, operators and text objects in the command tables (ahead of the built-ins, so the same keys are init.js's), commands, and the rules for where Pluto Vim is on. `UserBuffer` (`userBuffer.js`) is what init.js's functions see.
- **The helper** (`helper/src/vimConfig.ts`): bundling `init.js` and its plugins, the dry run, the watched folder and its git, the last good version. The injector carries the good version in each page's script, and a new one into each page's world over DevTools (`Page.createIsolatedWorld` finds the world the page has; a world is its DevTools session's, so it's the injector's session that does it). Tests: `helper/test/vimConfig.test.ts`, including `init.js` in a real Chromium's page, reconfigured live.
- **`plutonium vim check`** (`helper/plutonium.ts vim check`).

### Step 5: the register store (built)

- **The store** (`helper/src/vimRegisters.ts`): registers by scope (global, `thread:<id>`, `project:<id>`) in the helper's memory, never on disk; `"+` through wl-clipboard on the session's Wayland display. Tests: `helper/test/vimRegisters.test.ts`.
- **The pages' side:** the injector adds the `plutoVimStore` binding to each page's session before its script, and answers calls in the engine's world (`vimInject.ts`). A binding named for a world only reaches that world's new documents while `Runtime` is enabled on the session, so it stays enabled; the page's console messages that brings are dropped. The engine's `Registers` passes each register's scope (`vim.registers.scope`) to the store; `RemoteStore` is the store in a page.
- **`"=`** in the engine (`engine.js`): typed after `"=` or Ctrl+R =, evaluated by Enter.
- **Tests in a real Chromium** (`helper/test/vimConfig.test.ts`): a yank in one page puts in another; `"t` scoped to the thread is empty in another thread's tab and shared with the same thread's; the page's main world has no `plutoVimStore`; `"=6*7<CR>p` works on a page whose CSP allows no script.
- **Not yet:** shell pages' threads and projects (step 6), `:registers` (the `:` line, step 9), the agents' register tools (step 9).

### Step 6: pages that integrate (built)

- **The engine** (`engine.js`): `runAction`, the default keys for actions, a page's commands from `<Cmd>`, the menu keys in insert mode; `vim.enable({ …, start })` (`startFor`); `{ action }` mappings (`api.js`); init.js's own options win over a page's start (`userOpts`).
- **The DOM backend** (`dom.js`): each field's `actions`, `commands` and `yields` from its attributes, `pvim:action` to run one, yielded keys claimed before the page.
- **Hydra:** T3 patch 0013 (`shells/hydra/src/patches/`).
- **Tests:** `helper/test/vimApi.test.ts` (actions, commands, menus, `start` rules), `helper/test/vimDom.test.ts` (a page that integrates, in Chromium), `helper/test/vimConfig.test.ts` (the page hears `pvim:action` and `pvim:mode` from the engine's isolated world). In Hydra on an X11 slot, driven over DevTools: the composer declares its actions, a `/` menu adds the menu actions and yields Ctrl+N (which then didn't open a new thread), Ctrl+Y picked the item, and `k` and `j` sent `history.prev` and `history.next`.

### Step 7: native apps over text-input-v3 (built)

- **Chromium** (build 62ca0f70c0b8): `components/exo/plutonium_vim.{h,cc}` and its hook in `Keyboard::OnKeyEvent`, `EmbeddedWindows::WindowIdForSurface` (patch 0002); the text-input-v3 delegate as a Pluto Vim field (patch 0012); `setVimEnabled`, `setVimHold`, `answerVimKey`, `editVimField` and the `vimFieldChanged`, `vimFieldGone`, `vimKey` events (patch 0010).
- **The helper:** `helper/src/vimNative.ts` (the engine in a vm context, a session per field, `NativeBuffer`, holds and answers), wired in `daemon.ts` with the register store and the windows' threads; the badge in the shell library (`_vimBadge`, the `vim_mode` notice). `PLUTONIUM_VIM_DEBUG=1` logs fields, keys, edits and arrows.
- **Tests:** `helper/test/vimNative.test.ts` against a fake Exo that reports each arrow press in turn and stays silent after its undo, as GTK does: holds in each mode, `dw`, `cw` then typing, `jk`, registers, the badge, `u` then `yy` `p`.
- **On an X11 slot** (Xvfb, niri, GNOME Text Editor 50.1 with `GTK_IM_MODULE=wayland`, real keys through Ash with xdotool): typing in insert mode went to the app unchanged; Escape entered normal mode and the shell drew the NORMAL badge; `b` `dw` turned "hello big world" into "hello big "; `0` `cw` `hi` Escape gave "hi big "; `0` `dw` `u` `yy` `p` gave "one two" twice.
- **What testing changed:** the motion waits for the app to arrive or go quiet (its first report, one press of four, had set off a correction that overshot); every native field is multi-line; undo makes a silent app report; GTK needs `GTK_IM_MODULE=wayland`.
- **Not yet:** the badge's place is approximate (GTK's cursor rectangle and the element's scale aren't reconciled), Qt 6 apps, a DRM session with a real keyboard, an IME composing while in normal mode, and the fail-open timeout under a stalled helper (by design; not exercised).

### Step 8: the primary selection (built)

- **Exo** (build bb046202c0ae): `components/exo/wayland/zwp_primary_selection.{h,cc}` (patch 0012), its global in `server.cc` (patch 0002). The browser's clipboard has no primary selection on ChromeOS, so Exo keeps it itself, as other compositors do: the selection is the source client's offer, and a receive goes to that client's send with the same fd. An app's device gets the selection while one of its surfaces has keyboard focus. `ext_data_control_v1`'s primary selection is the same one (it used to cancel every source), so clipboard managers and `wl-copy --primary` see and set it.
- **The engine:** `"*` is a register of its own, no longer `"+`; the helper's store reads and writes it through wl-clipboard's `--primary`.
- **Tested** on X11 slot 50 with GNOME Text Editor: `wl-copy --primary` then `wl-paste --primary` (and the clipboard stayed empty); selecting text in the editor made it the primary selection, read back by `wl-paste --primary`; GTK got wl-copy's offer with its types (`WAYLAND_DEBUG`); `"*yiw` set it, `"*p` put wl-copy's.
- **Not verified:** middle-click paste itself. On Xvfb no pointer button reaches an embedded app (`WINDOW_SIZING.md`); it needs a DRM session with a real mouse.

### Step 9: across the desktop (built, but for KEYS.md's parts)

- **The engine** (`engine.js`, `commands.js`): the command line (`:`, `/`, `?`, `"=`), searches and `n` `N` `*` `#`, ex commands (`:s`, `:g`, `:v`, `:n`, `:registers`, `:marks`, `:noh`, `@:`), macros, marks (lowercase in the field, uppercase through the host), the jump list in a field, `"#1`…`"#9`. Marks and jumps move with the text by comparing what the engine last saw with what's there now.
- **Pages** (`dom.js`, `remoteStore.js`): the line under the field; uppercase marks to the helper (`connectHost`), and `jumpToMark` when it comes back.
- **Native apps** (`vimNative.ts`): the line in the shell's badge; uppercase marks to the helper, and the jump once the window's field is back (a window's field that comes back is in the mode it was in).
- **The helper:** `vimMarks.ts` (uppercase marks; a jump shows the tab or window through its shell), `ClipboardHistory` in `vimRegisters.ts`, the register routes and the agents' `read_register` and `write_register` (`mcp.ts`).
- **Tests:** `vim.test.ts` (search, the `:` line, macros, marks and jumps), `vimNative.test.ts` (`:s`, the line, a macro with typed text, marks, a returning field's mode), `vimRegisters.test.ts` (history), `vimDom.test.ts` (the line under a textarea), `vimConfig.test.ts` (an uppercase mark from one page to another, in Chromium).
- **On X11 slot 50** in GNOME Text Editor: `:%s/a/b/g`; a macro `qqA!<Esc>jq@q`; `"#2p` put the copy before last (two `wl-copy`s); `0mA` in one editor window, then `` `A `` in another brought the first to the front in normal mode, and `x` deleted at the mark.
- **Not yet:** the jump list across fields and windows; scoped marks; the desktop's actions on the `:` line, `vim.desktop.call` and the KEYS.md contexts (they wait for KEYS.md's keymap and `config.js`).

### Step 10: AT-SPI (built)

- **Chromium** (build 6ea5a0aef002): window fields in `components/exo/plutonium_vim.{h,cc}` (patch 0002), `Plutonium.setVimWindowField` (patch 0010).
- **The helper:** `helper/src/vimAtspi.ts` (`AtspiVim`, the focus watcher; `AtspiBuffer`), run by `NativeVim` (`addField`, `removeField`; an AT-SPI field is read again before each key, one key at a time).
- **Tests:** `helper/test/vimAtspi.test.ts` against a fake element that counts in characters: motions, `dw`, `cw` and typing, undo's keys, the app's own changes read again.
- **On X11 slot 50:** GNOME Text Editor with `GTK_IM_MODULE=simple` (so no text-input-v3), a private session bus with at-spi2-core's bus launcher and registry (the host runs none): typed "one two", Escape, `b` `dw` gave "one ", `0` `cw` `uno` Escape gave "uno ".
- **What testing changed:** an AT-SPI field is multi-line to the engine, as native fields are; `AT_SPI_BUS_ADDRESS` is honoured (the session's bus proxy doesn't activate `org.a11y.Bus`).
- **Not yet:** an Xwayland app (its windows are its satellite's, so the field's window is the focused one); the badge's place (AT-SPI's caret rectangle isn't read); hosts without at-spi2-core (nothing is found: install it, or set `AT_SPI_BUS_ADDRESS`).

### Caps Lock (built)

A Plutonium shell has no Caps Lock. Ash makes the key an Escape that keeps its code (`key: "Escape"`, `keyCode` 27, `code: "CapsLock"`), so Pluto Vim can tell it from the Escape key:
- **In a field Pluto Vim is on in,** it's Ctrl+[ to the engine (`keyFromEvent`), so it's claimed before the page and enters normal mode even where the page takes Escape (Hydra's composer, ProseMirror). The Escape key stays the page's first.
- **Everywhere else,** pages see an Escape (a page that reads `code` sees `CapsLock`), and native apps get the Escape key: Exo gives them the Escape key's code, not Caps Lock's.
- **Chromium:** `KeyboardModifierEventRewriter::RemapPressKey` in shell mode (patch 0006), ahead of the user's modifier remapping, so `CapsLockEventRewriter` never toggles the lock; `ClientCode` in `components/exo/keyboard.cc` (patch 0002). There is no way to turn Caps Lock on.


## Decisions

- 2026-11-08: the name is **Pluto Vim** (`pvim` where pages see it, `plutonium_vim` in Chromium). Kerberos, a moon of Pluto, was considered and dropped: Chromium's ash already has Kerberos authentication code, and the clash would muddy search and patches.
- 2026-11-08: single-line inputs start in insert mode, Escape stays the page's, and Ctrl+[ enters normal mode (`vim.opt.inputs = "manual"`). Insert mode gets extras (Ctrl+R {register}, Ctrl+O) in every field.
- 2026-11-08: Hydra's composer integrates properly rather than relying on Principle 1: it can start in normal mode, Enter sends from either mode, and everything it does is reachable from normal mode and the `:` line. The protocol is open to any page.
- 2026-11-08: clipboard history is `"#1`…`"#9`. `"#` is vim's alternate file register, which has no meaning here yet; it can move if something comes along that maps onto it.
- 2026-11-08 (to confirm): Ctrl+[ is Pluto Vim's before the page in a field it's on in (`vim.opt.claim`), because ProseMirror and Hydra's composer take Escape and T3 takes Ctrl+[.
- 2026-11-08: Caps Lock is Pluto Vim's Escape, and there's no Caps Lock: Ash makes it an Escape with code `CapsLock`, which the engine claims before the page as Ctrl+[, and everything else sees as Escape. Nobody uses Caps Lock as a lock.
- 2026-11-08: a saved `init.js` goes into every page at once, not at each frame's next field focus: the helper checks it in Node first, so a page never runs one that doesn't load. Mappings follow neovim's (`remap` off by default, `<Cmd>`, `expr`, `nowait`); operator-pending mappings wait.
- 2026-11-08: the register store is the helper's, in memory only. Registers hold whatever was yanked, passwords included, so they never go to disk, and they don't survive the helper. The helper rather than the browser process, because the engine already reaches pages through the helper's DevTools sessions, it knows threads, and it needs no Chromium change; the vim host for native apps (step 7) is a page and reaches it the same way.
- 2026-11-09: the page protocol's names are settled with Hydra's integration (`data-pvim-start`, `-actions`, `-commands`, `-yield`, `-mode`; `pvim:mode`, `pvim:action`). `data-pvim-yield` takes vim's notation and holds while the page declares it, in any mode, rather than "in normal mode": the page knows its own state (Hydra's menu) better than a fixed rule.
- 2026-11-09: "Composer starts in normal mode" is a config rule (`vim.enable({ shell, selector, start })`), not a Hydra setting: it's where every other vim choice lives, and it works for any site's fields.
- 2026-11-09: a page's menus are driven from insert mode with vim's completion keys (Ctrl+N, Ctrl+P, Ctrl+Y, Ctrl+E), not `j`, `k` and Enter in normal mode: the menu belongs to the text being typed, and entering normal mode moves the cursor off its trigger.
- 2026-11-09: native apps' engine runs in the helper, not in a "vim host" page in the browser: the helper already has the engine, `init.js` and the register store, the DevTools domain already connects it to Exo, and there's no extra renderer. A held key costs one round trip on a local socket.
- 2026-11-09 (open question 1): in native apps, insert mode takes only Escape, Ctrl+[ (Caps Lock) and the first keys of `init.js`'s insert mappings. Ctrl+R, Ctrl+O, Ctrl+W and Ctrl+U stay the app's: they're common app keys (Ctrl+W closes, Ctrl+R reloads), and native fields have their own word and line deletion.
- 2026-11-09 (open question 2): the motion budget is one batch of arrows, one correction, and 25 ms waiting on the app each; a held key the helper doesn't answer in 100 ms goes on to the app.
- 2026-11-09: the native mode badge is the shell's to draw, over the element showing the window: a native window is drawn inside the shell page, so the browser can't place it on screen by itself.
- 2026-11-09: searches and `:s` take JavaScript regular expressions, not vim's: it's the language `init.js` is written in, and a second regex dialect in the engine would be a large, buggy translation. Replacements keep vim's `&` and `\1`.
- 2026-11-09: clipboard history is watched only while `vim.opt.clipboardHistory` is on, and kept in the helper's memory, like the registers.
- 2026-11-08: native motions are best effort, balancing accuracy against round trips: one batch, one correction, a time budget.

## Open questions

