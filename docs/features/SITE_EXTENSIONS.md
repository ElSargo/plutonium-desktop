# Site extensions: describe a change to a site, an agent writes it

**Status: steps 1 and 2 built on branch `site-extensions`, not merged** (2026-11-08): the folder, the DevTools backend, `site.context`, the agent's tools and skill, and the request a button makes. Not built: the buttons themselves, presets as files, stale detection, the sites host extension. The goals:
- from any browser tab, one button: describe a change to the site ("hide the sidebar", "j/k between results", "make it match my desktop's dark theme"), and an agent writes it as an extension;
- it applies to that tab while the agent writes it, and to every matching tab, now and on later visits, once it's done;
- extensions are small and readable (a CSS file, a JS module, a manifest), kept in git, undone in one click, and editable by hand or by asking again;
- presets for the requests everyone makes (theme to match the desktop, keys that fit the desktop's keymap, decluttering), each a prompt plus a skill the agent reads;
- an extension remembers what it was asked to do, so when the site changes and it breaks, it can be rewritten from that.

User scripts (Greasemonkey, Tampermonkey) and user styles (Stylus) do the applying part; what they lack is the writing. Here the request is the source and the code is what the agent made from it.

## How it fits together

```
 shell page (Hydra's browser panel, or any shell's tab UI)
   "Change this site…" ─────────────► helper: sites service
        ▲  status, Undo                 ~/.pluto/sites/  (git)
        │                               │  watch, commit, roll back
        │                               │  start an agent run ──► agent engine (T3 thread)
        │                               │                          reads skill, presets,
        │                               │                          the tab (lent to it)
        │                               │                          writes the folder
        │                               ▼
        │                      apply / remove, per tab
        │                               │  DevTools (helper → each tab): open tabs, context
        │                               │  the sites host (a Chrome extension): page loads, block
        │                               ▼
        └──────────────── tab renderer: the "sites" isolated world
                           each part's .css and .js, the `site` API
```

## Principles

1. **The request is the source.** Each extension keeps the requests that made it (`requests.md`). Fixing, extending or porting it to a redesigned site starts from them, not only from the old code.
2. **Live while it's written, kept when it's done.** The tab you asked from shows each save as the agent makes it. When the run finishes, the extension is kept and applies everywhere it matches, with Undo in the notice. No approval step by default (a setting turns one on, Auto-keep below).
3. **Applying and removing don't need a reload.** Everything an extension does through the `site` API (styles, listeners, observers, keys) is torn down when it's removed or changed, so an edit replaces the old version in place. An extension that can't be undone in place says so (`"reload": true`), and its tabs reload instead.
4. **Its own world.** Scripts run in an isolated world: they see the page's DOM, not its JavaScript, and the page can't see or change them. This is how extensions' content scripts and VIM_MODE.md's engine run.
5. **The page's keys stay the page's.** An extension's keys act only when the page wouldn't: never in a text field, never with Super (KEYS.md, Principle 2), and a page's own handler that calls `preventDefault()` wins.
6. **Plain files.** An extension is a folder you can read, edit and copy. No build step, no store, no packed format. Importing a user script or a user style is converting files.
7. **Works without the agent engine.** Extensions apply with or without it; without it, "Change this site…" copies a prompt for whichever agent you use, as the shells' Customize does ([SHELL_PACKAGES.md](SHELL_PACKAGES.md#customizing)).

## A site's extension

One extension per site. `~/.pluto/sites/` is one git repository, with a folder per site, named by its host. Inside, the extension is made of **parts**, one per kind of change, each with its own switch, so the theme can be off while the keys stay on:

```
~/.pluto/sites/
  github.com/
    site.json
    theme.css          a part: a stylesheet
    keys.js            a part: a script
    quiet.css          a part
    quiet.js           a part's script and stylesheet share its name
    requests.md
  presets/             the shipped presets and your own (Presets, below)
  SKILL.md             written by the helper, as $PLUTO_HOME/SKILL.md is
```

```json
{
  "title": "GitHub",
  "matches": ["https://github.com/*", "https://gist.github.com/*"],
  "excludes": ["https://github.com/settings/*"],
  "scope": "global",
  "parts": {
    "theme": { "title": "Desktop theme", "preset": "theme", "enabled": true },
    "keys":  { "title": "Keys", "preset": "keys", "enabled": true },
    "quiet": { "title": "Hide the sidebar and promotions", "enabled": false, "runAt": "ready" }
  },
  "block": ["||github.com/_private/browser/stats"],
  "hosts": [],
  "reload": false
}
```

- **`matches`, `excludes`**: Chrome's match patterns, as content scripts and user scripts use them. A new site's folder starts with its host and its subdomains (`https://*.github.com/*`, `https://github.com/*`). A request made from another host that's the same site to you ("gist is GitHub too") adds to `matches` rather than making a folder.
- **Parts**: a part is `<name>.css`, `<name>.js`, or both; a file with no entry in `parts` is a part with the defaults. `runAt` is per part: `ready` (the default: the document is parsed), `start` (before the page's scripts, with no `<body>` yet) or `idle`; stylesheets always go in at document start, so a page never flashes unstyled. `allFrames` too. A preset always writes its own part (`theme`, `keys`), so "Theme" on a site that has one edits it instead of adding another. Any other request edits the part it's about, or adds one, and the agent names it.
- **`scope`**: `global`, `project` or `thread`, as registers are scoped in VIM_MODE.md: a tab's thread is its tag, and its project the thread's ([PROJECTS.md](PROJECTS.md)). A site starts global; the run's notice offers "only in this project". A part can narrow it.
- **`block`**: requests never to make, in uBlock's network filter syntax (a subset: `||host/path`, `$script`, `$third-party`). Only with the sites host (Applying); without it they're ignored, and the site's status says so.
- **`requests.md`**: each request, dated, with its part, the run's thread, and what the agent said it did. Appended by the helper, not the agent.

In the rest of this doc, "an extension" is a site's folder.

### A part's script

An ES module, run in the sites world of each matching frame. Its default export gets the `site` API (`keys.js` here):

```js
export default function (site) {
  site.css(`.js-issue-row:focus { outline: 2px solid var(--pluto-accent) }`);   // removed with the part

  site.observe(".js-issue-row", (row) => {                // now and whenever one appears
    row.querySelector(".Label")?.classList.add("pluto-dim");
  });

  site.keys.bind("j", () => site.focusNext(".js-issue-row"), { title: "Next issue" });
  site.keys.bind("k", () => site.focusPrev(".js-issue-row"), { title: "Previous issue" });
  site.keys.bind("g i", () => site.go("/issues"), { title: "Issues" });

  site.on("navigate", ({ url }) => { /* single-page apps: pushState, popstate */ });

  return () => { /* anything not made through `site` */ };
}
```

| | |
|---|---|
| `site.css(text)` | A stylesheet, as a user stylesheet where the backend allows it (Applying, below); returns a handle with `set(text)` and `remove()` |
| `site.observe(selector, fn, { once })` | Runs `fn` on each matching element, now and as they appear: the MutationObserver every robust user script ends up writing |
| `site.on(event, fn)` | `navigate` (history API and hash changes), `visible`, `hidden`, `appearance` (the desktop's light or dark changed) |
| `site.keys.bind(keys, fn, opts)` | Keys inside the page, in KEYS.md's spelling, chords included (`g i`); `when` can use `textFocus` and the site's own state |
| `site.focusNext`, `focusPrev`, `go`, `click` | Small helpers for the keys preset |
| `site.storage` | `get`, `set`: per site, kept by the helper, the same in every tab |
| `site.fetch(url, init)` | Network through the helper, to hosts the extension lists in `site.json` (`"hosts"`) |
| `site.desktop.call(name, args)` | A function `config.js` exports (KEYS.md), as `vim.desktop.call` |
| `site.theme` | The desktop's tokens (Theming, below), and `onChange` |
| `site.context` | Where the tab is: its thread, project, shell, and this site's settings from the project (The tab's context, below); `site.on("context")` when it moves |
| `site.log`, `site.warn` | Go to the site's log, with the part's name, which the agent reads |

`~/.pluto/sites/site.d.ts` is installed alongside, so editors and agents get completion.

### The tab's context

A script can depend on where the tab is: hide a button in one project, send links to another organisation's pages in another.

```js
site.context = {
  thread: { id: "8037d88a-…", title: "Vim Mode for Text Input" },   // null: a tab in no thread
  project: { id: "5ac65e70-…", title: "Plutonium", folder: "/home/sargo/projects/plutonium-desktop" },   // null: no project
  settings: { org: "acme", hideCopilot: true },   // this site's settings in the project, or {}
  shell: "hydra",
};

site.observe(".copilot-button", (el) => { if (site.context.settings.hideCopilot) el.hidden = true; });
site.on("context", (ctx) => { /* the tab moved to another thread or project */ });
```

- **It's there when the script starts.** Hiding something before it paints, or `location.replace()` before the page shows, can't wait for an answer, so the context is part of what's injected at document start, not something the script asks for.
- **It changes while the page is open.** A kept site's tab moves between threads when you press its dock slot ([HYDRA_DOCK.md](HYDRA_DOCK.md#sites-in-a-scope-t3-patch-0034-2026-10-27)). The runtime then runs `context` listeners, and parts whose `scope` stops or starts matching come off or go on, in place (Principle 3).
- **Where it comes from.** A tab's thread is its tag. Its project is the thread's, from the project record ([PROJECTS.md](PROJECTS.md)); until the helper has projects, it reads Hydra's (T3's state database, read only) for a thread's project, title and folder. A tab tagged with a project (`t3:project/<id>`, a site kept per project) has that project and no thread.
- **Settings.** A project's config can hold values for each site, so one extension works in every project and an agent asked "in this project, send GitHub links to the acme org" changes a setting, not the code:
  ```json
  "sites": { "github.com": { "org": "acme", "hideCopilot": true } }
  ```
  They're read from your own file for the project (`~/.pluto/projects/<id>.json`), and from the folder's `.pluto/project.json` once you trust it (PROJECTS.md, Trust). Until the helper has its own project ids, the id is Hydra's.
- **URLs.** A script rewrites links on the page, and can redirect at document start. Redirecting the navigation itself, before the request is made, is a `declarativeNetRequest` session rule limited to the tab's id (`tabIds`), which the sites host adds per tab once tabs have ids (EXTENSIONS.md).
- **Keep it in the script.** The context is for the script's decisions: the skill tells agents not to write it into the page, where the site's own scripts could read it.

## Applying

The helper's sites service watches `~/.pluto/sites/` (as it watches shells' folders), commits each settled save (`edit: github.com/keys.js`), and keeps, for every open tab, which sites match it and the tab's context. A change re-applies only that part, only in the tabs it matches.

Two backends share the work, and the format doesn't change between them: the agent writes a stylesheet and a module per part, and the backends turn them into calls.

### DevTools from the helper: open tabs, and the context

The helper already reaches every tab over the session's DevTools socket (`cdp.ts`, [AGENT_CONTROL.md](AGENT_CONTROL.md)). It attaches to each registry tab and:
- `Page.addScriptToEvaluateOnNewDocument({ source, worldName: "plutonium-sites", runImmediately: true })` with the runtime (the `site` API), that tab's context, and its parts, for the next navigation and the current page;
- `Page.createIsolatedWorld` (the same named world) and `Runtime.evaluate` to add, replace or remove a part in a page that's already loaded, and to send a new context;
- `Runtime.addBinding` for what comes back (`storage`, `fetch`, logs and errors), in that world only. It's added by the world's context id after each new document (`Page.frameNavigated`): a binding by context name only reaches new contexts while the Runtime domain is enabled, and Runtime stays off, since sites can detect it. Until the binding is there, the runtime queues what it sends.

This is the whole backend at first: hand-written sites, runs and the button all work on it. What it can't do:
- **Styles are author styles.** `site.css` adds a `<style>` the page can see and, in principle, remove. `!important` is needed more often than with a user stylesheet.
- **No CSP of its own.** The world shares the page's network access.
- **Only frames in the tab's own process.** Out-of-process frames need `Target.setAutoAttach`, later.

### The sites host: a Chrome extension of ours

One extension, loaded at every start and kept in sync with `~/.pluto/sites/` by the helper ([EXTENSIONS.md](EXTENSIONS.md)). Checked 2026-11-08: these work in registry tabs today, without tab ids:
- parts' scripts registered with `userScripts.register` (matches, run-at, all frames, out-of-process frames included), in a world whose CSP has no network (`userScripts.configureWorld({ csp: "… connect-src 'none'" })`), for every later page load;
- `block` as dynamic `declarativeNetRequest` rules, so a site's extension can stop a request, not only hide what it loaded.

What needs tab ids (EXTENSIONS.md, Tabs and windows), and stays on DevTools until then:
- putting a change into a page that's already open (`userScripts.execute`), which is what makes the button feel instant;
- user stylesheets (`scripting.insertCSS({ cssOrigin: "user" })`, outside the page's DOM, removed with `removeCSS`);
- the tab's context: registered scripts are the same for every tab, and an extension can't tell which thread a tab is in (EXTENSIONS.md keeps tags from extensions). At first a tiny per-tab DevTools script sets `site.context` at document start beside the host's; with tab ids, the registry hands a tab's context to its renderer for the sites world only (a small Chromium change), and per-tab redirects become session rules with `tabIds`.

Once tab ids are in, the DevTools backend goes, and nothing about sites changes. Exporting a site as a standalone Chrome extension (`plutonium sites export github.com`) is the same translation, written to a folder (no context, no helper).

## Making one

### The button

- **Hydra:** a button in the browser panel's toolbar, beside the address (a T3 patch), and the same in a tab's context menu. Its popover shows the site's parts, each with a switch and **Edit** (asks the agent again), and **Open folder**; then a text box ("Describe a change to github.com…") and the presets as chips.
- **Other shells:** the shell library's `shell.sites` (`forTab(id)`, `request(tabId, text, { preset })`, `toggle`, `undo`), and a popover the library ships for shells to place wherever their tab UI is.
- **Keys:** an action, `site.change`, bound to Super+Period by default (KEYS.md's catalogue), for the focused tab.
- **`config.js` and agents:** `desktop.sites`, the same calls.

### The run

1. The helper makes the site's folder, or uses the one that matches the tab, and appends the request to `requests.md`. A preset's request names its part; Edit on a part names that one; otherwise the agent picks the part from the request and the parts already there.
2. It starts a thread through the agent API ([PROJECTS.md](PROJECTS.md#the-agent-engine-and-its-api)) in a folderless project, **Sites**, with the folder as its working directory and a prompt that names the tab, the part, the preset if any, and the skill. The Sites project shows in Hydra's sidebar like any other, so every run's thread is there to follow up in.
3. **The tab is lent to the thread** for the run: it gets the run's thread as a second tag, so the agent's tab tools (snapshot, evaluate, click) reach it. Nothing else of the user's thread is lent. The tag comes off when the run ends.
4. The agent reads the page, writes files, and checks with two tools:
   - `site_apply`: apply the folder to the lent tab now; returns the errors the script threw, what it logged, and which `site.observe` selectors matched nothing;
   - `site_snapshot`: the lent tab's screenshot and accessibility tree, as `snapshot_tab`.
   Each save applies to the lent tab anyway (Principle 2); `site_apply` is for the agent to wait for the result.
5. When the run ends, the helper commits it as one commit (`run: github.com/quiet "hide the sidebar"`), and applies it to every tab it matches. The popover, or a notification if it's closed, says what changed, with **Undo** and **Open thread**. Following up in the thread is another run on the same extension.

A run that fails, or leaves a script that throws on load, is rolled back to the site's last good commit, with the thread kept for a look.

### Auto-keep

`~/.pluto/sites/settings.json`: `"autoKeep": true`, the default (decided 2026-11-08). With `false`, a run's result stays on the lent tab only until you press **Keep**. A list of hosts can always ask (`"askOn": ["*.bank.example"]`), so extensions for sites you care most about don't keep without a look.

## Presets

A preset is a Markdown file in `~/.pluto/sites/presets/`: front matter (a title, an icon, what it's for), then the prompt the agent gets on top of the request, and links into the skill. "Theme" and "Keys" with no text are whole requests; with text, the text narrows them ("Keys: like Gmail's").

| Preset | What it asks for |
|---|---|
| **Theme** | Restyle the site with the desktop's tokens, in light and dark, following the desktop's choice rather than the site's own toggle. Map the site's own CSS variables where it has them (most design systems do) before overriding selectors. Check contrast, focus rings, and every state the page shows (hover, disabled, selected) |
| **Keys** | Learn the site's own shortcuts first (its help dialog, `accesskey`s, the keydown listeners), keep the good ones, and add list navigation (j/k, Enter, o), `g` chords to its main pages, `/` to search, and `?` for a which-key list. Nothing with Super, nothing in text fields, H/J/K/L as the arrows (KEYS.md, Principle 4) |
| **Declutter** | Hide what isn't the content: promoted items, recommendations, banners, sticky headers that eat the screen. Hide, don't remove, so the page's scripts don't break |
| **Readable** | A comfortable measure and line height, larger text, no layout shift from late ads |
| **Dark** | For sites with no dark mode, when you don't want the desktop's tokens: a dark version close to the site's own look |

Shipped presets are copied into `presets/` as shells are installed: yours can be edited, and an update merges ([SHELL_PACKAGES.md](SHELL_PACKAGES.md#lifecycle)). A preset you write is one more file there.

### Theming

The Theme preset needs tokens to theme with, and the desktop doesn't have a shared set: light or dark is the desktop's ([APPEARANCE.md](APPEARANCE.md)), accents are each shell's.
- **First:** the helper gives the world `--pluto-*` variables from the visible shell: Hydra's theme variables (background, surfaces, text, muted text, accent, border, radius, font), plain and Charon's library tokens (`helper/web/ui/`). Light or dark follows APPEARANCE.md, so a themed site switches with the desktop.
- **Later:** one set of desktop tokens the shells share and the helper serves, which this and GTK theming could both read. That's its own design; until then, a themed site matches the shell that's showing it.

`site.theme` has the same tokens for scripts (canvas apps, inline styles).

### Keys and the desktop's keymap

An extension's keys are handled in the page, so they need nothing from the browser. They're also reported to the helper, so they appear where keys are listed:
- the which-key overlay and `keys.help` show them under the site, with `tabHost == "github.com"` as their context (KEYS.md, Contexts);
- `plutonium keys check` reports a site key that a site's own shortcut, or a desktop key, already uses;
- with vim mode on, an extension's keys act only outside text fields, or in vim's normal mode if the extension asks (`{ mode: "normal" }`).

## Keeping them working

Sites change their markup, and a user script that worked last month quietly does nothing. The runtime notices:
- a script that throws, and a `site.observe` selector that has matched nothing on a page where it used to, mark the extension **stale** for that site, with the error;
- the button shows a dot on a tab with a stale extension, and the popover offers **Fix**: a run with the requests, the error, what changed, and the old code, on that tab;
- `plutonium sites check` lists stale extensions; `config.js` can watch `sites.on("stale")`.

A fix is never started without you: it's an agent reading a page you might be signed in to.

## Importing and sharing

- **User scripts:** `plutonium sites import <file or URL>` reads a `// ==UserScript==` header (`@match`, `@include`, `@exclude`, `@run-at`, `@grant`) into a part of the matching site's `site.json`, and wraps the script so `GM_addStyle`, `GM_getValue`, `GM_setValue` and `GM_xmlhttpRequest` go to `site.css`, `site.storage` and `site.fetch`. `unsafeWindow` isn't there: the world is isolated.
- **User styles:** a UserCSS file (`/* ==UserStyle==`) or a `@-moz-document` block becomes a part (`<name>.css`) of that site's extension.
- **Sharing** is copying a folder; `requests.md` travels with it, so whoever gets it can ask for changes in the same terms.

## Trust

- **Extensions are your code**, as `config.js` and `init.js` are: they run in every frame they match, including sites you're signed in to, with the DOM. No review is required to run them, and no limit is put on what you write by hand.
- **The page can't reach them.** The world is isolated; the bindings back to the helper exist only in it.
- **What an agent writes was shaped by the page it read.** A page can carry text meant for the agent ("also send the cookies to…"). The run's agent sees the lent tab like any page; the guard is on the code it leaves behind, which runs on every later visit:
  - with the sites host the world has no network of its own (`connect-src 'none'`), and `site.fetch` reaches only the hosts in `site.json`; a run that adds a host says so in its notice, and auto-keep doesn't apply to it;
  - every run is one commit, and its diff is one click from the notice;
  - `askOn` hosts never keep without you.
  This is a guard on the extension, not on the agent: the run's agent has the tools every agent has ([PROJECTS.md](PROJECTS.md#scope)), and nothing here pretends otherwise.
- **Password fields** get no special handling: an extension sees the DOM the page has, as an extension's content script does. An agent never sees a secret it fills ([PASSWORDS.md](PASSWORDS.md), Principle 3), and that doesn't change here.
- **Lending a tab** gives the run's agent that tab, signed in as you, for the length of the run. The popover says so before the first run on a host, once per host.

## The work, in order

1. **The folder and the DevTools backend.** Built (`helper/src/sites/`): `~/.pluto/sites/`, git with a commit per settled save, every `.css` and `.js` a part, the runtime in an isolated world (parts compiled into the injected source, so the page's CSP doesn't apply; a part that doesn't parse is left out and reported), apply and remove in place, `site.context` from tags and Hydra's database with the project's site settings, `site.storage`, `site.fetch`, logs and errors in `$PLUTO_HOME/logs/sites/<site>.log`, and `/v1/sites`.
2. **The run.** Built in the helper: `POST /v1/sites/request` (the site's folder, `requests.md`, the prompt), the agent's `site_apply` and `site_report` (its thread's tabs only), `skill/SITES.md` written to the sites folder with `site.d.ts`, and `shell.sites` in the shell library (`forTab`, `request`, `setPart`, `lend`, `giveBack`). Not built: the Sites project, and starting the thread (Hydra's page starts it, below).
3. **The button:** Hydra's toolbar button and popover (a T3 patch: it calls `shell.sites.request`, starts a thread in a Sites project with the prompt, lends the tab, gives it back when the run ends), the library's popover for other shells, the `site.change` action.
4. **Presets** as files in `presets/` (the skill describes Theme, Keys and Declutter for now); the keys reported to the which-key overlay once KEYS.md's catalogue exists.
5. **Stale detection and Fix.** `site_report` already counts each `site.observe` selector's matches.
6. **The sites host extension:** `userScripts.register` with the world's CSP, and `block` rules, beside DevTools; then, with EXTENSIONS.md's tab ids, live changes, user stylesheets, the context from the registry, and DevTools off.
7. **Import** of user scripts and user styles.

### Checked (2026-11-08, X11 slot 52, plain shell)

| | |
|---|---|
| A hand-written site applies to a new tab: its stylesheet, its observer (6 paragraphs on example.com), and the page's own scripts can't see the runtime | ✅ |
| Keys: a `g h` chord fires; the page's own listener sees each key first | ✅ (a tab only gets keys while a shell shows it) |
| Editing a stylesheet, and switching a part off through `/v1/sites/<site>/parts/<part>`: applied in place, same page, cleanup runs; each save committed | ✅ |
| `site.context`: a tab kept per project gets the project's title, folder and its `org` setting; a tab in a Hydra thread gets the thread's title and project (T3 0.1's `orchestration_v2_projection_threads`); a tag added while the page is open fires `context` in place | ✅ |
| A part that throws (at start and in an observer), a part that doesn't parse: reported per part, in the site's log, the others keep running | ✅ |
| Navigating away and back: parts come off on another site and back on return; the binding reconnects (storage count 1, 2, 3 across documents) | ✅ |
| `site_apply` through a thread's route: refused for a thread the tab isn't in; after lending (a tag), it applies and reports (10 matches), and is refused again after the tab is given back | ✅ |
| `POST /v1/sites/request` from the shell page: makes `wikipedia.org/`, appends to `requests.md`, returns the prompt | ✅ |
| Helper tests (`npm test`): 320 pass, with `test/sites.test.ts` (16) | ✅ |

## Open questions

1. **A name.** "Site extensions" in the docs; the button might say "Change this site…". Something shorter for the folder and the API.
2. **Native apps.** The same idea for GTK apps (a CSS file per app) or Electron apps (a script in the app's DevTools) is possible, and out of scope here.

## Decisions

- 2026-11-08: runs are kept automatically, with Undo (`askOn` for hosts that should ask); one extension per site, made of parts that switch on and off separately; the Sites project's threads show in Hydra's sidebar; v2 is a Chrome extension of ours on EXTENSIONS.md, not a Chromium registry of its own.
- 2026-11-08: scripts get the tab's context (`site.context`: thread, project, the project's settings for the site, the shell), synchronously at document start and updated when the tab moves; the sites host extension comes in beside the DevTools backend (registered scripts, `block` rules) rather than after it, and DevTools keeps open tabs and the context until tabs have ids. Scripts shouldn't write the context into the page.
