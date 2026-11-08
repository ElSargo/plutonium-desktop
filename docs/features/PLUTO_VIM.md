# Pluto Vim: vim mode in every text field, one engine, JS for config

**Status: steps 1–3 built: the engine, the web backend, and Blink's key hook with the engine in its own isolated world, off unless `PLUTONIUM_VIM=1`; tested in Chromium and in Hydra's composer on a slot** (2026-11-08). Pluto Vim is the desktop's vim mode. Its names: `~/.pluto/vim/` for the config, `plutonium vim` for the CLI, `plutonium_vim` / `PlutoniumVim` inside Chromium (as `plutonium_keys.cc`), and the short `pvim` where pages can see it (`data-pvim-*` attributes, `pvim:*` events), so it can't clash with a page's own vim (CodeMirror's, Monaco's). Inside `init.js` the API is `vim` (the argument `setup` gets), so neovim habits carry over. The goals:
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
                │          register store, marks, jumps   │
                └──────────────► browser process ◄────────┘
                                       ⇅
                     helper: persistence, thread and project scopes,
                     config.js (KEYS.md), agents' tools
```

- **The engine** (modes, counts, operators, motions, text objects, registers, macros, the `:` line) is JavaScript. It is shipped as the default runtime, like neovim's `runtime/`, and `init.js` can change or replace any part of it.
- **A backend** gives the engine a field as a buffer (Buffer interface, below). Blink is one backend, text-input-v3 another, and AT-SPI a fallback.
- **The register store** is in the browser process, so every backend shares it. The helper persists it and knows each field's thread and project.

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
- **`data-pvim-start="normal" | "insert"`**: the page's default starting mode. Your config overrides it (`vim.opt.startInInsert`, per field or site).
- **`pvim:mode` events** on the field, with `{ mode }`, whenever the mode changes. The page uses them to show the mode and to decide what its own keys do: in Hydra, Enter sends from normal mode and from insert mode, and Shift+Enter is a newline in insert mode.
- **`data-pvim-actions="submit history.prev history.next menu.open …"`**: what the field can do that isn't editing text. The engine runs one by dispatching `pvim:action` with `{ name }`. Default normal-mode keys map onto the common ones: Enter → `submit`, `k` on the first line and `j` on the last → `history.prev` and `history.next`; `init.js` maps the rest (`vim.keymap.set("n", "<leader>m", { action: "model.pick" })`).
- **`:` commands** a page declares the same way (`data-pvim-commands="model attach stash"`) appear in the `:` line's completion and run as actions: `:model`, `:attach`, `:stash`.
- **Keys the page gives up.** A page that integrates can tell the engine which of its keydown handlers yield in normal mode (`data-pvim-yield="Escape ArrowUp ArrowDown"`), so `j`, `k` and Escape do vim's thing there instead of the page's.

For Hydra this is a T3 patch: the composer declares its actions (send, history, the slash and mention menus, the model picker, attachments, stash) and listens for `pvim:mode`. Its menus (`/` commands, `@` mentions) work from normal mode with `j`, `k` and Enter while they're open. The settings get "Composer starts in normal mode".

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
- **No caret shape.** The mode shows in a small badge by the cursor, drawn by the browser at the text-input cursor rectangle the client reports.

**Where the engine runs.** One background "vim host" page in the browser, running the same engine and `init.js` (in an isolated world of its own). Exo already holds a key while an IME answers asynchronously, and passes it on after ([IME.md](IME.md), patch 0065). Vim is a stage in that same path:
- in normal mode, the key goes to the vim host, which consumes it, typically within a millisecond;
- in insert mode, keys go on to the real IME unchanged, so a Chinese IME composes as before, and vim only sees Escape and the keys it maps;
- the IME's own composition always wins: while a preedit is showing, vim takes nothing.

**A Plutonium extension protocol, later:** `plutonium_text_input_v1` with `set_selection(cursor, anchor)` and the whole text on request. Toolkits won't implement it, but our own clients (the terminal drawer, foot builds we patch) could, and the engine would then use exact motions there.

### Fallback: AT-SPI (the helper)

For apps without text-input-v3: Xwayland apps, older SDL and toolkits. The helper's AT-SPI client (`helper/src/a11y.ts`) reads and sets the caret and selection (`Text`) and edits (`EditableText`). The engine runs in the helper's Node process (the same JS). Every motion is a D-Bus round trip, so it's the slowest backend, and it waits until the other two are done.

## Registers

### The store

- **In the browser process.** The web engine (in every frame) and the vim host share it, so a yank in a native app puts into a web textarea, and the reverse.
- **Persisted by the helper,** in `~/.pluto/vim/registers.json`, as neovim's shada file does. Registers survive restarts. Each register keeps its text and whether it's linewise or characterwise.
- **Reads are asynchronous.** `p` is consumed at once, and the text arrives a moment later. The engine keeps edits in order, so `.` and macros replay correctly.

### Vim's registers on the desktop

| Register | Here |
|---|---|
| `"+` | The system clipboard: Exo's `wl_data_device` selection, what apps' Ctrl+C and Ctrl+V use. Clipboard managers and `wl-copy` see it through `ext_data_control_v1` ([WAYLAND_PROTOCOLS.md](WAYLAND_PROTOCOLS.md)) |
| `"*` | The primary selection. Exo has none yet: implementing `zwp_primary_selection_v1` gives apps middle-click paste and gives `"*` its meaning (until then, `"*` is `"+`, as on systems without one) |
| `""` | The unnamed register. With `vim.opt.clipboard = "unnamedplus"`, it is `"+` |
| `"0`, `"1`–`"9`, `"-` | The last yank, the delete history, and the last small delete, as in vim |
| `"a`–`"z`, `"A`–`"Z` | Named registers (capitals append), scoped by your config |
| `".`, `":`, `"/` | The last inserted text, the last `:` command, the last search |
| `"=` | The expression register, which evaluates JavaScript (in the engine's world) instead of vimscript: `"=new Date().toISOString()<CR>p` |
| `"_` | The black hole |

**Clipboard history** (`vim.opt.clipboardHistory = true`): every copy on the desktop, not only vim's yanks, goes into a ring of its own, read with `:registers` and put with `"#1`…`"#9`. The compositor sees every clipboard change, so this covers copies from apps and pages. Ash's own clipboard history is off in shell mode ([CHROME_UI.md](CHROME_UI.md)), so this can be the desktop's.

### Scopes

Each register has a scope: global, project or thread. Your config decides. The defaults are vim's: everything global.

```js
vim.registers.scope("a-z", "global");
vim.registers.scope("t", "thread");     // "t: each thread its own
vim.registers.scope("p", "project");    // "p: each Hydra project its own
vim.registers.scope("0-9", "thread");   // each thread keeps its own yank and delete history
```

- A field's thread is its window's or tab's thread tag. A field in a shell page is in the shell's current thread (Hydra's open thread). A thread's project is Hydra's, for Hydra's threads. A field with no thread (an untagged app) and a thread with no project use global.
- `"+` and `"*` are always global: they're the system's.
- `:registers` shows each register's scope.
- Scopes apply to marks too (Across the desktop, below).

### Agents

An agent running in a thread can read and write that thread's registers, and global registers, through two MCP tools (`read_register`, `write_register`). An agent can leave a snippet in `"t` for you to put, or read what you just yanked. Project registers are open to every thread in the project. As with the window tools, the scope is the agent's thread.

## Across the desktop

- **Marks.** Lowercase marks are per field. Uppercase marks name a field in a window or tab: `'A` focuses that window or tab (in its shell, through the broker), then that field, then the position. A mark whose window has closed says so. Marks can be scoped like registers.
- **The jump list** spans fields, windows and tabs: Ctrl+O and Ctrl+I go back and forth across apps.
- **Macros** are register contents, so they replay in any field and any backend.
- **The `:` line.** Vim's commands (`:s`, `:g` in a field, `:registers`, `:marks`, `:noh`), commands `init.js` adds (`vim.command`), and the desktop's actions ([KEYS.md](KEYS.md)): `:Run launcher.open`, `:Thread new`. It's drawn by the backend's host: by the field on the web, and by the visible shell for native apps (through the shell library).
- **Contexts for the keymap.** The mode (`vimMode == "normal"`) and the field's focus (`editableFocus`) are contexts in KEYS.md, so a desktop binding can depend on them.

## `init.js`

`~/.pluto/vim/init.js` is an ES module, run in the engine's world: in each frame's isolated world on the web, and in the vim host for native apps. It's your code with your trust (as `config.js` is in KEYS.md), but it isn't Node: it has to answer keys synchronously, in the renderer. Anything that needs the system goes through `vim.desktop.call` to `config.js`, asynchronously.

```js
export default function setup(vim) {
  vim.opt.startInInsert = true;
  vim.opt.clipboard = "unnamedplus";
  vim.opt.inputs = false;

  vim.keymap.set("i", "jk", "<Esc>");
  vim.keymap.set("n", "Y", "y$");
  vim.keymap.set("n", "gs", () => vim.desktop.call("askAgent", { text: vim.selection() }));

  vim.textobject("u", (buf, around) => buf.matchAround(/https?:\/\/\S+/, around));   // iu, au: a URL
  vim.operator("gq", (buf, range) => buf.edit(range, wrap(buf.slice(range), 80)));
  vim.command("Upper", (buf) => buf.edit(buf.line(), buf.line().text.toUpperCase()));

  vim.on("InsertLeave", ({ field }) => { /* … */ });
  vim.disable({ site: "docs.google.com" });
  vim.registers.scope("t", "thread");
}
```

| | |
|---|---|
| `vim.opt` | Options: `startInInsert`, `clipboard`, `clipboardHistory`, `inputs`, `timeoutlen`, `whichwrap`, `iskeyword`, … |
| `vim.keymap.set(modes, lhs, rhs, opts)` / `.del` | Mappings, in neovim's notation (`<Esc>`, `<C-w>`, `<leader>`); `rhs` is keys or a function |
| `vim.motion`, `vim.operator`, `vim.textobject` | New ones, as functions over the Buffer |
| `vim.command(name, fn)` | A `:` command |
| `vim.on(event, fn)` | Neovim's autocmd events that make sense here: `ModeChanged`, `InsertEnter`, `InsertLeave`, `TextYankPost`, `FieldEnter`, `FieldLeave` |
| `vim.registers` | `get`, `set`, `scope` |
| `vim.disable` / `vim.enable` | By site, app id, shell, or field selector |
| `vim.desktop.call(name, args)` | A call to a function `config.js` exports; a promise |

Names follow neovim's where the idea is the same (`vim.keymap.set`, `vim.opt`, the event names), so habits carry over. Once plugins exist, this API is a public contract, so it should be settled with the engine, before plugins.

**Plugins** are ES modules `init.js` imports, from `~/.pluto/vim/` (`import surround from "./plugins/surround.js"`). The isolated world has no network access of its own, so a plugin is whatever files you put there.

**Reloading.** Saving `init.js` reloads it: in the vim host at once, and in each frame's world at its next field focus. An `init.js` that throws while loading is replaced by the last good one, with a notification of the error, and good versions are committed in `~/.pluto/vim/.git`, as for `config.js`. `plutonium vim check` loads it in a dry run and reports errors and mapping conflicts.

## Trust

- `init.js` and its plugins run in every frame's isolated world, banking sites and shell pages included, with the DOM. That's the trust an extension that can read every page gets, and that neovim plugins get. It's your code, so that's fine; a plugin someone else wrote is something you choose to install, as with neovim's.
- The page can't reach the engine, `init.js`, or the register store: the world is isolated, and the store's IPC is only bound to that world.
- Registers can hold anything you yanked, including from a page you trust more than others. Thread and project scopes keep them apart if you want that. `"+` is the system clipboard, as every app sees it.
- Password fields: Principle 5.

## The work, in order

1. **The engine** in plain JS, against a fake Buffer, with unit tests: modes, counts, operators, motions, text objects, in-memory registers, `.`, the insert mode extras. No Chromium build, so the engine's shape is settled before any C++.
2. **A stand-in web backend** in page JS (`Selection.modify`, `execCommand`), loaded into a test page and the shell pages. Pluto Vim works in real fields, Hydra's composer included, and shows what only Blink can do.
3. **Blink's key hook and the isolated world** (built, above): the hook in Chromium, the engine in its own world from the helper over DevTools. Since the extensions work's fix-up to patch 0004, `navigator.windowBroker` is null outside a page's main world, so anything the engine needs from the broker (marks that focus a window, `:` commands) goes through the register store's browser-side IPC instead.
4. **The `init.js` API** on the engine: `opt`, `keymap.set`, `motion`, `operator`, `textobject`, `command`, events; reload on save; `plutonium vim check`.
5. **The register store** in the browser process, persisted by the helper; scopes; `"+` and `"=`.
6. **Pages that integrate,** and Hydra's composer on it (a T3 patch): actions, `:` commands, yielded keys, starting in normal mode.
7. **text-input-v3:** the vim host page, the async key path, best-effort motions, the mode badge, the native insert mode extras.
8. **`zwp_primary_selection_v1`** in Exo, for `"*` and middle-click paste.
9. **Across the desktop:** marks, the jump list, macros, the `:` line, `vim.desktop.call`, the agents' register tools, clipboard history, the `vimMode` and `editableFocus` contexts in KEYS.md.
10. **AT-SPI,** for apps without text-input-v3.

### Step 1: the engine (built)

`helper/web/vim/`, plain ES modules with no DOM, so the same files load in a page's isolated world, the vim host and the helper's Node: `engine.js` (modes, the parser, what each command does), `commands.js` (the motions, text objects, operators and actions, as tables), `text.js` (offsets over a string), `registers.js`, `keys.js` (neovim's notation, and DOM key events to it), and `stringBuffer.js`, a Buffer over a string that the tests drive and that shows what a backend must do. Tests: `helper/test/vim.test.ts`.

What it settled:
- **The engine works out offsets; a Buffer only moves to them.** Motions and text objects are functions over the text, and the engine calls `move({ offset })`. The granular `move({ by })` stays in the interface for backends that need it (`gj` over wrapped lines, later) but nothing uses it yet. Native backends turn an offset into key presses (best effort, above).
- **Deciding and doing are split.** `session.feed(key)` answers at once from the mode and the pending keys; the command runs on a queue. The mode a command leaves is set at once too, so the next key is decided right even while the field is still catching up. A backend holds keys the engine didn't take until `session.idle()`, so text typed after `cw` lands after the delete.
- **`u` undoes a whole change.** The engine counts the field's undo steps each change made (its own edits, plus a step for what was typed), and `u` undoes that many. This assumes a field groups a run of typing into one step, as browsers do; step 3 checks it against Blink.
- **`.` replays the command, then the text typed.** What was typed is the difference between the field's text when insert mode started and when it ended, so it works whatever the field did with the keys (an IME, autocorrect).
- **What's not in it yet:** user mappings (`jk`, step 4), `"=` and `"#n` (step 5), `gv`, macros, search, marks, the `:` line (step 9), and counts on `iw`/`ip` beyond words.

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

### Caps Lock (built)

A Plutonium shell has no Caps Lock. Ash makes the key an Escape that keeps its code (`key: "Escape"`, `keyCode` 27, `code: "CapsLock"`), so Pluto Vim can tell it from the Escape key:
- **In a field Pluto Vim is on in,** it's Ctrl+[ to the engine (`keyFromEvent`), so it's claimed before the page and enters normal mode even where the page takes Escape (Hydra's composer, ProseMirror). The Escape key stays the page's first.
- **Everywhere else,** pages see an Escape (a page that reads `code` sees `CapsLock`), and native apps get the Escape key: Exo gives them the Escape key's code, not Caps Lock's.
- **Chromium:** `KeyboardModifierEventRewriter::RemapPressKey` in shell mode (patch 0006), ahead of the user's modifier remapping, so `CapsLockEventRewriter` never toggles the lock; `ClientCode` in `components/exo/keyboard.cc` (patch 0002). There is no way to turn Caps Lock on.

Not yet: frames inside a page (out-of-process iframes need `Target.setAutoAttach` on each page), registers shared between pages (each world has its own until step 5's store), and Blink-side motions (`gj` over wrapped lines) for later.

## Decisions

- 2026-11-08: the name is **Pluto Vim** (`pvim` where pages see it, `plutonium_vim` in Chromium). Kerberos, a moon of Pluto, was considered and dropped: Chromium's ash already has Kerberos authentication code, and the clash would muddy search and patches.
- 2026-11-08: single-line inputs start in insert mode, Escape stays the page's, and Ctrl+[ enters normal mode (`vim.opt.inputs = "manual"`). Insert mode gets extras (Ctrl+R {register}, Ctrl+O) in every field.
- 2026-11-08: Hydra's composer integrates properly rather than relying on Principle 1: it can start in normal mode, Enter sends from either mode, and everything it does is reachable from normal mode and the `:` line. The protocol is open to any page.
- 2026-11-08: clipboard history is `"#1`…`"#9`. `"#` is vim's alternate file register, which has no meaning here yet; it can move if something comes along that maps onto it.
- 2026-11-08 (to confirm): Ctrl+[ is Pluto Vim's before the page in a field it's on in (`vim.opt.claim`), because ProseMirror and Hydra's composer take Escape and T3 takes Ctrl+[.
- 2026-11-08: Caps Lock is Pluto Vim's Escape, and there's no Caps Lock: Ash makes it an Escape with code `CapsLock`, which the engine claims before the page as Ctrl+[, and everything else sees as Escape. Nobody uses Caps Lock as a lock.
- 2026-11-08: native motions are best effort, balancing accuracy against round trips: one batch, one correction, a time budget.

## Open questions

1. **Ctrl+R and Ctrl+O in native apps.** Taking them in insert mode hides the app's own keys; which ones to take by default (step 7).
2. **The motion budget** for native apps: how many milliseconds and corrections before accepting the toolkit's cursor (step 7).
3. **Page protocol names.** `data-pvim-*` and `pvim:*` become a public contract once pages other than ours use them; settle them with Hydra's integration (step 6).
