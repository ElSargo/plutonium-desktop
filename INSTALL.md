# Installing Plutonium

From a fresh clone to a running desktop. Expect an afternoon: most of it is building Chromium. The download is 28 GB; on a fast connection it took 4 minutes. Each step has a `plutonium` command, and `bin/plutonium doctor` shows what's done.

## 1. What you need

**Machine**
- x86-64 Linux with an AMD or Intel GPU on Mesa. It has been developed on AMD; NVIDIA is untested.
- 16 GB of RAM at least; 32 GB is better for building.
- About 60 GB of free disk: about 28 GB for the checkout (sources and dependencies, no history), 21 GB for the build, and 2 GB for the container image.
- Many cores help. The first build takes about two hours on 32 threads.

**Host software.** The build runs in a container, so the host needs only a few things:

| | Why |
|---|---|
| podman (rootless, with `/etc/subuid` and `/etc/subgid` entries for you) | the build and run container |
| systemd user session (`systemctl --user`) | keeps the container running; the kill switch service |
| Node.js 24 or newer | the helper, which runs on the host, where your apps are |
| python3, git, curl | the scripts |
| sudo | only for `--vt`, KMS screenshots and the uinput test devices |
| optional: `foot` | the terminal the shells open (Super+T) |
| optional: `xwayland-satellite`, `systemd-socket-activate` | X11 apps (each thread gets a rootless Xwayland) |
| optional: pnpm (or corepack, included with Node 24) | the T3 Code frontend |

Examples:

```
# Arch
sudo pacman -S podman nodejs python git curl foot xwayland-satellite
# Fedora
sudo dnf install podman nodejs python3 git curl foot xwayland-satellite
# Debian/Ubuntu: Node 24 from nodesource or nvm; xwayland-satellite from source or cargo
sudo apt install podman python3 git curl foot
# NixOS (configuration.nix)
virtualisation.podman.enable = true;
environment.systemPackages = with pkgs; [ nodejs_24 python3 git curl foot xwayland-satellite ];
```

**Groups.** Add yourself to `input` (`sudo usermod -aG input $USER`, then log in again). The kill switch reads a button through it.

## 2. Settings

```
git clone https://github.com/ElSargo/plutonium-desktop.git plutonium && cd plutonium
cp plutonium.env.example plutonium.env
```

Every setting has a default, so the file can stay empty. The ones you're most likely to change:

- **`CHROMIUM_DIR`** (`~/chromium`) and **`DEPOT_TOOLS`** (`~/depot_tools`): put them on a fast disk with room.
- **`PODMAN=lib/pm.sh`**: needed if `podman info` fails with "cannot re-exec process to join the existing user namespace". That happens in a shell inside another user namespace, such as some sandboxes and IDE terminals.
- **`KILLSWITCH_DEVICE`, `KILLSWITCH_KEY`**: set in step 5.

Add `bin/` to your `PATH`, or call `bin/plutonium`. Then check:

```
plutonium doctor
```

## Prebuilt or built yourself

There are two ways to get Plutonium's Chromium:

- **Prebuilt** (`PREBUILT=1` in `plutonium.env`): download the image `ghcr.io/elsargo/plutonium`. It holds a release build of the patched Chromium and the libraries it needs, about 1.3 GB, and needs no checkout, build tools or build time. Its tag is a hash of `chromium/` (the base revision, patches and release arguments), so it always matches your clone. Do steps 1 and 2, then:

  ```
  plutonium image pull          # the image for this checkout's chromium/
  plutonium container create    # the container, from that image
  ```

  Then skip to step 5. Everything else, including the helper, shells and T3 Code, runs from this repository as usual.

  The image is private while the repository is. Log in with a GitHub token that can read packages:
  `gh auth refresh -s read:packages && gh auth token | podman login ghcr.io -u <you> --password-stdin`.
- **Built yourself:** steps 3 and 4. You need this to change Chromium. It is also a development build: faster to rebuild, and it stops on internal assertion failures.

## 3. The container

```
plutonium container build     # Ubuntu 24.04 + Chromium's build dependencies (~1.6 GB, ~10 min)
plutonium container create    # creates and starts the container 'plutonium'
```

The container shares the host's process IDs (Exo must see your apps' real pids), network, GPU (`/dev/dri`) and input devices. It mounts this repository, the Chromium checkout, depot_tools, the data dir and `$XDG_RUNTIME_DIR` at the same paths as on the host. Its home is `~/.local/share/plutonium/container-home`.

After a reboot, run `plutonium container start`.

## 4. Chromium

```
plutonium chromium fetch      # depot_tools, then the checkout at chromium/BASE
plutonium chromium patch      # the patch series, on a branch 'plutonium'
plutonium chromium build      # out/Plutonium/chrome
```

- **`fetch`** clones depot_tools and writes a `.gclient` for Chromium with `target_os = ['chromeos']`. It then syncs straight to the pinned revision with no history and 4 jobs (googlesource rate-limits the default), and runs the hooks. If it stops partway, run it again; it resumes.
- **`patch`** refuses to touch a checkout with uncommitted changes. Run it again with `--force` to reset the `plutonium` branch.
- **`build`** copies `chromium/args.gn` into the build dir and runs `autoninja`. Incremental builds after that take seconds to minutes.

## 5. The kill switch

On DRM, Ash takes the display and every input device, and the text console's keyboard is turned off while it runs. If the session hangs, Ctrl+Alt+F*n* won't get you out. The kill switch is a button that kills Ash and switches back to your normal desktop session (or leaves you on the text console). Pick a key you never use: a laptop's spare hotkey, Scroll Lock, a macro key.

```
plutonium killswitch find     # press the button; it prints KILLSWITCH_DEVICE=… KILLSWITCH_KEY=…
# put those two lines in plutonium.env, then:
plutonium killswitch install  # a systemd user service, started now and at every login
plutonium killswitch test     # shows what a press would kill, without doing it
```

`plutonium run` on DRM refuses to start unless the kill switch is listening. There are two exceptions:
- **`--hold <seconds>`** stops Ash by itself after that long.
- **`--no-killswitch`** starts anyway. Only use it if you can stop the session another way, such as `plutonium stop --drm` over ssh.

## 6. First session: in a window

On an X11 or Xwayland desktop (Plasma, GNOME and most others provide Xwayland on `:0`):

```
plutonium run --x11 :0 niri
```

- **The window.** Ash opens as a 1600×1000 window, with niri as its desktop. Super+T opens a terminal, and Super+Shift+/ lists the keys.
- **Super keys.** Your desktop's compositor may keep some Super shortcuts for itself.
- **Stopping it.** Run `plutonium stop --x11`.
- **No display.** `--x11` without a display starts a private Xvfb (`:99`), for tests that need no screen.

If apps render in software, `plutonium run` says so, and `logs/helper-*.log` explains why (`docs/features/GPU_X11.md`).

## 7. As the desktop: DRM

1. Switch to a text console (Ctrl+Alt+F2, or F3…) and log in. logind then gives that session the display and input devices.
2. Your graphical session must not be in front; switching to the text console already does that.
3. From this repository, run:

```
plutonium run niri plain       # niri first, the plain shell behind it (Super+Tab)
```

**Leaving the session:**
- The kill switch kills Ash and switches back to your graphical session.
- `plutonium stop --drm` (from ssh, or from a terminal inside Plutonium) stops Ash, and the text console comes back.

**From another shell.** If someone is logged in on tty2, you can run it against that VT from anywhere, for example over ssh or from an agent. This needs passwordless sudo for `python3`:

```
plutonium run --vt tty2 niri
plutonium run --vt tty2 --hold 120 niri    # unattended: waits for the graphical session to go inactive, stops after 120 s
```

**Choosing shells.** List them in order; the first one is the desktop:
- `niri`, `plain` or `t3`;
- `<name>=<url>` for any web app you've written against the shell API (see `docs/USING.md`).

The browser profile remembers shells, including ones added from the Super+Tab overlay, so they come back next time.

**Logs.** These are in `logs/`:
- `session-*.log`: the launcher;
- `ash-*.log`: Ash, with the previous run kept as `*.prev.log`;
- `helper-*.log`: the helper.

## 8. Optional: T3 Code

```
plutonium t3 fetch            # clone at frontends/t3code/BASE, apply the patches
plutonium t3 build            # pnpm install + build the web app (the checkout grows to ~4 GB)
plutonium t3 server           # for DRM sessions; --x11 for X11 ones
```

The first time, the server prints a pairing URL. Start a session with it once:

```
plutonium run 't3=http://127.0.0.1:3774/pair#token=…' niri
```

Then T3 walks you through its own setup (computers, agents, projects). After that, `plutonium run t3 niri` is enough. Restart `plutonium t3 server` after a reboot.

## 9. Agents

- **Under T3 Code:** T3 gives its Claude sessions the helper's MCP server.
- **Any other agent:** run it inside a thread, for example from a terminal you opened in a shell, which already has the thread's environment. Then give it the bridge:

```
claude --mcp-config '{"mcpServers":{"plutonium":{"type":"stdio","command":"node","args":["'$PWD'/helper/plutonium.ts","mcp"]}}}'
```

The niri shell's launcher (Super+D) has an entry that starts Claude Code with these tools. The tools are listed in `helper/README.md`.

## Troubleshooting

| | |
|---|---|
| `podman`: "cannot re-exec process to join the existing user namespace" | `PODMAN=lib/pm.sh` in `plutonium.env` |
| The container exits a minute after starting | Start it with `plutonium container start`, which runs it from a lasting user unit. Starting it from a short-lived wrapper takes its monitor process down with it |
| `run`: "the graphical session … is active" | Run it from a text console, or pass `--vt ttyN` |
| `run`: "… is not the active VT" | The console you ran it from isn't the one on screen |
| The text console is dead after a crash (no echo, no keys) | From ssh: `sudo python3 lib/tty_vt.py restore < /dev/ttyN` |
| Apps render in software | See `logs/helper-*.log` and `docs/features/GPU_X11.md`. The host needs Mesa with your GPU's driver |
| Hotplugged keyboards or mice are ignored on DRM | Plug them in before starting the session. The rootless container doesn't receive udev hotplug events (`docs/BACKLOG.md`) |
| X11 apps don't start | Install `xwayland-satellite`, or set `PLUTONIUM_XWAYLAND_SATELLITE` |
| `run`: "port 8775 is taken" | Another copy of the shell server is running, for example from another checkout. Stop it |
