# Developing Plutonium

## Where to change what

| Change | Where | Then |
|---|---|---|
| The helper, its API, link opening, MCP tools | `helper/` (TypeScript run by Node 24 directly, no build) | restart the session, or only its helper |
| A shell's UI | `shells/<name>/index.html` | reload the page (DevTools, or `plutonium cdp eval <part> 'location.reload()'`) |
| T3 Code's integration | the checkout in `frontends/t3code/checkout` | `plutonium t3 build`, reload; commit, then `plutonium t3 export` |
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

**Running anything inside the container:** `plutonium container shell` opens a shell there with depot_tools on `PATH`, for example to run `gn args`, `autoninja` or a unit test. Exo's tests are `autoninja -C out/Plutonium exo_unittests`.

## Publishing the prebuilt image

After the Chromium patches change:

```
plutonium chromium build --release   # out/Release
plutonium image build                # stage, strip, build ghcr.io/elsargo/plutonium:chromium-<hash>
plutonium image login                # once; needs gh auth refresh -s write:packages
plutonium image push                 # that tag and :latest
```

Test it before pushing: `PREBUILT=1 CONTAINER=plutonium-prebuilt plutonium container create`, then run sessions with the same two variables set.

## Testing a session

**Launching sessions:**
- **X11** (`plutonium run --x11 [:0]`) is the quickest loop. It needs no console switching and runs beside a DRM session: they use different sockets (`wayland-plutonium-x11` and `wayland-plutonium`), DevTools ports (9223 and 9224), helper ports (3781 and 3782) and profiles.
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
