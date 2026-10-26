# Using Plutonium

## Keys everywhere

The browser handles these in every shell:

| Keys | |
|---|---|
| Super+Tab | The overlay, with the next shell selected. Super+Tab again or ↑/↓ moves, Enter acts, Escape closes. It switches, adds (Ctrl+N), turns off (Ctrl+O) and removes (Ctrl+Delete) shells. Its search finds any window or tab, to show in its shell, pop out, add to a thread or close |
| Super+F | Fullscreen the focused app or tab (it's resized to the screen, not scaled) |
| Super+Escape | Release an app's pointer lock or confinement |
| Ctrl+Alt+F1…F12 | On DRM: switch to that VT. Switching back returns to the session as it was ([features/SEAT.md](features/SEAT.md)) |
| Volume up/down/mute, mic mute | The default output's volume (5% a press, up to 100%) and mute, the default input's mute; the shell shows the level ([features/DESKTOP_SERVICES.md](features/DESKTOP_SERVICES.md)) |
| Brightness up/down | The backlight, 5% a press |
| Play/pause, next, previous | The player that last played: an MPRIS app (mpv, Spotify…) or a tab |
| Ctrl+Alt+Backspace | On DRM: end the session (as `plutonium stop --drm`); the text console comes back |

Each shell adds its own keys, which keep working while an app or tab has the keyboard.

## The shells

These three are shipped, and installed in `~/.pluto/shells` (below).

**niri** (`plutonium run niri`) is a clone of the [niri](https://github.com/YaLTeR/niri) compositor, with niri's default binds:
- **Super+T** opens a terminal (foot), **Super+D** the launcher, **Super+Q** closes the focused window, and **Super+O** opens the overview.
- **Super+arrows** move focus.
- **Super+Shift+/** lists the keys.

Everything it starts is in the thread `niri:desktop`. The full list of binds is in [features/NIRI_SHELL.md](features/NIRI_SHELL.md).

**plain** (`plutonium run plain`) is a minimal thread-based shell.
- **Layout:** threads are on the left, and each thread's apps and tabs are on the right.
- **Each thread** can launch apps, open web pages as tabs, and start Claude Code with the thread's tools.
- **"Elsewhere"** lists windows and tabs from other shells; a click brings one into the current thread.

**T3 Code** (`plutonium run t3`): coding agents' chat threads. Each thread's apps, terminals and browser tabs are in its right panel ([frontends/t3code](../frontends/t3code/README.md)).
- Alt+1…9 and Ctrl+Tab move between panel tabs.
- Ctrl+T opens a browser tab.
- Super+Space opens the app launcher.

## Threads, apps and links

- **What belongs to a thread:** an app started from a thread (from its terminal, its launcher, or its agent) belongs to that thread, and so do the windows it opens. The shell that owns the thread shows them.
- **Links:** links an app opens become browser tabs in the same thread. That covers `xdg-open`, Ctrl+click in a terminal, Python's `webbrowser`, GTK and KDE apps' "open link", and `$BROWSER`. Files open in their usual app, started in the thread ([features/OPENING_LINKS.md](features/OPENING_LINKS.md)).
- **Links in pages:** Ctrl+click, middle click, `target=_blank` and `window.open` in a shell page or a tab open a tab in the same thread, never a separate browser window.
- **Apps started elsewhere:** an app started outside any thread (for example, from your normal desktop pointed at Plutonium's socket) arrives untagged. niri adopts such windows; in T3 they're under "Other windows", and in the plain shell under "Elsewhere".

- **Notifications:** apps' notifications and websites' (a tab's `new Notification()`, once you allow it) pop up in the shell you're in. Clicking a website's runs what the site does on a click and brings its tab to front.
- **Like the rest of your desktop:** pages and shells follow your desktop's light or dark setting (the settings portal, or GNOME's), and use its fonts. For the fonts, the container has to be made after this change: `podman rm -f plutonium-prebuilt`, then `plutonium container create` (the session's log says when).

**Already-running processes** keep the environment they started with. A terminal opened before a change to the helper won't have its new link openers.

## Agents

An agent running in a thread gets the helper's MCP tools for that thread:
- **Windows:** list, launch, snapshot, focus and close them, and use them: `click_window`, `hover_window`, `drag_window`, `scroll_window`, `type_window`, `press_window`, `resize_window`. Points are the snapshot's pixels.
- **Tabs:** open, navigate, snapshot, focus and close them, and answer their dialogs. `read_tab` gives the page as an accessibility tree with element refs, for `click_tab`, `type_tab`, `select_tab`, `press_tab`, `hover_tab`, `scroll_tab`, `evaluate_tab` and `wait_for_tab`.

The agent works in the background: your pointer and keyboard stay where they are, and what it drives needn't be on screen. It can only reach windows and tabs tagged with its own thread. In T3 Code every provider's agents get the window tools, and drive tabs with T3's own browser tools ([features/AGENT_CONTROL.md](features/AGENT_CONTROL.md)). INSTALL.md §8 shows how to start one.

## Your shells

Your shells live in `~/.pluto/shells/<name>/`, one folder each. The first `plutonium run` copies the shipped ones there. `plutonium run` with no shells runs the ones that are on, in the switcher's order, and the switcher's changes are kept (`~/.pluto/shells.json`). `plutonium shells list` shows them all. `plutonium shells update` merges a newer shipped version into yours, keeping your changes.

To change one, open the switcher (Super+Tab), pick the shell, and under **Customize** choose:
- **Copy a prompt for your agent**: paste it into whichever agent you use; it points the agent at Plutonium's skill (`~/.pluto/SKILL.md`) and the shell's folder;
- **Open a terminal**: your shell, in that folder;
- **History, log and updates…**.

To make a new shell, open the switcher's **Add a shell…** and pick **New shell…** (or run `plutonium shells new <name>`): a copy of one you have, to change yourself or with an agent.

Every save reloads the shell and is committed. If a change breaks the shell (it doesn't come back within 20 s, or its page crashes), it's rolled back and you're told, in whichever shell you're in (a notification); Retry and the diff are on its page. If no shell comes up at all, `plutonium run --safe` starts the shipped plain shell, and two failed starts in a row do the same by themselves. The details are in [features/SHELL_PACKAGES.md](features/SHELL_PACKAGES.md).

## Writing a shell

A shell is a folder with a `shell.json` and a web page:

```
my-shell/
  shell.json     {"title": "Mine", "version": "1", "static": "index.html"}
  index.html
```

Add it from the switcher: **Add a shell…**, then **Install from a folder, git or address…**, then give it `~/my-shell` or a git URL. It's copied into `~/.pluto/shells/my-shell`, served at `http://my-shell.localhost:8770/`, and that origin gets shell rights. If your shell needs its own server, the manifest says how to run it, and Plutonium supervises it (`"server"`, [features/SHELL_PACKAGES.md](features/SHELL_PACKAGES.md)). A page you serve yourself can be added by its address.

The page gets `navigator.windowBroker`, `<native-window>` and the tab API, and `?helper=` naming the session's helper. It loads the helper's library for threads, launching and the agent bridge:

```html
<script type="module">
const helper = new URLSearchParams(location.search).get("helper");   // the session adds ?helper=
const { connect } = await import(`${helper}/v1/shell.js`);
const shell = connect({                               // connecting tells Plutonium the shell came up
  onFocus: (w) => { show(w.id); return true; },       // an agent asked to show a window
  onFocusTab: (t) => { showTab(t.id); return true; }, // ... or a tab
  onOpenTab: () => "mine:thread/1",                    // a link this page opened: which thread
});
shell.setGroups([{ tag: "mine:thread/1", label: "Thread 1" }]);
shell.addEventListener("change", render);

async function show(id) {
  const el = document.createElement("native-window");
  el.setAttribute("grant", await shell.grantFor(id));
  document.body.append(el);              // the app is sized to the element
}
function showTab(id) { document.body.append(shell.tabElement(id)); }
function render() { /* shell.windowsOf("mine:thread/1"), shell.tabsOf(...) */ }
await shell.launch("mine:thread/1", ["foot"]);
</script>
```

`shells/plain/index.html` (about 700 lines) is a complete example. `helper/README.md` documents the library and the helper's API.
