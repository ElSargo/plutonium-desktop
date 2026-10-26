---
name: plutonium
description: How to work on the user's Plutonium desktop (also called Pluto) - its shells (the web pages that are the desktop), their servers, apps, windows and tabs. Read this before changing, creating or debugging anything about the user's desktop.
---

# Plutonium (Pluto) at a glance

Plutonium is a desktop environment for Linux where **the desktop is a web page**. It runs Chromium's ChromeOS desktop (Ash) and its Wayland server (Exo). Native apps (Wayland and X11) and real browser tabs are elements in that page, `<native-window>` and tab elements, which the page lays out, styles and scripts like anything else.

- **A shell** is one such page: a window manager, a launcher, a whole desktop. The user can run several and switch with **Super+Tab** (the switcher, drawn by Ash; it also has a backup terminal and a backup browser that work whatever the shells do).
- **The helper** (`plutoniumd`, Node, runs as the user on the host) launches apps, groups everything into threads, serves the shells and supervises their servers. Shell pages talk to it through the shell library.
- Plutonium itself is checked out at `{{PLUTONIUM}}` (the `plutonium` command is `{{PLUTONIUM}}/bin/plutonium`).

## Where things are

| | |
|---|---|
| The user's shells | `{{PLUTO_HOME}}/shells/<name>/`: each a git repository with a `shell.json` |
| Which shells are on, in what order | `{{PLUTO_HOME}}/shells.json` (the switcher writes it) |
| Logs | shell servers: `{{PLUTO_HOME}}/logs/<name>.log`; the session: `{{PLUTONIUM}}/logs/` (`ash-*.log`, `helper-*.log`) |
| This skill | `{{PLUTO_HOME}}/SKILL.md` |

## The rules that matter most

1. **Edit shells only in `{{PLUTO_HOME}}/shells/<name>/`**, never in the checkout's `shells/` (that's what ships; `plutonium shells update` merges it into the user's copy).
2. **Every save is committed and reloads the shell.** If no page of the shell connects to the helper (`connect()` in the shell library) within 20 s, the folder is **rolled back** to the last version that worked, and the user is told. So save working states; check the shell came back (`plutonium shells list`) after a change.
3. **Don't stop or restart the user's session, Ash, the helper or T3 Code's server** unless they ask: agents (maybe you) run inside T3 Code. Use the helper's API to restart one shell's server.
4. Shell pages need a **secure, unique origin**: static shells get `http://<name>.localhost:<port>/` from the helper. Shell rights (`navigator.windowBroker`) are per origin.

## Common requests

- **Change a shell** ("make niri's bar smaller", "add a key binding"): edit its folder. Its page is plain HTML/JS; read it first. niri's keys are near `bind(` in `index.html`.
- **Make a new shell**: `plutonium shells new <name> [<installed shell>]` copies a shell (default: `plain`, a small complete example) into `{{PLUTO_HOME}}/shells/<name>`, turns it on and puts it in the switcher. Then edit it. A shell with a server: set `server` in `shell.json` (below).
- **Install someone else's shell**: the switcher's "Add a shell…", or `plutonium shells` (folder, git URL or address).
- **A shell's server misbehaves**: `curl --unix-socket "$PLUTONIUM_HELPER" http://helper/v1/shells` for state; `POST /v1/shells/<name>/restart`; its log is above.
- **A shell that needs the computer** (files, commands) **or keeps settings**: `"native": "native.js"` in `shell.json` (a module the helper runs; its exported functions are `shell.native.call(name, args)`) and `shell.storage.get/set` (kept in `{{PLUTO_HOME}}/data/<name>/`, survives rollbacks). See `{{PLUTONIUM}}/docs/features/DESKTOP_SERVICES.md`, "A native side and storage". Don't add a server just for this.
- **Volume, Wi-Fi, Bluetooth, brightness, battery, notifications**: `shell.system.<service>` in the shell library, after naming it in `shell.json`'s `"uses"` (`{{PLUTONIUM}}/docs/features/DESKTOP_SERVICES.md` lists which exist so far, their state and actions). A shell page can't run commands, so don't work around a missing one; tell the user it's coming.
  - `audio`: outputs and inputs, the default's `volume`/`muted` up front; `set-volume`, `set-mute`, `set-default`, `step`.
  - `power`: `battery` (null on a desktop), `ac`, `brightness` (`available`, 0–1), `can`; `set-brightness`, `step`, `suspend`, `reboot`, `power-off`, `log-out` (ends the Plutonium session). Always confirm the last four with the user's click in your UI.
  - `media`: MPRIS players and the browser's media session, most recent first; `play-pause`, `next`, `previous`, `play`, `pause`, `stop`.
  - `session`: the lock screen and idle: `locked`, `idleSeconds`, `idleAction`, `lockAfter`/`screenOffAfter` (seconds, 0 never), `inhibitors`, `canLock`/`problem`; `lock`, `set-idle {lockAfter, screenOffAfter}`, `inhibit {why}`/`uninhibit` (holds off the screen off and the lock while your shell shows something, e.g. a presentation; it goes with your page). The lock itself is Ash's (Super+L): a shell can't draw, skip or cover it, so don't build one.
  - The volume, brightness and media keys already work in every shell; listen for the shell's `systemkey` event to draw a level. niri's and plain's indicators (`audio.js`, `power.js`, … in their folders, one module each over `tray.js`) are examples to copy.
  - `network` (Wi-Fi list, connect with a password, on/off, wired and VPN connections) and `bluetooth` (on/off, devices, discover, pair, connect): their state and actions are in DESKTOP_SERVICES.md. When either needs the user (a Wi-Fi password, a pairing code), the shell gets a `systemrequest` event; without `preventDefault()` the library shows its own prompt.
- **Something is broken and you can't tell why**: `plutonium doctor`, then the logs. `plutonium run --safe` starts only the shipped plain shell.

## shell.json

```json
{ "title": "My shell", "version": "1", "description": "What it is.", "static": "index.html" }
```

or, for a shell with its own server, `"server": {"run": "plutonium", "argv": ["node", "server.js"], "port": 4100, "health": "http://127.0.0.1:{port}/", "restartOnEdit": true}` (the helper starts, watches and restarts it), or `"server": {"run": "external", "url": "http://localhost:5173/"}` (the user runs it). Every page gets `?helper=<helper URL>` added.

## A shell page in ten lines

```html
<script type="module">
const helper = new URLSearchParams(location.search).get("helper");
const { connect } = await import(`${helper}/v1/shell.js`);
const shell = connect({ onFocus: (w) => { show(w.id); return true; } });
shell.setGroups([{ tag: "mine:thread/1", label: "Thread 1" }]);
shell.addEventListener("change", () => { /* shell.windowsOf("mine:thread/1"), shell.tabsOf(...) */ });
async function show(id) {
  const el = document.createElement("native-window");
  el.setAttribute("grant", await shell.grantFor(id)); document.body.append(el);
}
await shell.launch("mine:thread/1", ["foot"]);
</script>
```

## The full docs (read the one your task needs)

| | |
|---|---|
| Using it: keys, the shells, threads | `{{PLUTONIUM}}/docs/USING.md` |
| Shells as packages: manifest, origins, servers, edits, rollback, the helper's shells API | `{{PLUTONIUM}}/docs/features/SHELL_PACKAGES.md` |
| The shell library and the helper's HTTP API | `{{PLUTONIUM}}/helper/README.md` |
| `<native-window>`, the window broker, tabs | `{{PLUTONIUM}}/docs/features/BROKER.md`, `{{PLUTONIUM}}/docs/features/TABS.md` |
| Sizing, fullscreen, controls, drag and drop | `{{PLUTONIUM}}/docs/features/WINDOW_SIZING.md`, `CONTROLS.md`, `DRAG_AND_DROP.md` (same folder) |
| Several shells, the switcher | `{{PLUTONIUM}}/docs/features/SHELLS.md` |
| The niri shell | `{{PLUTONIUM}}/docs/features/NIRI_SHELL.md` |
| Agents driving apps and tabs (MCP tools) | `{{PLUTONIUM}}/docs/features/AGENT_CONTROL.md` |
| How it's built | `{{PLUTONIUM}}/docs/ARCHITECTURE.md` |
| Complete example shells | `{{PLUTONIUM}}/shells/plain/index.html` (small), `{{PLUTONIUM}}/shells/niri/index.html` (large) |
