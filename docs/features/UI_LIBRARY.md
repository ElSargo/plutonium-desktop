# The shells' UI library

`helper/web/ui/`: what the bundled shells (Styx, Charon, plain) have in common, so each doesn't keep its own copy: the dock, keys, settings, dragging and resizing, and the widgets and status indicators. The helper serves it as ES modules at `GET /v1/ui/<path>` (`helper/src/uiLibrary.ts`). It's public like the shell library (`/v1/shell.js`): any page may load it, but only a shell can use what it drives. It sits next to the shell library, so a session serving its live copy (`plutonium live`) serves that copy's UI library too.

```js
const helper = "http://127.0.0.1:3780";
const keys = await import(`${helper}/v1/ui/keys.js`);
const { Dock } = await import(`${helper}/v1/ui/dock/core.js`);
```

Hydra's dock is in T3 Code (`PlutoniumDock.tsx`, [HYDRA_DOCK.md](HYDRA_DOCK.md)) and doesn't use this library yet. The library's dock does everything Hydra's does, except the per-project scope, which the other shells have no use for yet.

## Modules

| Module | What it is |
|---|---|
| `dock/core.js` | The dock's model, with no DOM: slots, scopes, what pressing a slot's key again and again does, running apps, settings and keys (below). |
| `dock/dock.js` | The dock's view: `mountDock(container, dock, options)` draws a row or column of slot buttons, their menus, the slot editor, and handles drag to reorder, pin and remove. |
| `keys.js` | `Keymap`: actions with default keys, the user's overrides, conflicts, and which combos to register as shell shortcuts. Also `comboOf(event)`, `prettyCombo`, `recordCombo` and the Chromebook top-row aliases (F1–F4). Combos read `Super+Ctrl+Alt+Shift+<KeyboardEvent.code>`. |
| `settings.js` | `shellStore(shell, prefix)`: JSON values in the shell's storage, mirrored in `localStorage` for when there's no helper. `Settings`: values with defaults and a `change` event. `settingsForm(settings, schema)`: a generic form for a schema (label, kind, choices). |
| `drag.js` | `trackDrag` follows one drag, whether a press on the page started it or an app's own move or resize request did. Plain geometry: `nearestEdge` (niri's thirds), `resizeRect` (the opposite edge stays put, within limits), `edgeVelocity` (auto-scroll at an edge), `insertIndex` (reorder) and `doubleClick`. |
| `widgets.js` | Icons, popovers, menus (keyboard-driven), sliders, a confirm dialog, toasts, a segmented control, and `keyEditor(keymap)`, a list of every action with its keys to rebind. Themed with the `--tray-*` variables. It was Styx's `tray.js`. |
| `indicators/*.js` | The status indicators: audio, battery, Bluetooth, brightness, display, media, network, OSD, power. Each is `export default (shell, container)` over a desktop service ([DESKTOP_SERVICES.md](DESKTOP_SERVICES.md)). Styx and the plain shell each had a copy before. |

## The dock

Hydra's dock ([HYDRA_DOCK.md](HYDRA_DOCK.md)) and GNOME's Dash to Dock in one. The shell is the host: it says what's in a scope, shows and hides things, starts apps and opens tabs, and remembers where you were (`DockHost` in `core.js`). The model has tests with a fake host (`helper/test/uiDock.test.ts`).

- **Slots** on Super+1…9, each a terminal, an app or a site. A slot holds one window or tab, the one tagged `<ns>:dock/<slot id>`, not every one that looks like it. With nothing held, its key starts the app or opens the site and tags what that made. With "Use an open window" on, a pinned app's open window in the scope is taken first, as Dash to Dock raises one.
- **Scopes:** `thread` (in Styx and Charon, a workspace: one copy each) or `global` (one copy, which follows you). Hydra also has `project`.
- **Layouts:** Normal, or Maximized (Hydra's split and fold). Styx maximizes the column, Charon tiles the window to fill the screen.
- **A press isn't drawn over.** A press on a slot may be a click, and a browser sends no click to a button replaced since the press, so the dock doesn't redraw between press and release: a change that comes then is drawn after the click.
- **Pressing a slot's key:** shows what it holds, or starts it. Pressed again, it goes back to where you were. Clicking the icon works as the settings say: focus, minimize or list its windows (Dash to Dock's default), focus, minimize or cycle, or focus and go back.
- **Running apps** that nothing pins follow a separator. Drag one onto the dock to pin it. Drag a slot off the dock to remove it (with Undo). A trailing **+** adds a slot.
- **Settings** (`DOCK_DEFAULTS`, `dockSettingsSchema()`): click, middle-click, Shift+click and wheel actions; show running apps; only this workspace's windows; use an open window; group an app's windows; slot numbers (while Super is held, always, never); icon size.

Keys (`defineDockActions(keymap, dock)`), each rebindable:

| Keys | Action |
|---|---|
| Super+1…9 | the slot |
| Super+Ctrl+1…9 | the slot, in its other layout this time |
| Super+Shift+1…9 | put what has the keyboard in the slot |
| Super+Ctrl+Shift+1…9 | a new window (or tab) of the slot |

## In the shells

- **Styx** (`shells/niri`): the dock sits in the top bar, after the minimap. Its keys moved to the keymap: every niri bind can be rebound in the dock's settings (its menu → Dock Settings…), and the user's keys are kept in its settings. niri's Super+1…9 for workspaces became **Super+Alt+1…9** (and Super+Ctrl+Alt+1…9 to move the column), as in Charon. Window resizing uses `nearestEdge` and `resizeRect`. The indicators come from the library.
- **Charon** (`shells/gnome`): the dash is the library's dock, drawn as GNOME's. Pinned apps move into its slots once. Keys, settings storage, window resizing (`resizeRect`) and dragging apps out of the grid (`trackDrag`) go through the library. Settings → Apps lists the slots, and Appearance has the dock's options. Pinned apps that aren't running aren't dimmed, as in GNOME.
- **Plain** (`shells/plain`): the indicators come from the library.

## Changes from before

- Styx: workspaces are Super+Alt+1…9, not Super+1…9.
- Charon: a new window of pinned app N is Super+Ctrl+Shift+N, not Super+Ctrl+N (which now opens the slot maximized). Keys rebound for the old "Open pinned app N" actions don't carry over to the dock's.

## Checked

In an X11 test session (2026-11-02), with real keys and clicks:

- **Styx:** Super+1 starts foot through the dock and binds it. Super+Shift+2, Super+1/2 and going back work. The menu, the editor with a site (Hacker News opened as a tile, with its icon from the helper), the settings popover and rebinding a key work.
- **Charon:** the dash shows Web, Foot and Claude Code. Super+2 starts foot, and Super+1 opens a Web tab through Charon's launcher and binds that tab, with going back between them. Clicks focus, then minimize. The Settings pages that changed work, and so does dragging an app from the grid onto the dash.
- **Plain:** the indicators load from the library.

Helper tests: `helper/test/uiDock.test.ts` (the dock model), `helper/test/uiDockView.test.ts` (a press on a slot: click or drag, over a small DOM) and `helper/test/uiLibrary.test.ts` (keys, settings, drag geometry, the route).
