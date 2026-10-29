# Shells as installed packages

The shells a session runs aren't in the repository checkout. Each one is installed in its own folder, `~/.pluto/shells/<name>/`: a git repository with a `shell.json` manifest. The shells Plutonium ships (`niri` is Styx, `gnome` Charon, `plain`, and `t3` Hydra; the folder names stay as they were) are copied there on the first `plutonium run`. From then on the folder is yours. You can edit it yourself or ask an agent to, and every change can be undone.

- A shell that is just a web page is served by the session's helper.
- A shell with a server (Hydra, T3 Code's) says how to run it, and the helper runs and supervises it.
- A shell you run yourself is just an address.

Code: `helper/src/shells.ts` (manifests, installing, updating, URLs, the built-in server), `shellPackages.ts` (the helper's side: servers, edits, safety, adding), `shellServers.ts` (supervision), `shellsCli.ts` (`plutonium shells`). The switcher's parts are in Chromium patch "the switcher's installed shells…".

## Where things are

| | |
|---|---|
| `$PLUTO_HOME` | `~/.pluto`. In a worktree's slot N > 0, `$DATA_DIR/pluto-s<N>`, so tests never touch yours. |
| `$PLUTO_HOME/shells/<name>/` | one shell: `shell.json`, its files, `.git` |
| `$PLUTO_HOME/shells.json` | the session's list: which shells are on, in Super+Tab's order |
| `$PLUTO_HOME/logs/<name>.log` | a server shell's output |
| `$PLUTO_HOME/failed-starts` | starts in a row with no shell coming up (safe mode, below) |

A shell's name is its folder's name: `a-z`, `0-9` and `-`, because it's also a host name.

## The manifest

```json
{
  "title": "Plain",
  "version": "1",
  "description": "A minimal thread-based shell.",
  "static": "index.html"
}
```

| Key | |
|---|---|
| `title` | what the switcher calls it (default: the name) |
| `version` | the version shipped; `shells update` names it |
| `description` | shown when it's added |
| `static` | the page, relative to the folder: a **static shell** |
| `server` | a **server shell** (below). A manifest has either `static` or `server`. |
| `helperParam` | the query parameter that names the helper: `helper` (default), or T3's `plutoniumHelper` |
| `native` | a module the helper runs for the shell, its native side; and every installed shell has storage ([DESKTOP_SERVICES.md](DESKTOP_SERVICES.md#a-native-side-and-storage)) |
| `uses` | the desktop services it uses: `["audio", "network", …]` ([DESKTOP_SERVICES.md](DESKTOP_SERVICES.md)) |

Every page a session opens gets `?<helperParam>=http://127.0.0.1:<helper port>`. You don't write it in the manifest.

**A server Plutonium runs** (`"run": "plutonium"`):

```json
"server": {
  "run": "plutonium",
  "argv": ["{plutonium}/bin/plutonium", "t3", "serve", "--port", "{port}", "--wayland-display", "{waylandDisplay}"],
  "port": 3773,
  "health": "http://127.0.0.1:{port}/",
  "restart": "on-failure",
  "restartOnEdit": false,
  "entryCommand": ["{plutonium}/bin/plutonium", "t3", "pair-url", "--port", "{port}"]
}
```

| Key | |
|---|---|
| `argv` | the command, run detached, in its own process group |
| `cwd` | default: the shell's folder |
| `env` | extra variables. It also gets `PORT` and `PLUTONIUM_SHELL_SERVER` (the helper finds it again by that). |
| `port` | its port in slot 0; slot N adds 100 × N, as every Plutonium port does |
| `url` | the page (default `http://127.0.0.1:{port}/`) |
| `health` | polled until it answers, with any HTTP status (default: `url`) |
| `restart` | `on-failure` (default): after a non-zero exit. `always`, or `never`. |
| `restartOnEdit` | restart it when its folder changes |
| `entryCommand` | prints the URL to open instead of `url`. T3 prints one with a one-time pairing token. |

Placeholders, in `argv`, `env`, `cwd`, `url`, `health` and `entryCommand`: `{port}`, `{plutonium}` (the checkout the helper runs from), `{shell}` (the folder), `{home}`, `{helper}`, `{helperSocket}`, `{waylandDisplay}`, `{slot}`.

**An address you run yourself** (`"run": "external"`): `"server": {"run": "external", "url": "http://localhost:5173/"}`.

## Origins

Shell rights (the window broker, `<native-window>`, the tab API) go to an origin, so each shell has its own:
- **A static shell** is `http://<name>.localhost:<shells port>/`. The shells port is 8770 + 100 × slot. Chromium resolves `*.localhost` to loopback itself, and treats it as a secure context. The helper serves every static shell on that port, on 127.0.0.1 and ::1, choosing the folder by the `Host` header. It reads files on every request, so an edit shows on the next reload. It serves no dot files (`.git`), and nothing outside the folder.
- **A server shell** has its server's origin (T3: `http://127.0.0.1:3773`, plus the slot's offset), so its storage and pairing survive restarts.
- **An external shell** has its address's origin.

The launcher passes every origin that's on to the browser and the helper, as before (`SHELLS.md`). Shells added in the switcher are reported by the shell pages, as before.

## Lifecycle

**Installing.** `plutonium shells install`, and the first `plutonium run`, copy the checkout's `shells/<name>` into `$PLUTO_HOME/shells/<name>`. Each becomes a git repository with one commit, `shipped: <name> <version>`. Its branches `main` (yours) and `shipped` both start there. The first run also writes `shells.json`: T3 then plain if T3 Code is built, else plain. niri and gnome are installed, off. A later run installs shells the checkout ships that you don't have yet.

**Updating.** `plutonium shells update [name…] [--from <checkout>]` merges the checkout's version into yours:
1. Your uncommitted changes are committed.
2. The shipped files become a commit on `shipped`, made with a scratch index, so your files aren't touched.
3. `shipped` is merged into `main`. If the merge conflicts, it's undone, and the files are reported. Your copy stays as it was. `git merge shipped` in the folder does it by hand.

**Running.** `plutonium run` with no shells runs the ones that are on in `shells.json`, in its order. It passes the browser the whole list with `--plutonium-shells-exact`: `!` before shells that are off, and shells the browser has but the list doesn't name are dropped. So the switcher always starts from `shells.json`. When you add, remove, turn off or reorder shells in the switcher, a shell page reports the browser's list (`POST /v1/shell/origins`, with `shells`) and the helper writes it to `shells.json`:
- An address the switcher added that no installed shell has becomes an external shell: a folder with a manifest.
- A shell removed in the switcher stays installed, and is listed again, off, on the next start.

`plutonium run niri plain` still works. Each name is an installed shell, and `<name>=<url>` works too. That list isn't saved.

**Servers.** The helper starts the servers of the shells that are on, and session.sh waits for them (`GET /v1/shells/wait`) before the browser opens their pages.
- **Restarts.** A server that exits on its own is started again as `restart` says, after 1 s, doubling up to 30 s. More than 5 exits in 2 minutes and it's left failed.
- **It outlives the helper.** A session restart doesn't cut T3 Code's agents off: the next helper of the same session (same Wayland display and `$PLUTO_HOME`) adopts the running server, found by its pid file and `PLUTONIUM_SHELL_SERVER`.
- **On and off.** Turning a shell off in the switcher stops its server. The switcher's and the shells page's Stop keep it stopped until Start.
- `plutonium t3 server|stop [--x11]` ask the session's helper to restart or stop T3's server.

## Customizing

On a shell's page in the switcher (Super+Tab, the shell), under **Customize**:
- **Copy a prompt for your agent**: Plutonium doesn't start an agent itself. This puts a prompt on the clipboard for whichever agent you use (Claude Code, Codex, Hydra, …): read the Plutonium skill at `$PLUTO_HOME/SKILL.md`, then help change this shell, in its folder. The skill (`skill/SKILL.md` in the checkout, written to `$PLUTO_HOME` with its paths filled in by the helper) says at a glance what Plutonium is, where things are, the rules that matter (edit only `$PLUTO_HOME/shells`, saves are committed and rolled back, don't restart the session), and links to these docs.
- **Open a terminal**: your shell, in the folder, in a backup terminal tab.
- **History, log and updates…**: the helper's shells page (`/v1/shells/page/#<name>`), opened in the backup browser.

For a server shell, the switcher's page also shows its state, command and log, with Start, Restart and Stop.

**Edits.** The helper watches each shell's folder (not `.git`). Saves within 0.7 s of each other are one edit. An edit is:
1. committed as `edit: <files>`;
2. applied: a server with `restartOnEdit` restarts, then the shell's pages reload, bypassing the cache (over DevTools);
3. checked: a page of the shell has to connect to the helper (`connect()` in the shell library) within 20 s. When it does, that commit is the last good one (`refs/plutonium/good`).

## Safety

- **A change that crashes its page.** The helper watches pages over DevTools (target discovery, `Target.targetCrashed`). An installed shell's page whose renderer crashes while an edit is checked, or within five minutes of it (even after it came up; a dev build's renderer takes minutes to die after a fatal error), rolls the edit back the same way, to what was good before it (`… didn't come up (its page crashed)`). A crash with no recent edit, or a server that fails (not during an edit's restart), is only told: a `shellnotice` (`"crash"`, `"server"`) and a notification. The folder is watched afresh after each change the helper applies, since Node's recursive watcher follows files by inode: after a rollback (git's `read-tree`), or an editor's save by rename, later saves went unseen. A page that has just connected pops up notifications from the last 30 s, so a shell reloaded after its rollback shows the notice. Checked on Xvfb (2026-10-27): an edit to plain came up, its page crashed (`Page.crash`, while it showed a tab), the edit was rolled back to the last good commit, the reloaded shell popped up the notice, the next save was committed, and the browser stayed up. A shell page's renderer crashing while it shows a tab used to take the whole browser down (a performance manager CHECK on the `<embed>`'s detach); patch 0073 fixes that.
- **A change that doesn't come up.** No page connects in time, the server doesn't come up, or the manifest no longer parses. The folder goes back to the last good commit, in a new commit (`rollback: <commit> didn't come up (<why>); back to <good>`), and the shell is applied again. The failed commit is kept (`refs/plutonium/failed`). The switcher's status line and the shell's page show a notice, and so does every shell: the library's `shellnotice` event (`{ shell, title, kind: "rollback" | "crash" | "server", message }`), and a notification through the notifications service, which the shipped shells pop up. The shells page has **Retry** (the failed version, again, as a new commit), **Dismiss**, and its **diff** against the good one.
- **Safe mode.** `plutonium run --safe` runs only the plain shell shipped in this checkout (not your copy), at `http://safe.localhost:<shells port>/`. A start where no shell connects within 60 s counts as failed. After two in a row, `plutonium run` starts in safe mode by itself, says so, and tries your shells again the next time.
- **The backup terminal** is always in the switcher, whatever the shells do.

## Making a new shell

The switcher's **Add a shell…** has **New shell…**, which opens the shells page (`#new`):
- **With an agent**: copies a prompt for your agent: read the skill, ask what the shell should do, make it with `plutonium shells new`, and build it.
- **Yourself**: a name and a shell to copy (default plain). **Make it** installs the copy, on, at the end of the list.

`plutonium shells new <name> [<shell>]` does the same through the running session's helper (`POST /v1/shells/new`, `{name, from}`): the shell's files without its history, `shell.json` retitled (`title` = the name, `version` 1, `description` "Made from …"), a git repository with one commit, on. The switcher adds it to the browser's list the next time it's open. `plutonium shells prompt` prints the new-shell prompt.

## Adding a shell

The switcher's **Add a shell…** still takes a name and an address. Its **Install from a folder, git or address…** opens the shells page's form (`#add`). It takes:
- a folder with a `shell.json` (`/path` or `~/path`). It's cloned if it's a git repository, otherwise copied and committed;
- a git URL (`.git`, `git@`, `ssh://`, or a GitHub, GitLab or Codeberg project). It's cloned into `$PLUTO_HOME/shells`;
- any other http(s) address, which becomes an external shell.

Before anything is installed, **Look at it** shows the origin that gets shell rights, the page, and the command its server runs. **Add it and turn it on** installs it, on, at the end of the list. The next time the switcher is open, it adds the shell to the browser's list, and its page loads.

## The helper's API for shells

Over the helper's socket (the switcher), and from the shells page (on the helper's own origin, same user, as the terminal page). Shells may use it too.

| | |
|---|---|
| `GET /v1/shells` (also `/v1/shells/list`) | every installed shell: name, title, kind, folder, origin, page URL, version, commit, on or off, server status, notice, failed change |
| `GET /v1/shells/wait` | the same, once every starting server is up or has failed |
| `POST /v1/shells/<name>/start\|stop\|restart` | its server |
| `POST /v1/shells/<name>/terminal` | a backup terminal session in its folder; `{terminal: <id>}` (`agent` still starts `PLUTONIUM_SHELL_AGENT` there, for scripts; nothing in the UI uses it) |
| `POST /v1/shells/<name>/retry\|dismiss\|update\|reload` | |
| `GET /v1/shells/<name>/log\|history\|diff` | text |
| `POST /v1/shells/add` | `{source}` → a preview with a `token`; `{token}` → installs it |
| `POST /v1/shells/new` | `{name, from?, title?}`: a copy of an installed shell (default plain), installed on |
| `GET /v1/shells/prompt` | `{skill, new}`: where the skill is, and the new-shell prompt. Each shell's entry in `GET /v1/shells` has its own `prompt`. |

## Verified

Helper tests (`test/shells.test.ts`, run by `npm test`) cover:
- manifests, origins and entry URLs;
- install, update, and a conflicting update;
- the built-in server, which refuses dot files and paths outside the folder;
- an edit that comes up, one that's rolled back, and Retry;
- the browser's list saved to `shells.json`, and an unknown page becoming an external shell;
- adding a folder or an address;
- a server that is started, killed, restarted and stopped.

By hand, on 2026-10-26, with a helper in slot 6 and a scratch `T3_HOME`:
- T3's server starts under the helper in about 1 s;
- after a SIGKILL of its node process, it's restarted ("restarted 1 time");
- a new helper adopts the running server (same pid);
- stop and start work through the API, and the log is in `logs/t3.log`;
- an edit to the plain shell with no page connected is rolled back after 20 s, with a notice, the failed commit and its diff.

In an X11 session (slot 6, Xvfb, dev build with patches 0061–0062), on 2026-10-26:

| Check | |
|---|---|
| `plutonium run --x11` with no shells runs shells.json's list (T3 at startup, Plain, niri off). The browser drops its older entries and lists `!niri` as off | ✓ |
| Plain loads from `plain.localhost:9370` and connects. T3 pairs itself with the entry command's token | ✓ |
| A good edit to Plain: committed, reloaded, "came up". A breaking one (it throws before `connect()`): rolled back after 20 s, reloaded at the good version | ✓ |
| The switcher's shell page: Customize, the rollback notice (also in its status line), folder and version; T3's server state, command and log | ✓ |
| The switcher's Restart: T3's server restarts and its page reconnects. Turning T3 off stops its server; turning it on starts it and reloads its page | ✓ |
| Open a terminal: a backup terminal tab in the shell's folder. Ask an agent: Claude Code in a tab there, in `plutonium:shell/plain`, with the helper's socket | ✓ |
| History, log and updates…: the shells page in the backup browser, with the notice, Retry/Dismiss, the diff and the history | ✓ |
| Move down in the switcher: shells.json's order follows | ✓ |
| Add from a folder on the shells page: the preview names the origin and that there's no server. Once it's added, the next time the switcher opens it lists the shell, which loads and connects; shells.json has it on | ✓ |
| A helper restart (and a session restart) adopts T3's running server: same pid | ✓ |
| `failed-starts` at 2: `plutonium run` starts in safe mode (`safe.localhost`, the checkout's plain), says so, resets the count, and leaves shells.json alone | ✓ |

Not checked: an agent's edit end to end (an agent's save takes the same path as any other save), a git URL, and DRM.
