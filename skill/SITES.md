---
name: plutonium-sites
description: How to write and fix site extensions on the user's Plutonium desktop - the CSS and JS the desktop applies to a website in its browser tabs (hide things, add keys, restyle, change behaviour per project). Read this before changing how a site looks or behaves for the user.
---

# Site extensions

A site extension changes a website in the user's browser tabs, like a user script or a user style. Plutonium applies it to every tab showing that site, at once and on every later visit. The design is `{{PLUTONIUM}}/docs/features/SITE_EXTENSIONS.md`.

## Where things are

| | |
|---|---|
| Every site | `{{SITES}}/<host>/`, one folder per site, named by its host (`github.com`) |
| A site's settings | `{{SITES}}/<host>/site.json` |
| A part | `{{SITES}}/<host>/<name>.css` and/or `<name>.js` |
| What was asked | `{{SITES}}/<host>/requests.md` (the helper appends; you don't need to) |
| Types for `site` | `{{SITES}}/site.d.ts` |
| Errors and logs | `{{PLUTO_HOME}}/logs/sites/<host>.log`, and `site_report` |
| A project's settings for sites | `{{PLUTO_HOME}}/projects/<project id>.json`, `"sites": { "<host>": { ... } }` |

The folder is a git repository: **every settled save is committed and applied to the open tabs within a second**, in place, without reloading them. `git log` shows what changed; `git revert` undoes.

## The rules that matter most

1. **One folder per site, one part per kind of change.** A part is the unit the user switches on and off: `theme`, `keys`, `quiet` (decluttering), `reader`. Edit the part a request is about, or add one; don't put unrelated changes in one part. Part names: lowercase letters, digits, `-` and `_`.
2. **Hide, don't remove.** `display: none` (or `el.hidden = true`) keeps the page's own scripts working; removing nodes breaks them.
3. **Survive the page changing.** Sites are single-page apps that re-render: use `site.observe(selector, fn)` (it runs on matches now and as they appear), not one `querySelector` at load. Prefer stable selectors: `[data-testid]`, `aria-*`, roles, `id`s, over generated class names (`.css-1x2y3z`).
4. **Everything through `site`, so it can be undone.** Styles, observers, listeners, keys and timers made through `site` are taken down when the part changes or is switched off. Anything else (a node you inserted, a global you patched) needs undoing in the function your default export returns.
5. **Keys belong to the page first.** `site.keys.bind` never takes a key with Super (the desktop's), never in a text field, and never when the page handled it. Don't fight the site's own shortcuts: learn them first and keep the good ones.
6. **Keep the context in the script.** `site.context` (thread, project, settings) is for the script's decisions. Never write it into the page (attributes, text, network requests): the site's own scripts can read the page.
7. **No secrets, no tracking.** Don't send page content anywhere. `site.fetch` reaches only the hosts listed in `site.json`'s `"hosts"`; adding one is something the user is told about.
8. **Check your work.** After saving, call `site_apply` with the tab's id: it applies the folder now and reports each part's errors, logs, and how many elements each `site.observe` selector matched (0 usually means a wrong selector). Then look at the tab (`snapshot_tab`, `read_tab`).

## `site.json`

All of it is optional; a folder with just `quiet.css` works.

```json
{
  "title": "GitHub",
  "matches": ["*://github.com/*", "*://*.github.com/*"],
  "excludes": ["*://github.com/settings/*"],
  "scope": "global",
  "parts": {
    "theme": { "title": "Desktop theme", "preset": "theme" },
    "keys":  { "title": "Keys", "runAt": "ready" },
    "quiet": { "title": "Hide promotions", "enabled": false }
  },
  "hosts": ["api.github.com"]
}
```

- `matches`, `excludes`: Chrome's match patterns. The default is the folder's host and its subdomains.
- `scope`: `"global"`, or `{ "project": "<id>" }` / `{ "thread": "<id>" }` to apply only in one project's or thread's tabs. A part can have its own `scope` too.
- A part: `title`, `enabled` (default true), `runAt` (`"ready"`, the default: when the document is parsed; `"start"`: before the page's scripts, with no `<body>` yet; `"idle"`: after load), `allFrames` (default false: the top frame only), `preset`.
- Stylesheets always go in at document start, whatever `runAt` says.

## A part's script

An ES module whose default export gets `site`. No `import`s yet: put what a part needs in its file.

```js
export default function (site) {
  site.css(`.js-issue-row:focus { outline: 2px solid AccentColor }`);

  site.observe("[data-testid='copilot-button']", (el) => {
    if (site.context.settings.hideCopilot) el.hidden = true;
  });

  site.keys.bind("j", () => site.focusNext(".js-issue-row"), { title: "Next issue" });
  site.keys.bind("k", () => site.focusPrev(".js-issue-row"), { title: "Previous issue" });
  site.keys.bind("g i", () => site.go("/issues"), { title: "Issues" });

  site.on("navigate", ({ url }) => site.log("now at", url));
  site.on("context", (context) => site.log("moved to", context.project?.title));

  return () => { /* undo anything not made through site */ };
}
```

| | |
|---|---|
| `site.css(text)` | A stylesheet; returns `{ set(text), remove() }` |
| `site.observe(selector, fn, { once })` | `fn(element)` for each match, now and as they appear; returns a stop function |
| `site.on(event, fn)` | `navigate` (single-page navigations), `visible`, `hidden`, `appearance` (light/dark changed), `context` (the tab moved to another thread or project) |
| `site.keys.bind(keys, fn, { title, inText })` | `"j"`, `"?"`, `"Ctrl+KeyK"`, chords `"g i"`. Characters match `event.key`; `KeyX`, `DigitN`, `Arrow…`, `Enter`, `Escape` match the physical key |
| `site.focusNext(selector)`, `focusPrev`, `go(path)`, `click(selector)` | Helpers for keys |
| `site.setTimeout`, `setInterval`, `listen(target, type, fn)`, `onCleanup(fn)` | Undone with the part |
| `site.storage.get(key)`, `set(key, value)`, `all()` | Per site, kept by the helper, shared by every tab; promises |
| `site.fetch(url, init)` | Through the helper, to `site.json`'s `"hosts"` only; returns a `Response` |
| `site.context` | `{ thread: { id, title }, project: { id, title, folder }, settings, shell }`: where the tab is; `settings` is this site's settings in the tab's project; `null`s outside a thread or project |
| `site.theme` | `{ scheme: "light" \| "dark" }`; pages also get `prefers-color-scheme` from the desktop |
| `site.log(...)`, `site.warn(...)` | To the site's log and `site_report` |
| `site.url`, `site.part` | The page's URL; this part's `{ id, site, name }` |

The script runs in an isolated world: it sees the page's DOM but not the page's JavaScript variables, and the page can't see it. To read something only the page's JavaScript has, read it from the DOM.

## Per project

When a request depends on the project ("in this project, link to the acme org"), put the value in the project's settings and read `site.context.settings` in the script, rather than writing the project id into the code. The project's id is in `site_report`'s context.

```json
// {{PLUTO_HOME}}/projects/<project id>.json
{ "sites": { "github.com": { "org": "acme" } } }
```

## Presets

- **Theme:** follow the desktop's light or dark (`prefers-color-scheme`), not the site's own toggle. Map the site's own CSS variables where it has them before overriding selectors. Check contrast, focus rings, and every state (hover, selected, disabled).
- **Keys:** learn the site's own shortcuts first (its `?` help, `accesskey`s); add list navigation (`j`/`k`, `Enter`, `o`), `g` chords to its main pages, `/` to search, `?` for a list of the keys you added. H/J/K/L are the arrows.
- **Declutter:** hide promoted items, recommendations, banners and sticky headers that eat the screen. Hide, don't remove.
