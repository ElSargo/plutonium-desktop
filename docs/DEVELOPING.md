# Developing Plutonium

## Where to change what

| Change | Where | Then |
|---|---|---|
| The helper, its API, link opening, MCP tools | `helper/` (TypeScript run by Node 24 directly, no build) | restart the session, or only its helper |
| The shell library (`/v1/shell.js`) | `helper/web/plutonium-shell.js` | reload the shells; from a worktree, `plutonium live apply shell-lib` |
| A shell's UI | `shells/<name>/index.html` | reload the page (`plutonium live reload <name>`); from a worktree, `plutonium live apply <name>` |
| T3 Code's integration | the checkout in `frontends/t3code/checkout` | `plutonium t3 build`, reload; or `plutonium live apply t3`; commit, then `plutonium t3 export` |
| Chromium: Exo, the broker, elements, tabs, shell mode | the checkout in `$CHROMIUM_DIR/src`, branch `plutonium` | `plutonium chromium build`, restart the session; commit, then `plutonium chromium export` |

## Chromium workflow

The patch series in `chromium/patches/` is the source of truth. The checkout's `plutonium` branch is that series applied to `chromium/BASE`.

1. Work on the `plutonium` branch. Build with `plutonium chromium build`; incremental builds take seconds to a few minutes. Restart with `plutonium stop --drm` and `plutonium run …`.
2. Commit, either as new commits or fixups squashed into the patch they belong to (`git rebase -i chromium/BASE`).
3. Run `plutonium chromium export`. It rewrites `chromium/patches/` from `BASE..HEAD`, with stable patch headers, so diffs between versions stay readable. Commit those patches here.

**Moving to a newer Chromium:**
1. Rebase the branch onto the new revision and fix any conflicts.
2. Put the new hash in `chromium/BASE`.
3. Run `gclient sync -D` in the container (`plutonium container shell`), then build.
4. Run `plutonium chromium export`.

**Applying a series is cheap.** `plutonium chromium patch` applies the patches to a scratch index and then moves the checkout to the result, so it writes only the files that differ from what the checkout has. Moving between two series rebuilds only what differs between them, not everything the patches touch. A series it has applied before takes under a second.

**Running anything inside the container:** `plutonium container shell` opens a shell there with depot_tools on `PATH`, for example to run `gn args`, `autoninja` or a unit test. Exo's tests are `autoninja -C out/Plutonium exo_unittests`.

## Working in parallel

Several checkouts (git worktrees) can be worked on at once, by people or agents, each with its own sessions.

**A worktree:** `plutonium worktree add <name> [<start>]` makes one in `.worktrees/<name>` (on branch `<name>`), links the main checkout's `plutonium.env` into it, and gives it a **slot**. In slot N, a session's ports are 100 × N higher (DevTools, helper, the niri and plain shells' servers, T3 Code) and its socket, profile and Xvfb display have their own names (`wayland-plutonium-x11-s1`, `profile-x11-s1`, `:100`). `plutonium worktree info` lists them. The main checkout is slot 0, with the usual names. For a worktree made some other way (T3 Code makes its own), run `plutonium worktree setup` in it.

Settings for one worktree go in its `plutonium.local.env`, which is read after `plutonium.env`. For example, `T3_HOME=…` to run T3 Code there: Plutonium won't run two T3 Code servers on the same data.

Worktrees inside the main checkout are visible in the container, at the same path. Ones elsewhere work too, except that `plutonium cdp` runs the main checkout's `tools/cdp.py`.

**One Chromium checkout for all of them.** There's one `$CHROMIUM_DIR/src` and one out dir, so:
- **Taking turns.** `chromium patch`, `build`, `ensure` and `export` take a lock, and wait for whoever has it (`plutonium status` says who).
- **In the background.** Add `--bg` to `patch`, `build` or `ensure`, and the command runs as a systemd user unit, outlasting your shell and an agent's command timeout. Its output goes to `logs/chromium.log`. `plutonium chromium wait [seconds]` waits for it and exits with its status, or with 124 if it's still running after that many seconds.
- **A build per series.** A dev build of a checkout's own series, as it is, is kept in `$BUILDS_DIR/<key>`. The key is a hash of `BASE`, `args.gn` and the patches. It's a copy of what chrome runs with, made with reflinks on btrfs, so it costs almost nothing. That checkout's sessions run it, so they keep working while someone else's build changes the out dir. The newest `BUILDS_KEEP` (6) are kept, plus any that a session is running.
- **`plutonium chromium ensure`** gets a checkout its build. It reuses the kept one if there is one. Otherwise it moves the Chromium checkout to the series (detached, so no branch moves), builds it, keeps it, and moves the checkout back. It refuses if the Chromium checkout has uncommitted changes, since someone is working in it.
- **Which build a session runs** (without `PREBUILT=1`): the out dir if it holds more work on top of this checkout's series (you're working in the Chromium checkout); else this series' kept build; else the out dir, whatever it holds. `plutonium status` names it.

A worktree that doesn't change `chromium/patches` doesn't need any of this with `PREBUILT=1`: the prebuilt image's tag is a hash of the same files, so it runs the same image as the main checkout. To run a dev build in a worktree that does change them, put `PREBUILT=` and `CONTAINER=plutonium` (the build container) in its `plutonium.local.env`.

**ccache.** With `CCACHE=1`, the compiler runs through ccache, and coming back to a series built before costs a fraction of the build. The cost is Chromium's clang modules, which ccache can't cache and so are turned off. Building `//base`: 61 s with modules; 99 s without, cold; 28 s with every compile from the cache. Turning it on or off rebuilds everything once. The build container needs ccache (in the Containerfile since this change; `plutonium container build`, then create it again).

## Publishing the prebuilt image

After the Chromium patches change:

```
plutonium chromium build --release   # out/Release
plutonium image build                # stage, strip, build ghcr.io/elsargo/plutonium:chromium-<hash>
plutonium image login                # once; needs gh auth refresh -s write:packages
plutonium image push                 # that tag and :latest
```

Test it before pushing: `PREBUILT=1 CONTAINER=plutonium-prebuilt plutonium container create`, then run sessions with the same two variables set.

## Applying changes to a running session

`plutonium live` changes what a running session's shells are made of, with no restart: niri, plain, the helper's `shell.js` (`shell-lib`), and T3 Code's web app (`t3`).

```
plutonium live apply niri plain --from ~/.t3/worktrees/plutonium-desktop/t3-60ce77be
plutonium live apply t3 --from ~/.t3/worktrees/t3code-oauth-popups
plutonium live status
plutonium live revert t3
```

**How it works.** Ash gives shell rights to origins fixed when it starts (`127.0.0.1:8775`, and so on), so a worktree's own servers, on its slot's ports, can't stand in for them. What's behind those origins can change instead:
- **The links.** The shell servers serve `$DATA_DIR/live/slot<N>/<part>/current`, and the helper serves `shell.js` from `shell-lib/current`. These are links. Until something is applied, each one points at the checkout's own files, which is how sessions worked before.
- **T3 Code.** Its server serves its checkout's `apps/web/dist`, read on every request. The first `apply t3` keeps a copy of the build that's there, then makes `dist` a link to the live one.
- **`apply`** copies the part from a checkout's files as they are (a worktree an agent is working in, uncommitted changes included) or from a commit of this repository. For t3, it builds the checkout's web app into the copy, as the running server's version (about 40 s; the checkout needs its `pnpm install`). It then points `current` at the copy, in one rename, and reloads every page of this slot's sessions that uses the part, bypassing the cache. The page keeps its origin, so it keeps its shell rights. `--follow` points at the checkout's own files instead of a copy, so each reload shows its latest edits. `--no-reload` leaves reloading to you.
- **`revert`** goes back to the previous one. The newest `LIVE_KEEP` (5) copies of each part are kept, and `live list <part>` shows them.

**What it can't change without a restart:**
- **The T3 Code server.** Its web app talks to it through `packages/contracts`. `apply t3` refuses a checkout whose `apps/server/src` or `packages/contracts/src` differ from what the running server was started from: restart the server on it instead (`plutonium t3 server`, with `T3CODE_DIR` pointing at it). `--force` applies it anyway. A restart cuts running agent turns, which T3 then continues.
- **The helper's own code**, and Chromium.
- **A session from before `live`.** Its shell servers serve other files. The first `apply` of a shell restarts that shell's server on the link, which pages don't notice. Its helper keeps serving its own `shell.js` until the session restarts; `live status` says so.

**Reloading** loses what a page doesn't keep. niri and plain keep their layout and state in the page's storage. T3 Code's browser panel tabs move to Elsewhere, as after any reload.

Run `live` from the checkout whose slot the session is in: the main checkout for your own desktop. A worktree's `live` changes its own slot's sessions.

## Testing a session

**Launching sessions:**
- **X11** (`plutonium run --x11 [:0]`) is the quickest loop. It needs no console switching and runs beside a DRM session: they use different sockets (`wayland-plutonium-x11` and `wayland-plutonium`), DevTools ports (9223 and 9224), helper ports (3781 and 3782) and profiles. Those are slot 0's; a worktree's are higher (Working in parallel, above).
- **DRM**, unattended or from an agent: someone stays logged in on a text console, and you run `plutonium run --vt tty2 [--hold N] …`.

**Inspecting and driving it:**
- **DevTools:** `plutonium cdp list`, `cdp eval <url-part> '<js>'` (add `--gesture` for user activation), `cdp shot`, `cdp click`, `cdp console`. Set `CDP=localhost:9223` for the X11 session. Browser tabs are targets of type `other`, and they work too.
- **Input on DRM without a person:**
  1. `sudo tools/uinput.py <fifo>` creates a virtual keyboard and mouse. Start it **before** the session, because the container doesn't see devices plugged in later.
  2. Write commands to the fifo: `type`, `key LEFTMETA+T`, `move`, `click`, `down`/`up`, `scroll`.
- **The screen:** `tools/kmsshot.sh out.png` captures the primary plane with sudo and ffmpeg. `tools/kms-planes.sh` shows which planes are in use. On X11: `plutonium container shell`, then `import -window root out.png` with `DISPLAY` set.
- **Logs:**
  - `logs/ash-<socket>.log`: Ash. Raise detail with `--flags "--vmodule=embedded_windows=1,…"`.
  - `logs/helper-<socket>.log`: the helper.
  - `logs/session-<socket>.log`: the launcher.
- **An app's Wayland traffic:** start it with `WAYLAND_DEBUG=1`, through `plutonium helper launch <thread> env WAYLAND_DEBUG=1 <app>`.

**Process-matching rule.** In the container, and on the host, `pkill -f`/`pgrep -f` see every process of yours. A pattern that appears literally in your own command line matches your shell too. The scripts anchor their patterns (`^<chrome> --enable-wayland-server … --user-data-dir=<profile>`); do the same, or use a bracket (`'weston-dn[d]'`).

## Docs

- **`docs/features/`**: what each feature does and how it was verified. Their test records sometimes name the old research repository's scripts and patch files. The patch numbers in `chromium/README.md` map them to the series here.
- **`docs/history/`**: the project's reports in the order they happened, from the viability study to Phase 4. They describe the code as it was then.
- **`docs/BACKLOG.md`**: everything not done.

When you change behaviour, update the feature doc and the backlog.
