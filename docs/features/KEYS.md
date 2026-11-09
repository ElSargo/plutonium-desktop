# Keys: one keymap, contexts, chords and a config script

**Status: step 1 built (Hydra's keys on Super, 2026-11-09); the rest is design** (2026-11-08; revised 2026-11-09 for Pluto Vim, which is built, and [HYDRA_KEYBOARD.md](HYDRA_KEYBOARD.md)). This is the plumbing: where keys are decided, which ones the desktop owns, and how they're configured. What the keys do inside fields and in Hydra's UI is PLUTO_VIM.md and HYDRA_KEYBOARD.md. The goals:
- every shell and the browser use one set of actions, with one set of default keys, so rebinding an action rebinds it everywhere;
- Hydra puts what acts on the desktop on Super, and gives Ctrl and Alt back to the apps and tabs in its panel;
- bindings can depend on context (which app has the keyboard, a mode, state a script sets);
- chords and modes ("Super+G, then W"; a resize mode until Escape), with an overlay listing what comes next;
- a config script, `~/.pluto/config.js`, run as you with all of Node, for anything a table of keys can't say. This is qtile's model: a config file in the compositor's language, with callbacks.

## Today

Keys are handled in four places, each with its own spelling of a combination:

| Layer | What | Rebinding | Spelling |
|---|---|---|---|
| The browser (`chrome/browser/plutonium_keys.cc`) | Super+Tab, Super+F, Super+Escape, Super+L, Super+Shift(+Ctrl)+arrows, VTs, media keys | None: built in | `ui::KeyboardCode` |
| Styx, Charon, plain | The UI library's `Keymap` (`helper/web/ui/keys.js`): actions with default keys, the user's overrides, conflicts, which combos to register | The key editor, kept in **each shell's own storage** | `Super+Ctrl+Alt+Shift+<code>` |
| Hydra | T3's keybindings (`~/.t3/keybindings.json`), with `when` clauses and, for the file manager only, one-key prefixes (`g g`) | T3's settings and file | `mod+shift+t` (a key, not a code) |
| Apps (`helper/src/shortcuts.ts`) | Global shortcuts apps bind through the portal | The binder dialog | `CTRL+SHIFT+t` (an XKB keysym) |

A fifth layer, inside text fields: **Pluto Vim** ([PLUTO_VIM.md](PLUTO_VIM.md)), with its own sequence matcher (mappings that wait, `timeoutlen`, counts), its own config (`~/.pluto/vim/init.js`) and vim's notation (`<C-w>`, a character, not a code).

Ash also rewrites one key for everything: **Caps Lock is an Escape** that keeps its code, for Pluto Vim (PLUTO_VIM.md, "Caps Lock"). There's no Caps Lock.

The shells' own keys reach the page through `setShellShortcuts(list)`. That's a flat list of combos the browser takes from whatever has the keyboard, with no condition. The dock's actions are shared code (`defineDockActions`), but each shell keeps its own copy of the user's keys.

What goes wrong:
- **The same action has different keys in different shells.** The launcher is Super+D in Styx, Super+Space in Hydra, and Super tap / Super+A / Alt+F2 in Charon. Closing a window is Super+Q in Styx and Alt+F4 in Charon; in Hydra, closing a panel tab is Ctrl+W, and only from Hydra's own page.
- **Hydra takes keys apps need.** Alt+1…9, Ctrl+Tab, Ctrl+Shift+Tab and Ctrl+T are registered as shell shortcuts. Firefox, kitty, a browser tab, irssi and editors in the panel never see them.
- **Conflicts across layers aren't visible.** The browser's Super+L locks the screen, and Styx's Super+L focuses right. Styx's Super+O is the overview, and Hydra's Super+O picks up a file. niri's Super+F had to move to Super+M because the browser keeps Super+F.
- **Rebinding is per shell.** Moving the launcher in Styx doesn't move it in Charon.
- **No conditions outside Hydra's page, and no chords.** A shell shortcut is taken from every app, including a game or a VM that wants Super.

## Principles

1. **Super is the desktop's.** A combo with Super acts on the desktop, a shell, a workspace or thread, or a window. Those are shell shortcuts, so they work whatever has the keyboard.
2. **Everything else belongs to what has the keyboard.** A shell never takes a combo without Super from an app or a tab. The exceptions are a short, fixed list of desktop keys with no Super in them: the media, volume and brightness keys, Print (screenshots), Ctrl+Alt+F1…F12, and Ctrl+Alt+Backspace. A shell may also keep its paradigm's classic keys as extra keys for an action (Charon's Alt+Tab and Alt+F4), but never as the only key.
3. **One action, one default key, in every shell, unless a shell has a good reason.** These are defaults, not rules: an action a shell doesn't have is normally left unbound there, and its key isn't reused, but a shell may give a shared key to its own action when its paradigm needs it (Charon's Super+arrows tile, as in GNOME). Each exception is listed in the defaults table, and the key editor marks it. A shell's other actions (Styx's column widths, Hydra's composer) use keys no shared action uses.
4. **H/J/K/L are the arrows.** Every default with an arrow key has the same binding with H, J, K or L in its place (Super+← and Super+H, Super+Ctrl+↓ and Super+Ctrl+J), in every shell, so arrow users and vim users both get their keys. The catalogue generates the twins; rebinding an arrow binding offers to rebind its twin too.
5. **One place for the user's keys:** `~/.pluto/keys.json`, read by every shell and by the browser. A rebinding applies to every shell, unless it's scoped to one.
6. **The decision to take a key is synchronous; what the key does may be asynchronous.** The browser decides from a table, with no script in the key path. A stuck script can't freeze the keyboard.
7. **There are keys no config can take away:** Ctrl+Alt+Backspace (end the session), Ctrl+Alt+F1…F12 (VTs), and the lock screen's keys. Super+Tab and Super+Shift+F can be moved but not unbound, so a broken config always leaves a way to switch shells and to leave fullscreen.
8. **The order a key goes through:** (1) the browser's own keys; (2) shell shortcuts (Super combos, and the fixed list in Principle 2); (3) keys Pluto Vim claims before the page in a field it's on in (Escape, Ctrl+[, Caps Lock, keys a page yields); (4) the page's own handlers; (5) Pluto Vim; (6) the field's default. Conflict checks cover every layer, Pluto Vim's claims and insert-mode mappings included (a `jk` mapping holds `j` in every field).

## The keymap

### Spelling

One spelling everywhere: the UI library's `Super+Ctrl+Alt+Shift+<KeyboardEvent.code>` (`Super+Shift+KeyP`). Codes are physical keys, so Super+1 and Super+H stay where they are on any layout. In `keys.json` and `config.js`, short forms are accepted and normalized: `super+shift+p`, `Super+/`.

A chord is combos separated by spaces: `Super+KeyG KeyW`. T3's `g g` is the same thing with no modifier on the first key. Hydra's patch converts at its edge. T3's own file keeps its spelling, and the desktop's shared actions come from `keys.json`.

**Vim's notation is accepted too, by the same parser:** `<D-d>` is Super+D (neovim's spelling for the Super or Cmd key), `<C-S-p>` Ctrl+Shift+P. The two keep their meanings: a combo with Super is matched by its code (the physical key, for any layout), and a key in a Pluto Vim mapping by the character it types. One parser and one set of names, so you write one notation, and `config.js` and `init.js` read the same.

### Actions

An action has:
- an id, `scope.name` (`window.close`, `dock.slot.3`, `hydra.composer.stash`);
- a title and a group, for the key editor and the overlay;
- default keys;
- a context it runs in (`when`, below);
- whether a held key repeats it.

Shared actions are defined once, in a catalogue the UI library ships (`helper/web/ui/actions.js`). A shell says which of them it implements (`keymap.implement("window.close", run)`). Shell-specific actions use the shell's prefix: `styx.`, `charon.`, `hydra.`.

The browser's built-in keys become actions in the catalogue too (`shells.switcher`, `window.fullscreen`, `pointer.release`, `screen.lock`, `display.focusLeft`, …). The browser takes its keys from the helper (`Plutonium.setBrowserKeys`) instead of hardcoding them, and keeps today's keys as defaults until the helper sends any.

### Default keys

These merge niri's (Styx), GNOME's (Charon) and Hydra's keys. **Bold** marks a change from today. "—" means the shell doesn't have the action, and the key does nothing there.

| Action | Key | Styx | Charon | Hydra |
|---|---|---|---|---|
| `shells.switcher` | Super+Tab | ✓ | ✓ | ✓ |
| `window.maximize` | Super+F (since 2026-11-08, `CONTROLS.md`, "Maximize"): the shell decides what maximized means | ✓ (the column) | ✓ (tiled to the work area) | ✓ (the panel) |
| `window.fullscreen` | Super+Shift+F (Super+F until 2026-11-08) | ✓ | ✓ | ✓ |
| `pointer.release` | Super+Escape | ✓ | ✓ | ✓ |
| `screen.lock` | **Super+Alt+Shift+L** (hard to press by accident; frees Super+L for focus) | **was Super+Alt+L** | **was Super+L** | **was Super+L** |
| `display.focus{Left,Right}` / `window.toDisplay{…}` | Super+Shift+←/→ or H/L / Super+Ctrl+Shift+←/→ or H/L | ✓ | H/L **new** | H/L **new** |
| `keys.help` (the overlay of every key) | Super+Shift+/ | ✓ | **new** | **new** |
| `launcher.open` | Super+Space and Super+D | Super+Space **new** | **was Super+A** (Super tap stays the overview); GNOME's show-desktop on Super+D moves to Super+Ctrl+D | Super+D **new** |
| `terminal.new` | Super+T | ✓ | **new** | **new**: a terminal in the thread's drawer |
| `tab.new` (a browser tab, address bar focused) | **Super+B** | **new** | **new** | **was Ctrl+T** |
| `files.open` | Super+E | **new**: Plutonium's file manager, or the default one | **new** | ✓ (Ctrl+E stays, page only) |
| `files.find` / `files.findHome` | Super+P / Super+Shift+P | **new** | **new** | ✓ |
| `files.carry` | **Super+Y**, Super+Shift+Y on the search ("yank", as the file manager's `y`) | — | — | **was Super+O** |
| `window.close` | Super+Q | ✓ | **new** (Alt+F4 stays) | **new**: closes the panel tab |
| `focus.{left,right,up,down}` | Super+arrows and Super+H/J/K/L | ✓ | **Exception:** Super+arrows and H/J/K/L tile, as GNOME's; focus moves with Alt+Tab | Super+←/→ and Super+H: previous and next panel tab (**was Ctrl+Tab**); Super+L too once the lock moves (step 3: the browser takes Super+L until then); ↑/K is the dock's layout, ↓/J unbound |
| `overview.toggle` | Super+O | ✓ | ✓ (and Super tap) | — |
| `workspace.{previous,next}` | Super+PageUp/PageDown, Super+U/I | ✓ | ✓ | **new**: the previous or next thread |
| `workspace.n` | Super+Alt+1…9 | ✓ | ✓ | **new**: the Nth thread, in the sidebar's order (pinned first) |
| `workspace.new` | Super+N | — | — | **new**: a new thread (Ctrl+N stays, page only) |
| `dock.slot.n` / `dock.assign.n` / `dock.slotAlt.n` | Super+1…9 / Super+Shift+1…9 / Super+Ctrl+1…9 | ✓ | ✓ | ✓ |
| `screenshot.*` | Print, Ctrl+Print, Alt+Print; Super+Shift+S and its Ctrl and Alt forms | ✓ | ✓ | **new** |
| media, volume, brightness | their keys | browser | browser | browser |

Hydra's own actions on Super, which no shared action uses:

| Hydra action | Key | Was |
|---|---|---|
| `hydra.panel.tab.n` | Alt+1…9, **page only** for now; Super+G then 1…9 once chords exist | Alt+1…9, taken from apps |
| `hydra.commandPalette` | **Super+Shift+Space** | Ctrl+K, page only |
| `hydra.terminal.toggle` (the drawer) | **Super+`** | Ctrl+J, page only |
| `hydra.rightPanel.toggle` | **Super+\\** | Ctrl+Alt+B |
| `hydra.sidebar.toggle` | **Super+Shift+\\** | Ctrl+B |
| `hydra.thread.{previous,next}` | covered by `workspace.*` | Ctrl+Shift+[ / ] |
| `hydra.dock.toggleLayout` | Super+↑ and Super+K | Super+K **new** |
| `hydra.composer.append` | **Super+Enter**: the composer, at the end, in insert mode (HYDRA_KEYBOARD.md's `gA`, from anywhere) | **new** |
| `hydra.layout.resize` (a mode) | **Super+R** (HYDRA_KEYBOARD.md, "The resize mode"), once the mode is built | **new** |

Everything else in T3 (the composer, chat, find, diff, the model picker, preview zoom and refresh) keeps its Ctrl keys and is never registered as a shell shortcut. Each Hydra Ctrl key that moves to Super stays as a page-only alias, so T3's keys still work while Hydra's page has the keyboard.

### The user's keys

`~/.pluto/keys.json`:

```json
{
  "launcher.open": ["Super+KeyD"],
  "window.close": ["Super+KeyQ", "Super+KeyW"],
  "styx:focus.left": ["Super+KeyN"],
  "hydra.composer.stash": []
}
```

- An entry replaces that action's defaults. `[]` unbinds it.
- A `<shell>:` prefix scopes an entry to one shell.
- The helper keeps the file, serves it (`GET /v1/keys`), and pushes changes to every shell page and the browser (`PUT /v1/keys/<action>`). The key editor (`widgets.js`'s `keyEditor`), Charon's Settings → Keyboard and Hydra's keybinding settings all write here, instead of to the shell's own storage.
- On first start, each shell's existing overrides are moved in, scoped to that shell, so nothing anyone rebound changes. Hydra's `keybindings.json` entries for shared actions are moved in the same way.
- Conflicts are checked across every layer: the browser's keys, shared actions, each shell's own actions, and apps' portal bindings. The key editor shows them, and `plutonium keys check` reports them.

## Contexts

A binding can have a `when`, in T3's grammar (identifiers, `!`, `&&`, `||`), evaluated synchronously. The identifiers:

| Context | What |
|---|---|
| `shell == styx`, `shellHydra`, … | which shell is visible on the focused display |
| `app == "org.mozilla.firefox"` | the app id of the window with the keyboard |
| `windowFocus`, `tabFocus`, `pageFocus` | a native window, a browser tab, or the shell's page has the keyboard |
| `tabHost == "github.com"` | the focused tab's host |
| `fullscreen`, `pointerCaptured` | |
| `inhibited` | the focused app asked for every key (`zwp_keyboard_shortcuts_inhibit_v1`: VMs, remote desktops, some games) |
| `mode == "resize"` | the current mode (Chords and modes) |
| anything the config sets | `desktop.context.set("gaming", true)` |
| a shell's own (Hydra's `terminalFocus`, `composerFocus`, …) | only that shell's actions see them |
| `editableFocus`, `vimMode == "normal"` | a text field has the keyboard; Pluto Vim's mode in it (`insert`, `normal`, `visual`, `cmdline`), from `pvim:mode` and the native badge |
| `region == "timeline"` | the region of Hydra with focus (HYDRA_KEYBOARD.md) |

**Contexts form a tree,** as Zed's do: display › shell › window or tab › frame › field. Each level adds its own names. `>` means "inside": `shellHydra > composer`, `tab > editableFocus`. When several bindings match, the one from the deeper context wins, then the user's over the defaults.

How it's evaluated:
- **On the page:** the shell library sees every key the browser forwards, and evaluates `when` before running an action.
- **Deciding which keys to take:** the browser's list (`setShellShortcuts`) holds only the combos whose `when` is true now. The shell library recomputes the list whenever a context changes (`windowfocus` and `windowblur`, a tab's focus, a mode, `context.set`), and sends it only when it changed. So Super+Q in Blender (`!(app == "org.blender.Blender")`) reaches Blender, with no script in the key path.
- **Inhibit:** while `inhibited` is true, only the browser's unremovable keys are taken (Principle 7). Exo has no `zwp_keyboard_shortcuts_inhibit_manager_v1` yet. It's a Chromium patch, which the browser then reports to the page as a context.

A Pluto Vim mode change recomputes the list only when some binding's `when` reads `vimMode`. Most don't, and a mode change happens on every Escape, so it shouldn't cost an IPC round trip each time.

There is a gap between a focus change and the new list reaching the browser, of about one IPC round trip. A key pressed in that gap is decided by the previous list. The other option is evaluating `when` inside the browser. That needs the browser to understand contexts, so it isn't worth it unless the gap turns out to matter in practice.

## Chords and modes

Both need one new browser primitive: **a keyboard grab** (`windowBroker.grabKeyboard()` → a handle with `release()`). While a grab is held, every key goes to the shell page, and the app with the keyboard keeps its focus: it gets no blur, so menus stay open and games don't pause. The grab ends when it's released, when the page goes away, or after a time limit (a safety net, default 10 s). Today, the only way to get the key after a prefix is to move focus to the page, and that sends the app a blur.

**One sequence matcher.** Chords and modes use Pluto Vim's matcher (`helper/web/vim/engine.js`), not a second one: it already has keys that wait, `timeoutlen`, prefixes, `nowait` and counts, and `plutonium vim check` already warns about prefixes. A desktop mode is a set of mappings, as a vim mode is, run under the keyboard grab instead of in a field. Counts come with it (`Super+G 3 L`), and `keys check` and `vim check` report the same things the same way.

- **Chords.** A chord's first combo is an ordinary shell shortcut. When it's pressed, the library grabs the keyboard and waits for the next key, for up to 1.5 s. Escape cancels, and an unbound key cancels and is dropped. A prefix can't also be a binding of its own: `keys check` and the key editor say so.
- **The which-key overlay.** If no key comes within 400 ms of a prefix, the shell library shows the possible next keys, read from the keymap. `keys.help` is the same overlay showing every key.
- **Modes.** A mode is a named set of bindings, active while the grab is held, until Escape or a binding exits it:
  ```js
  keys.mode("resize", {
    "KeyH": () => windows.focused()?.resize({ dw: -40 }),
    "KeyL": () => windows.focused()?.resize({ dw: 40 }),
    "Escape": keys.exitMode,
  }, { enter: "Super+KeyR" });
  ```
  The mode shows in the overlay, and as `mode == "resize"` in contexts.
- **One command line.** Pluto Vim's `:` line and Hydra's command palette become one: it takes ex commands, `init.js`'s commands and every catalogue action by name (`:Run launcher.open`, `:snooze 1h`), with history and `@:`, as Zed's palette does. `:` in normal mode opens it; outside a field, the palette's Super key does. The shell draws it when no field owns it, as it draws the native mode badge.
- **Taps and holds.** A trigger can also be `tap` (a modifier pressed and released alone: Charon's Super tap), `release`, `hold` (with a time), or `double`. Push-to-talk needs press and release, as the portal path already has.

## The config script

`~/.pluto/config.js` is an ES module, run as you with all of Node (`fs`, `child_process`, `fetch`, timers), as compositors' configs are (qtile's `config.py`, Hyprland's, sway's). It's optional. Without one, `keys.json` is the whole config.

```js
export default function setup(desktop) {
  const { keys, windows, tabs, apps, shells, context, notify } = desktop;

  keys.bind("Super+KeyT", () => apps.launch("foot"));
  keys.bind("Super+Shift+KeyW", async () => {
    notify(await fetch("https://wttr.in/?format=3").then((r) => r.text()));
  });
  keys.bind("Super+BracketRight", () => shells.current().run("hydra.panel.next"));
  keys.bind("Super+KeyG KeyF", () => windows.find({ app: "org.mozilla.firefox" })[0]?.focus());

  windows.on("open", (w) => { if (w.appId === "mpv") w.fullscreen(); });
  setInterval(async () => context.set("gaming", await steamGameRunning()), 5000);
  keys.bind("Super+KeyQ", (w) => w.close(), { when: "!gaming" });
}
```

### The API

`desktop` is typed. `~/.pluto/config.d.ts` is installed next to the config, so editors and agents get completion.

| | |
|---|---|
| `keys` | `bind(combo, fn \| actionId, { when, repeat, trigger })`, `unbind`, `mode`, `exitMode`, `run(actionId)`, `list()` |
| `context` | `set(name, value)`, `get`, `on("change")` |
| `windows` | `list`, `focused`, `find`, `on("open" \| "close" \| "focus" \| "title")`; a window's `focus`, `close`, `fullscreen`, `resize`, `moveToDisplay`, `moveToThread`, `snapshot`, `click`, `type`, `press` (the same as the agents' tools) |
| `tabs` | `list`, `focused`, `open(url)`, and the tab tools |
| `apps` | `list`, `launch(id \| command, { thread })` |
| `shells` | `current()`, `list()`, `switch(name)`, a shell's `run(actionId, args)` |
| `displays`, `session`, `system` | the helper's `display`, `session` and system services: lock, idle, volume, brightness, players |
| `ui` | `notify`, `menu(items)`, `prompt(text)`, `overlay`, drawn by the visible shell through the shell library |
| `threads` | Hydra's threads: `list`, `current`, `new({ prompt, attach })`, `send(text)` |

A callback gets the key's context (the window or tab with the keyboard, the shell, the display) as its argument.

### Where it runs

**In its own Node process, run by the helper.** This is the host shells' native sides already use (`helper/src/nativeHost.ts`, [DESKTOP_SERVICES.md](DESKTOP_SERVICES.md#a-native-side-and-storage)): as the user, logging to `~/.pluto/logs/config.log`, restarted after a crash. In practice, the config is the desktop's own native side.

What the config does to windows and tabs goes the way the agents' tools already do: helper → the focused display's visible shell page → `navigator.windowBroker` (`_bridgeOp`). That route adds a few milliseconds to an action, which a key press doesn't notice, and nothing to the decision to take a key.

Why not in a shell page, which has the broker directly:
- **Several shells run at once.** They're all loaded, behind Super+Tab. Either one of them owns the config, or each one runs it and every hook fires several times.
- **Lifetime.** A shell page reloads on every edit and rollback, and when it crashes or is turned off. The config's timers, sockets and watchers would go with it. It has to outlive any shell.
- **Isolation.** A busy loop in the config would freeze that shell's page: its drawing, and the keys you'd use to get out. In its own process, the page and the table in the browser keep working while the helper restarts the config.
- **Reach.** A page has no `fs` or `child_process`, so a page config would end up calling a native side for everything anyway.

Shells stay scriptable as they are: a shell's own page and native side are already your JS, and a config calls a shell's actions with `shells.current().run(…)`.

### Reloading and failure

- Saving `config.js` reloads it. A config that throws while loading, or crashes three times in a minute, is replaced by the last good one, and you're told in a notification with the error. Each good version is committed in `~/.pluto/config/.git`, as shells' edits are.
- Bindings the config made are part of the table the browser holds. A config that's down leaves them in place, except that their callbacks don't run, and a key bound to a down callback shows a notice once.
- `plutonium keys check` loads the config in a dry run (no callbacks) and reports errors, conflicts and prefixes that shadow bindings.
- `plutonium keys log` streams each key: which binding matched, under which context, how long its callback took, and what it threw.

## The work, in order

1. **Hydra's keys** (T3 patches 0001, 0007, 0008 and 0013; **built** 2026-11-09): its keys move as in the tables above, Super+Alt+1…9 to threads included, Super+Enter and Super+R too. Only Super combos are registered as shell shortcuts. Ctrl aliases stay, page only. Needs no new machinery. How it's done: the Super keys are `PLUTONIUM_SUPER_KEYS` in `packages/shared/src/keybindings.ts`, each beside the default it moves from; a keybindings.json T3 already wrote gets them through the server's late defaults, beside that default if it's still there (a key you rebound stays yours); `panelKeys.ts` registers every Super binding as a shell shortcut, and none without Super; Super+Enter is Hydra's own (`shellKeys.ts`). Not yet: Super+L (the browser's lock, step 3), Super+R (no resize mode), screenshots and `keys.help`. HYDRA_KEYBOARD.md's steps 1–5 need none of this list and can go first or alongside.
2. **The catalogue and `keys.json`:** shared action ids in the UI library, the helper's store and routes, the existing overrides moved in, Styx, Charon and plain on the catalogue, and the new default keys. Hydra maps its shared actions onto it.
3. **The browser's keys from the helper** (Chromium: `plutonium_keys.cc`): Super+F, Super+Tab, the lock and the display keys as catalogue actions.
4. **Contexts:** the shell library evaluates `when` and recomputes the browser's list on focus changes; `keys check` across layers.
5. **The config process and its API.** Most of it wraps routes the helper has.
6. **The keyboard grab** (Chromium, Exo), then chords, which-key, modes, and tap and hold triggers, on Pluto Vim's matcher; the `:` line and the palette as one.
7. **Keyboard-shortcut inhibit** (Exo): `zwp_keyboard_shortcuts_inhibit_manager_v1` as a context.

## Decisions

- 2026-11-08: one desktop-wide default set; Super+Alt+1…9 in Hydra goes to threads; the launcher keeps Super+Space and Super+D; the lock moves to Super+Alt+Shift+L; H/J/K/L twin the arrows everywhere; shells may make exceptions to the shared defaults, listed in the table.
- 2026-11-09: Super+F is maximize and Super+Shift+F fullscreen (CONTROLS.md, from 2026-11-08); the table follows.
- 2026-11-09: one sequence matcher, Pluto Vim's, for chords and modes; one parser for both notations (codes for Super combos, characters in vim mappings); contexts as a tree with `>`; Pluto Vim's mode and field focus as contexts; Pluto Vim as a layer in the order a key goes through; the `:` line and the palette as one.
- 2026-11-09: Super+Enter is the composer at its end, in insert mode, and Super+R Hydra's resize mode (HYDRA_KEYBOARD.md).
