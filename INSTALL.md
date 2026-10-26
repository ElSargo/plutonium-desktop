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
- **On the host, without the container** (Nix only for now, `HOST=1`): a release build, from the prebuilt image or your own `out/Release`, with its libraries from your system's nixpkgs (`nix/chrome.nix`). Ash then runs as a normal host process, with no user namespace in between. Podman is only needed to copy the binary out of the prebuilt image:

  ```
  plutonium image pull          # with PREBUILT=1; or: plutonium chromium build --release
  plutonium host build          # → ~/.local/share/plutonium/host-chrome/bin/chrome
  echo HOST=1 >> plutonium.env
  ```

  It also builds the tools the container would otherwise provide (Xvfb, Python with websockets for `plutonium cdp`) into `host-tools`. Run `plutonium host build` again after pulling a new image or rebuilding. Development builds (`out/Plutonium`) still run in the container.
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

1. Switch to a text console (Ctrl+Alt+F2, or F3…) and log in.
2. From this repository, run:

```
plutonium run niri plain       # niri first, the plain shell behind it (Super+Tab)
```

Ash runs in that console's logind session, which hands it the display and input devices ([docs/features/SEAT.md](docs/features/SEAT.md)).

**Switching VTs.** Ctrl+Alt+F1…F12 switch to another VT, such as your graphical desktop, while Plutonium keeps running. Switch back to its VT and it's as you left it. Apps keep running in between; they just aren't drawn.

**Leaving the session:**
- **Ctrl+Alt+Backspace** ends it, and the text console comes back.
- `plutonium stop --drm` (from ssh, another VT, or a terminal inside Plutonium) does the same.
- The kill switch kills Ash and switches back to your graphical session. It's for when Ash hangs.

However the session ends, even when Ash crashes or is killed, the text console comes back in working order: logind restores it.

**From another shell.** If you're logged in on tty2, you can start a session there from anywhere, for example over ssh or from an agent. If tty2 isn't in front, Ash starts and waits, and comes up when you switch to it (Ctrl+Alt+F2):

```
plutonium run --vt tty2 niri
plutonium run --vt tty2 --hold 120 niri    # unattended: stops after 120 s
```

**From the login screen.** With a display manager (GDM, SDDM, LightDM), Plutonium can be a session you pick when you log in:

```
plutonium session install --dry-run   # shows the entry it would write
plutonium session install             # /usr/share/wayland-sessions/plutonium.desktop, with sudo
```

Log out, pick Plutonium at the login screen (GDM: the gear button; SDDM: the session menu), and log in. The entry runs `plutonium session start` from this checkout:
- it starts the container if it isn't running, and waits up to 10 s for the kill switch, which starts with your login;
- it runs `plutonium run niri plain` on the display manager's VT. Set `SESSION_SHELLS="t3 niri"` in `plutonium.env` for other shells;
- when the session ends (Ctrl+Alt+Backspace, the kill switch, a crash), the login screen comes back. If something is missing, or Ash doesn't start, it's back at once, and `journalctl -t plutonium-session` says why.

The display manager's own automatic login, with the Plutonium session, starts it at power-on. `plutonium session uninstall` removes the entry.

**Without a display manager.** Log in on tty1 automatically, and start Plutonium from the login shell. For getty autologin, run `sudo systemctl edit getty@tty1` and add (NixOS: `services.getty.autologinUser = "<you>";`):

```
[Service]
ExecStart=
ExecStart=-/sbin/agetty -o '-p -f -- \\u' --noclear --autologin <you> %I $TERM
```

Then, at the end of `~/.bash_profile` (or your shell's login file):

```
if [ "$(tty)" = /dev/tty1 ]; then ~/plutonium/bin/plutonium session start; fi
```

Not `exec`: when the session ends, or doesn't start, you're at tty1's prompt, rather than logged in again into the same failure.

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
plutonium run t3 niri         # starts T3 Code's server and pairs the shell
```

T3 Code runs on your own T3 Code data (`~/.t3`, or `$T3CODE_HOME`): the same threads, settings and paired devices as the T3 Code app. Quit the app (or any other T3 Code server) first; Plutonium won't start beside one. On a fresh `~/.t3`, T3 walks you through its own setup (computers, agents, projects).

Phones and other computers pair the way T3 Code's own CLI does it, through `plutonium t3` (T3's CLI on the same data): `plutonium t3 connect link` for T3 Connect, or `plutonium t3 pair --tailscale`.

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
| `run`: "… is in no logind session" or "… is not on a seat's VT" | Run it from a text console you logged in on (not a terminal in your desktop), or pass `--vt ttyN` |
| `run`: "session … is not in front; Ash comes up when it is" | Not an error: the console isn't the one on screen. Switch to it (Ctrl+Alt+F*n*) and Ash comes up |
| `run`: "no system D-Bus where Ash runs" | The container is from before seat management. Make it again: `plutonium container stop`, `podman rm <container>`, then `plutonium container create` |
| Apps render in software | See `logs/helper-*.log` and `docs/features/GPU_X11.md`. The host needs Mesa with your GPU's driver |
| Hotplugged keyboards or mice are ignored on DRM | The container is from before the fix (it maps uid 65534, so libudev drops the host's udev events; `plutonium doctor` says so). Make it again: `plutonium container stop`, `podman rm <container>`, then `plutonium container create` |
| X11 apps don't start | Install `xwayland-satellite`, or set `PLUTONIUM_XWAYLAND_SATELLITE` |
| `run`: "port 8775 is taken" | Another copy of the shell server is running, for example from another checkout. Stop it |
