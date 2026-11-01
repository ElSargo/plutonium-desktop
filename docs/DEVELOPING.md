# Developing Plutonium

## Where to change what

| Change | Where | Then |
|---|---|---|
| The helper, its API, link opening, MCP tools | `helper/` (TypeScript run by Node 24 directly, no build) | restart the session, or only its helper |
| The shell library (`/v1/shell.js`) | `helper/web/plutonium-shell.js` | reload the shells; from a worktree, `plutonium live apply shell-lib` |
| A shell's UI | `shells/<name>/` (what's shipped) | the next session merges it into the installed copy; now: `plutonium shells update <name> [--from <checkout>]`, whose save reloads the shell. Or edit `$PLUTO_HOME/shells/<name>` directly, then `plutonium shells export <name>` brings the edits back here ([features/SHELL_PACKAGES.md](features/SHELL_PACKAGES.md)) |
| Hydra: T3 Code's integration | its T3 Code checkout (`T3CODE_DIR`, default `shells/hydra/src/checkout`) | `plutonium hydra build`, reload; or `plutonium hydra live apply`; commit, then `plutonium hydra export` ([shells/hydra/README.md](../shells/hydra/README.md)) |
| Hydra's launcher: serving, pairing, the database checks | `shells/hydra/bin/hydra` | the next session; now: `plutonium shells update hydra` and `plutonium shells restart hydra` |
| Chromium: Exo, the broker, elements, tabs, shell mode | the checkout in `$CHROMIUM_DIR/src`, branch `plutonium` | `plutonium chromium build`, restart the session; commit, then `plutonium chromium export` |
| The `plutonium` command: sessions, shells, setup | `bin/plutonium`, `lib/`: what a release install has too | run it again |
| A checkout's commands: the container, Chromium builds, `live`, worktrees, the bundle | `dev/commands.sh`, `dev/env.sh` | run it again |

## The core and dev/

`bin/plutonium` and `lib/` are what every install runs: sessions, shells, the login screen, `doctor`. A release install is them with `chrome/` and `node/` beside them, and runs Ash on the host. `dev/` is what only a checkout has, and the release bundle leaves out: the container (`dev/container/`), Chromium builds and the prebuilt image, `HOST=1`'s Nix build (`dev/nix/`), the live frontends, worktrees and the bundle itself (`dev/bundle/`).

No shell is part of either. A shell is its folder in `shells/`, and the core knows it only through its manifest ([features/SHELL_PACKAGES.md](features/SHELL_PACKAGES.md)): Hydra's launcher, its T3 Code patches and its release build are all in `shells/hydra/`, and `plutonium hydra …` is the manifest's `cli`.

`lib/common.sh` sources `dev/env.sh` when there is one, and `bin/plutonium` sources `dev/commands.sh`; a command the core doesn't know goes to `dev_cmd`. The core knows nothing of podman: where Ash runs is a few functions in `lib/common.sh` that `dev/env.sh` replaces when Ash runs in the container: `on_ash`, `on_ash_setsid`, `on_ash_daemon` (Xvfb), `need_ash_runtime`, `chrome_built`, `ash_prepare` (the container's fonts and `XAUTHORITY`) and `shell_library` (the live shell library). `doctor`, `status` and `session start` call `dev_doctor`, `dev_status` and `dev_session_start` for a checkout's part.

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

**A worktree:** `plutonium worktree add <name> [<start>]` makes one in `.worktrees/<name>` (on branch `<name>`), links the main checkout's `plutonium.env` into it, and gives it a **slot**. In slot N, a session's ports are 100 × N higher (DevTools, helper, the static shells' port, T3 Code), it has its own installed shells (`$PLUTO_HOME` is `$DATA_DIR/pluto-s<N>`, not `~/.pluto`), and its socket, profile and Xvfb display have their own names (`wayland-plutonium-x11-s1`, `profile-x11-s1`, `:100`). `plutonium worktree info` lists them. The main checkout is slot 0, with the usual names. For a worktree made some other way (T3 Code makes its own), run `plutonium worktree setup` in it.

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

## The release bundle

A release is one tarball that runs without podman on any x86-64 systemd distribution with a desktop: `dist/plutonium-<version>-x86_64.tar.xz`. The host provides glibc, Mesa and what Mesa links (X11, GLib, systemd's libraries, D-Bus, ALSA); the bundle carries everything else.

```
plutonium bundle build                # from a commit; chrome from this checkout's prebuilt image
plutonium bundle check                # install it in clean Ubuntu, Debian, Fedora, Arch, openSUSE containers
sh dev/bundle/install.sh --from dist/plutonium-<version>-x86_64.tar.xz   # install it here
```

`check` installs only a desktop's libraries in each container (no NSS, libinput or xkbcommon, no Vulkan driver) and the tools the installer asks for, then installs the bundle with `dev/bundle/install.sh`. It checks that every binary finds its libraries, that chrome, node, the helper and Hydra's server start, that Ash comes up on Xvfb, that `plutonium run --x11 hydra plain` as a user opens both shells, and that `--uninstall` takes it all away again. It doesn't test a DRM session, the GPU, or a real login.

`dev/bundle/install.sh` is what the site's `curl … | sh` runs: it checks the host, downloads the tarball (with its `.sha256`), checks that chrome and node start, and puts the release in `/opt/plutonium` with `chrome-sandbox` setuid root, `plutonium` in `/usr/local/bin`, and the login screen entry. Its `RELEASE_URL` is where a release is published under the fixed name `plutonium-x86_64.tar.xz`.

A release install is the core without `dev/` (above): it runs Ash on the host, from its own directory, with its own chrome, node and Hydra's server build. Its settings are `~/.config/plutonium/plutonium.env` and its logs go to `~/.local/share/plutonium/logs`. It has none of a checkout's commands; `hydra fetch`, `build`, `export` and `live` say they're for a checkout.

It's made from:
- **chrome:** the release build of exactly this checkout's patches: its prebuilt image (`plutonium image tag`), pulled if it isn't here. `--chrome-image <image>` takes another, and `--chrome-out <dir>` a local release build, which `BUNDLE` can't tie to a patch set. Less what `dev/bundle/exclude.txt` lists (the locales' build metadata and ChromeOS's accessibility extensions). The libraries it needs that the host may lack (NSS, libinput and its stack, xkbcommon) are copied from Ubuntu 22.04 into `chrome/lib`, and every binary finds them through `RUNPATH`, never `LD_LIBRARY_PATH`, which would leak into apps (`dev/bundle/collect-libs.sh`). Which libraries are the host's is `dev/bundle/host-libs.txt`: a library Mesa links has to be the host's, since one process loads both.
- **node:** the official build in `dev/bundle/node.txt`, checked against its SHA-256.
- **this checkout:** a commit (one with uncommitted changes needs `--allow-dirty`): the tracked files of `bin/`, `lib/`, `helper/` (with its `node_modules`), `shells/` and `skill/`, less what a shell's manifest `exclude`s (Hydra's `src/`).
- **the shells' builds:** what a manifest's `bundle` command builds into `shells/<name>/build`. Hydra's (`hydra bundle`) is T3 Code at `shells/hydra/src/BASE` with the patches, in its own checkout in `~/.local/share/plutonium/bundle/t3code`: T3's server bundle (`bin.mjs`), its web app without source maps, and the native packages T3's own CLI archive carries (`shells/hydra/src/runtime.ts`, from T3's lists). `hydra.env` records what `hydra` otherwise reads from T3's source (its database, last migration and pairing scopes). `--no-shell-builds` leaves them out.

`BUNDLE` in the tarball records exactly what it's made of: the commit (and `DIRTY=1` for uncommitted changes), the Chromium build's tag (empty for a local build), each shell's files as their git tree (`SHELLS`, the tree an installed copy's `shipped:` commit names), what each shell's build was made from (Hydra's T3 Code base and patches), node, and the oldest glibc it runs on (2.35 so far: Ubuntu 22.04's libinput). The tarball can't keep `chrome-sandbox` setuid, so the installer sets it. It also carries the keyboard layouts (`chrome/xkb`) and libinput's device quirks (`chrome/libinput`): Chromium reads the layouts from `/usr/share/X11/xkb` only, and the bundled libinput its quirks from `/usr/share/libinput`. NixOS has neither, so there the release's module (`lib/nixos.nix`) links those paths to the copies.

**NixOS** runs the release through nix-ld, which the release's module (`lib/nixos.nix`, what the installer tells NixOS users to import) sets up: `programs.nix-ld.enable = true`, with the libraries `dev/bundle/host-libs.txt` says are the host's in `programs.nix-ld.libraries` (`mesa libgbm libglvnd libdrm wayland expat zlib zstd libffi`, xorg's X11 libraries, `systemd dbus alsa-lib glib`, …), and nothing more: nix-ld's library path is searched before the bundle's own `RUNPATH`. Its Vulkan drivers are in `/run/opengl-driver`, where only NixOS's own Vulkan loader looks, so an X11 session adds `/run/opengl-driver/share` to Ash's `XDG_DATA_DIRS` for chrome's.

## Putting a change on your own desktop

The desktop runs a release install (`/opt/plutonium`, `plutonium status` names it), not a checkout, so a Chromium change reaches it as a new release. These steps run in the main checkout, on `main`: the bundle is made from its commit. From a T3 thread, run them with a clean environment: the thread's names the live session's helper, profile and shells.

```
R=~/projects/plutonium-desktop S=~/chromium/src
E="env -i HOME=$HOME USER=$USER PATH=/run/wrappers/bin:/run/current-system/sw/bin:/usr/bin:/bin XDG_RUNTIME_DIR=/run/user/$(id -u) LANG=C.UTF-8"

# 1. The patch: commit in the Chromium checkout, export, merge into main.
git -C $S commit …                                   # branch plutonium; a new commit is a new patch
cd $R/.worktrees/<branch> && $E bin/plutonium chromium export
git add chromium/patches docs … && git commit …      # then, in $R: git merge --no-ff <branch>

# 2. The Chromium checkout at main's series: the branch's commits on plutonium
#    (git -C $S merge --ff-only <commit> if they were made in another checkout).
cd $R

# 3. The official (LTO) build, of the Chromium checkout as it is. A change to
#    one component is a few minutes, mostly the link. It doesn't label
#    out/Official; the bundle's BUNDLE reads the label, so write it.
$E bin/plutonium chromium build --official --bg && $E bin/plutonium chromium wait 3600
echo "official $(cat chromium/BASE chromium/args.gn chromium/patches/*.patch | sha256sum | cut -c1-12)" > $S/out/Official/.plutonium-build

# 4. The bundle. Each run leaves pnpm-lock.yaml changed in its T3 Code checkout,
#    and the next refuses to start on it: put it back first.
git -C ~/.local/share/plutonium/bundle/t3code checkout -- pnpm-lock.yaml
$E bin/plutonium bundle build --chrome-out $S/out/Official   # → dist/plutonium-<version>-x86_64.tar.xz

# 5. Install and restart, as one detached unit (below).
systemd-run --user --unit=plutonium-redeploy --collect \
  --setenv=PATH=/run/wrappers/bin:/run/current-system/sw/bin:/usr/bin:/bin \
  $R/tools/redeploy.sh $R/dist/plutonium-<version>-x86_64.tar.xz $R/dev/bundle/install.sh tty2
```

**Step 5.** The installer refuses while a session runs from `/opt/plutonium`, so `tools/redeploy.sh` stops the DRM session, installs, and starts it again with `plutonium run --vt tty2` (`tty2`: the console you're logged in on), even if the install failed. As a transient unit it outlives the session it stops, and so an agent in one of that session's threads; the agent's turn is cut, and T3 continues it once the session is back. The session then runs in the unit rather than in the console's shell; `plutonium stop` ends it as usual. Its log: `journalctl --user -u plutonium-redeploy` and `~/.local/share/plutonium/logs/redeploy.log`. `plutonium status` names the release afterwards.

## Applying changes to a running session

`plutonium live` changes what a running session's shells are made of, with no restart: the helper's `shell.js` (`shell-lib`). Hydra's web app has its own, `plutonium hydra live`. niri, plain and the other installed shells need no `live`: the helper serves them from `$PLUTO_HOME/shells` on every request, and a change there reloads them. `plutonium shells update niri --from <worktree>` merges a worktree's version in.

```
plutonium live apply shell-lib --from ~/.t3/worktrees/plutonium-desktop/t3-60ce77be
plutonium hydra live apply --from ~/.t3/worktrees/t3code-oauth-popups
plutonium live status
plutonium hydra live revert
```

**How it works.** Ash gives shell rights to origins fixed when it starts (`127.0.0.1:3773`, and so on), so a worktree's own servers, on its slot's ports, can't stand in for them. What's behind those origins can change instead:
- **The links.** The helper serves `shell.js` from `$DATA_DIR/live/slot<N>/shell-lib/current`. It's a link. Until something is applied, each one points at the checkout's own files, which is how sessions worked before.
- **Hydra's T3 Code.** Its server serves its checkout's `apps/web/dist`, read on every request. The first `hydra live apply` keeps a copy of the build that's there, then makes `dist` a link to the live one.
- **`apply`** copies the part from a checkout's files as they are (a worktree an agent is working in, uncommitted changes included) or from a commit of this repository. `hydra live apply` builds a T3 Code checkout's web app into the copy, as the running server's version (about 40 s; the checkout needs its `pnpm install`). It then points `current` at the copy, in one rename, and has this slot's sessions' helpers reload the pages that use it. The page keeps its origin, so it keeps its shell rights. `--follow` points at the checkout's own files instead of a copy, so each reload shows its latest edits. `--no-reload` leaves reloading to you.
- **`revert`** goes back to the previous one. The newest `LIVE_KEEP` (5) copies of each part are kept, and `live list <part>` shows them.

**What it can't change without a restart:**
- **The T3 Code server.** Its web app talks to it through `packages/contracts`. `hydra live apply` refuses a checkout whose `apps/server/src` or `packages/contracts/src` differ from what the running server was started from: restart the server on it instead (`plutonium shells restart hydra`, with `T3CODE_DIR` pointing at it). `--force` applies it anyway. A restart cuts running agent turns, which T3 then continues.
- **The helper's own code**, and Chromium.
- **A session from before `live`.** Its helper keeps serving its own `shell.js` until the session restarts; `live status` says so.

**Reloading** loses what a page doesn't keep. niri and plain keep their layout and state in the page's storage. T3 Code's browser panel tabs move to Elsewhere, as after any reload.

Run `live` from the checkout whose slot the session is in: the main checkout for your own desktop. A worktree's `live` changes its own slot's sessions.

## Helper tests

`cd helper && npm test` runs them (Node's own test runner, no dependencies, a few seconds). They need Linux (`/proc`) and nothing else: no session, Exo or browser.
- **Unit tests** for the relay (`relay.test.ts`), thread scoping and the pid → thread resolver, the thread environment and the threads' X displays (`threads.test.ts`, with a stand-in for `systemd-socket-activate` in `test/fixtures/`), the windows agents hold (`agentWindows.test.ts`), D-Bus (`dbus.test.ts`) and accessibility (`a11y.test.ts`).
- **End to end** (`e2e.test.ts`): a helper, a fake shell page connected to it over the shell API as a real one is, the agent's MCP server (`plutonium.ts mcp`) in a thread, and a fake accessibility bus (`test/fixtures/fakeBus.ts`, a D-Bus bus with AT-SPI apps on it).

`node --test test/<file>.test.ts` runs one file. To typecheck, run `tsc -p helper` with `@types/node` available; the tests are part of the project.

## Chromium tests

Chromium's own test targets are big: from a built `chrome`, `unit_tests` is about 8,800 build steps and `browser_tests` about 8,100. Plutonium's tests are in smaller targets. Build and run them in the build container (`plutonium container shell`), with `--ozone-platform=headless`:

```
autoninja -C out/Cros plutonium_unittests content_unittests
out/Cros/plutonium_unittests --ozone-platform=headless
out/Cros/content_unittests --ozone-platform=headless --gtest_filter='RenderWidgetHostInputEventRouterTest.*Foreign*'
```

- **`plutonium_unittests`** (`chrome/test/BUILD.gn`, about 800 steps): the window broker, `IsShellDocument` and the grant checks (`features/BROKER.md`).
- **`content_unittests`** (about 1,900 steps): the input router's checks for native windows.

**Live checks** need a session: `tools/shell-checks/run.sh [--forced]` runs the broker's exclusion checks in an X11 session in the checkout's slot (`features/BROKER.md`).

## Testing a session

**Launching sessions:**
- **X11** (`plutonium run --x11 [:0]`) is the quickest loop. It needs no console switching and runs beside a DRM session: they use different sockets (`wayland-plutonium-x11` and `wayland-plutonium`), DevTools ports (9223 and 9224), helper ports (3781 and 3782) and profiles. Those are slot 0's; a worktree's are higher (Working in parallel, above).
- **DRM**, unattended or from an agent: someone stays logged in on a text console, and you run `plutonium run --vt tty2 [--hold N] …`.

**Inspecting and driving it:**
- **DevTools:** `plutonium cdp list`, `cdp eval <url-part> '<js>'` (add `--gesture` for user activation), `cdp shot`, `cdp click`, `cdp console`. Set `CDP=localhost:9223` for the X11 session. Browser tabs are targets of type `page` too.
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

## Agent tool tests

The tools agents drive apps and tabs with are tested by an agent doing a real task with them, in a standalone thread, on the live desktop or a test session on a spare VT; another agent reviews the run (`agent-tests/README.md`). Changing those tools follows the skill `.claude/skills/agent-tool-testing`: a fixer, a real run, a review, until it passes, then a final run on a fresh build.

## Docs

- **`docs/features/`**: what each feature does and how it was verified. Their test records sometimes name the old research repository's scripts and patch files. The patch numbers in `chromium/README.md` map them to the series here.
- **`docs/history/`**: the project's reports in the order they happened, from the viability study to Phase 4. They describe the code as it was then.
- **`docs/agent-tests/`**: the agent tool tests' scenarios, review brief and reports.
- **`docs/BACKLOG.md`**: everything not done.
- **`skill/SKILL.md`**: what the user's own agent reads before working on their desktop (written to `~/.pluto/SKILL.md` with real paths). It's the at-a-glance version; the docs above are the detail.

When you change behaviour, update the feature doc and the backlog. When you add something a shell can use (a library call, a `shell.json` field, a service, a `plutonium` command), add it to the skill too: a line or two and a link to its doc.
