# Building Chromium from source

A checkout of Plutonium runs its own build of Plutonium's Chromium ([INSTALL.md](../INSTALL.md), step 3); the release carries one. Expect an afternoon: the download is 28 GB (4 minutes on a fast connection), and the first build takes about two hours on 32 threads.

**What it needs, besides [INSTALL.md](../INSTALL.md)'s step 1:**
- 32 GB of RAM is better than 16.
- About 60 GB of free disk: about 28 GB for the checkout (sources and dependencies, no history), 21 GB for the build, and 2 GB for the container image.
- Many cores.

Two settings in `plutonium.env` decide where the checkout goes; put them on a fast disk with room:
- **`CHROMIUM_DIR`** (`~/chromium`) holds `.gclient` and `src/`;
- **`DEPOT_TOOLS`** (`~/depot_tools`).

## 1. The build container

```
plutonium container build     # Ubuntu 24.04 + Chromium's build dependencies (~1.6 GB, ~10 min)
plutonium container create    # creates and starts the container 'plutonium'
```

The container shares the host's process IDs (Exo must see your apps' real pids), network, GPU (`/dev/dri`) and input devices. It mounts this repository, the Chromium checkout, depot_tools, the data dir and `$XDG_RUNTIME_DIR` at the same paths as on the host. Its home is `~/.local/share/plutonium/container-home`.

After a reboot, run `plutonium container start`.

## 2. Chromium

```
plutonium chromium fetch      # depot_tools, then the checkout at chromium/BASE
plutonium chromium patch      # the patch series, on a branch 'plutonium'
plutonium chromium build      # out/Plutonium/chrome
```

- **`fetch`** clones depot_tools and writes a `.gclient` for Chromium with `target_os = ['chromeos']`. It then syncs straight to the pinned revision with no history and 4 jobs (googlesource rate-limits the default), and runs the hooks. If it stops partway, run it again; it resumes.
- **`patch`** refuses to touch a checkout with uncommitted changes. Run it again with `--force` to reset the `plutonium` branch.
- **`build`** copies `chromium/args.gn` into the build dir and runs `autoninja`. Incremental builds after that take seconds to minutes. It's a development build: faster to rebuild, and it stops on internal assertion failures. `--release` builds `out/Release` with `args.release.gn`, which is what `HOST=1` runs (below). `--official` builds `out/Official` with `args.official.gn`: the release build with ThinLTO and an AFDO profile, for published tarballs, and several times slower to build. It runs one compile job per 2 GiB of RAM (`BUILD_JOBS` in plutonium.env changes that), and if memory still runs out, the kernel kills the build rather than a running session.

`plutonium doctor` checks each step. Then go on with INSTALL.md's first session. [DEVELOPING.md](DEVELOPING.md) covers changing Chromium, and making a release.

## On the host, without the container

Nix only for now (`HOST=1`): your release build (`out/Release`), with its libraries from your system's nixpkgs (`dev/nix/chrome.nix`). Ash then runs as a normal host process, with no user namespace in between:

```
plutonium chromium build --release
plutonium host build          # → ~/.local/share/plutonium/host-chrome/bin/chrome
echo HOST=1 >> plutonium.env
```

It also builds the tools the container would otherwise provide (Xvfb, Python with websockets for `plutonium cdp`) into `host-tools`. Run `plutonium host build` again after rebuilding. Development builds (`out/Plutonium`) still run in the container.
