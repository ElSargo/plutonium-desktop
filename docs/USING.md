# Using Plutonium

## Keys everywhere

The browser handles these in every shell:

| Keys | |
|---|---|
| Super+Tab | The overlay, with the next shell selected. Super+Tab again or ↑/↓ moves, Enter acts, Escape closes. It switches, adds (Ctrl+N), turns off (Ctrl+O) and removes (Ctrl+Delete) shells. Its search finds any window or tab, to show in its shell, pop out, add to a thread or close |
| Super+F | Fullscreen the focused app or tab (it's resized to the screen, not scaled) |
| Super+Escape | Release an app's pointer lock or confinement |

Each shell adds its own keys, which keep working while an app or tab has the keyboard.

## The shells

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

**Already-running processes** keep the environment they started with. A terminal opened before a change to the helper won't have its new link openers.

## Agents

An agent running in a thread gets the helper's MCP tools for that thread:
- **Windows:** `list_windows`, `launch_app`, `snapshot_window`, `focus_window`, `close_window`.
- **Tabs:** open, navigate, snapshot, focus and close them, and answer their dialogs.

It can only reach windows and tabs tagged with its own thread. INSTALL.md §9 shows how to start one.

## Writing a shell

A shell is any web page served over http(s) on an origin you pass to `plutonium run <name>=<url>`. Its document gets `navigator.windowBroker`, `<native-window>` and the tab API. It loads the helper's library for threads, launching and the agent bridge:

```html
<script type="module">
const helper = new URLSearchParams(location.search).get("helper");   // plutonium run passes ?helper=
const { connect } = await import(`${helper}/v1/shell.js`);
const shell = connect({
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

`shells/plain/index.html` (about 550 lines) is a complete example. `helper/README.md` documents the library and the helper's API.
