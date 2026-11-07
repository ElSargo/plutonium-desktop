# Installing Pluto

**The release.** One package, no podman or checkout: the installer puts it in `/opt/plutonium`, sets up Chromium's `chrome-sandbox`, and adds Pluto to the login screen. It needs x86-64 Linux with systemd, glibc 2.35 or newer, a desktop's libraries (Mesa, X11, GLib, ALSA), and python3, git and curl; it says what's missing. On NixOS the installer puts the release in place, and the rest is a module it carries, `/opt/plutonium/lib/nixos.nix`: copy it beside `configuration.nix` as `plutonium.nix`, add it to `imports`, and `sudo nixos-rebuild switch`. It sets up nix-ld (the release's binaries are generic Linux ones), the login screen's entry, the `plutonium` command, the keyboard layout links, and Python, git, curl, foot and xwayland-satellite.

```
curl -fsSL https://elsargo.github.io/pluto/install.sh | sh     # or: sh install.sh --from plutonium-<version>-x86_64.tar.xz
plutonium doctor
```

Then steps 4 to 6 below, with `~/.config/plutonium/plutonium.env` in place of the checkout's `plutonium.env`. `sh install.sh --uninstall` removes it (your data stays). The rest of this page installs from a checkout instead.

From a fresh clone to a running desktop. A checkout runs Pluto's Chromium built from source, so expect an afternoon, mostly the download and the first build. Each step has a `plutonium` command, and `plutonium doctor` says what's left, with the command for each.

## 1. What you need

**Machine**
- x86-64 Linux with an AMD or Intel GPU on Mesa. It has been developed on AMD graphics; Intel should work. NVIDIA is untested, and its proprietary driver probably doesn't work.
- 16 GB of RAM is comfortable (32 GB is better for building Chromium), and about 60 GB of disk for Chromium's checkout and build.
- systemd (logind and a user session), and rootless podman.

**Distributions.** It's developed on NixOS, and has run on real hardware with Debian and Fedora too. Ubuntu 24.04 is tested in a container, from the packages below up to `plutonium doctor` and the helper's tests; not yet booted on hardware. Others with systemd, podman and Node 24 should work. If yours doesn't, please say so (Reporting a bug, below).

**Packages.** The browser runs in a container, so the host needs only a few things:

| | Why |
|---|---|
| podman (rootless) | the container Chromium runs in |
| Node.js 24 or newer, and npm | the helper, which runs on the host, where your apps are |
| python3, git, curl, procps (`pgrep`) | the scripts |
| sudo | only for `plutonium session install`, and some test tools |
| optional: `foot` | the terminal the shells open (Super+T) |
| optional: `xwayland-satellite`, `systemd-socket-activate` | X11 apps (each thread gets a rootless Xwayland) |
| optional: pnpm (or corepack, included with Node 24) | Hydra (the T3 Code frontend) |
| optional: GStreamer (`gst-launch-1.0`, its base and good plugins, PipeWire's plugin) | agents' recordings (`start_recording`): `gstreamer1-plugins-good` and `pipewire-gstreamer` on Fedora, `gstreamer1.0-tools gstreamer1.0-plugins-good gstreamer1.0-pipewire` on Ubuntu |

```
# Fedora (its plain nodejs is Node 22)
sudo dnf install podman nodejs24-bin nodejs24-npm-bin python3 git curl procps-ng foot xwayland-satellite
# Ubuntu 24.04, Debian (apt's Node is too old: Node 24 from NodeSource;
# xwayland-satellite isn't packaged, build it from github.com/Supreeeme/xwayland-satellite)
sudo apt install podman python3 git curl procps foot
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource.sh && sudo bash /tmp/nodesource.sh && sudo apt install nodejs
# Arch
sudo pacman -S podman nodejs npm python git curl procps-ng foot xwayland-satellite
# NixOS (configuration.nix)
virtualisation.podman.enable = true;
environment.systemPackages = with pkgs; [ nodejs_24 python3 git curl foot xwayland-satellite ];
```

**Your user**
- **Subordinate ids** for rootless podman. Most distributions add them for new users; `grep $USER /etc/subuid /etc/subgid` should print two lines. If not: `sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $USER`, then `podman system migrate`.

## 2. Get it

```
git clone https://github.com/ElSargo/pluto.git && cd pluto
bin/plutonium doctor
```

`plutonium.env` (create it if you need it) holds your settings; `plutonium.env.example` lists them all, each with its default. Add `bin/` to your `PATH`, or call `bin/plutonium`.

`doctor` prints a line for each missing piece, and the command that fixes it on your distribution. It exits with 1 until everything it needs is there. Run it again after each step.

## 3. Chromium: build it

```
plutonium container build     # the build container's image (~1.6 GB, ~10 min)
plutonium container create    # the container 'plutonium', started
plutonium chromium fetch      # depot_tools and Chromium at chromium/BASE (28 GB)
plutonium chromium patch      # Pluto's patches, on a branch 'plutonium'
plutonium chromium build      # out/Plutonium/chrome (about two hours on 32 threads, the first time)
```

[docs/BUILDING.md](docs/BUILDING.md) has the details. Everything else, including the helper, the shells and T3 Code, runs from this repository.

- **After `git pull`**, if `chromium/` changed: `plutonium chromium patch`, then `plutonium chromium build` (it rebuilds only what changed).
- **After a reboot**, `plutonium container start` (a login session from the login screen entry starts it itself).

## 4. First session: in a window

On an X11 or Xwayland desktop (Plasma, GNOME and most others provide Xwayland on `:0`):

```
plutonium run --x11 :0 niri
```

- **The window.** Ash opens as a 1600×1000 window, with Styx (the shell named `niri`) as its desktop. Super+T opens a terminal, and Super+Shift+/ lists the keys.
- **Super keys.** Your desktop's compositor may keep some Super shortcuts for itself.
- **Stopping it.** Run `plutonium stop --x11`.
- **No display.** `--x11` without a display starts a private Xvfb (`:99`), for tests that need no screen.

If apps render in software, `plutonium run` says so, and `logs/helper-*.log` explains why (`docs/features/GPU_X11.md`).

## 5. As the desktop

1. Switch to a text console (Ctrl+Alt+F2, or F3…) and log in.
2. From this repository, run:

```
plutonium run                  # your installed shells: the first run installs them, with Hydra and plain on
plutonium run niri plain       # or name them: Styx first, the plain shell behind it (Super+Tab)
```

Ash runs in that console's logind session, which hands it the display and input devices ([docs/features/SEAT.md](docs/features/SEAT.md)).

**Switching VTs.** Ctrl+Alt+F1…F12 switch to another VT, such as your graphical desktop, while Pluto keeps running. Switch back to its VT and it's as you left it. Apps keep running in between; they just aren't drawn.

**Leaving the session:**
- **Ctrl+Alt+Backspace** ends it, and the text console comes back.
- `plutonium stop --drm` (from ssh, another VT, or a terminal inside Pluto) does the same.

However the session ends, even when Ash crashes or is killed, the text console comes back in working order: logind restores it.

**From another shell.** If you're logged in on tty2, you can start a session there from anywhere, for example over ssh or from an agent. If tty2 isn't in front, Ash starts and waits, and comes up when you switch to it (Ctrl+Alt+F2):

```
plutonium run --vt tty2 niri
plutonium run --vt tty2 --hold 120 niri    # unattended: stops after 120 s
```

**From the login screen.** With a display manager (GDM, SDDM, LightDM), Pluto can be a session you pick when you log in:

```
plutonium session install --dry-run   # shows the entry it would write
plutonium session install             # /usr/share/wayland-sessions/plutonium.desktop, with sudo
```

Log out, pick Pluto at the login screen (GDM: the gear button; SDDM: the session menu), and log in. The entry runs `plutonium session start` from this checkout:
- it starts the container if it isn't running;
- it runs `plutonium run` on the display manager's VT, with your installed shells. `SESSION_SHELLS="niri plain"` in `plutonium.env` names others instead;
- when the session ends (Ctrl+Alt+Backspace, `plutonium stop --drm`, a crash), the login screen comes back. If something is missing, or Ash doesn't start, it's back at once, and `journalctl -t plutonium-session` says why.

The display manager's own automatic login, with the Pluto session, starts it at power-on. `plutonium session uninstall` removes the entry. The entry is new: if it doesn't work with your display manager, please report it, and start from a text console meanwhile.

**Without a display manager.** Log in on tty1 automatically, and start Pluto from the login shell. For getty autologin, run `sudo systemctl edit getty@tty1` and add (NixOS: `services.getty.autologinUser = "<you>";`):

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

**Choosing shells.** The first run installs the shipped shells in `~/.pluto/shells` (`plutonium shells list`). With no shells named, `plutonium run` runs the ones that are on there, in order. The switcher's changes (Super+Tab: add, remove, turn off, reorder) are saved for next time. Or list them in order, and the first one is the desktop:
- installed shells by name: `niri` (Styx), `gnome` (Charon), `plain`, `hydra`, and any you added;
- `<name>=<url>` for any web app you've written against the shell API (see `docs/USING.md`).

`plutonium run --safe` runs only the shipped plain shell, whatever your shells do ([docs/features/SHELL_PACKAGES.md](docs/features/SHELL_PACKAGES.md)).

## 6. Optional: Hydra

Hydra is the shell built on [T3 Code](https://github.com/pingdotgg/t3code), a chat UI for coding agents, with Pluto's patches.

```
plutonium hydra fetch            # clone at shells/hydra/src/BASE, apply the patches
plutonium hydra build            # pnpm install + build the web app (the checkout grows to ~4 GB)
plutonium run hydra niri         # Hydra; the helper starts T3 Code's server, and the shell pairs itself
```

Hydra runs on your own T3 Code data (`~/.t3`, or `$T3CODE_HOME`): the same threads, settings and paired devices as the T3 Code app. Quit the app (or any other T3 Code server) first; Pluto won't start beside one. On a fresh `~/.t3`, T3 walks you through its own setup (computers, agents, projects).

Phones and other computers pair the way T3 Code's own CLI does it, through `plutonium hydra` (T3's CLI on the same data): `plutonium hydra connect link` for T3 Connect, or `plutonium hydra pair --tailscale`.

## 7. Agents

- **Under Hydra:** T3 Code gives its Claude sessions the helper's MCP server.
- **Any other agent:** run it inside a thread, for example from a terminal you opened in a shell, which already has the thread's environment. Then give it the bridge:

```
claude --mcp-config '{"mcpServers":{"plutonium":{"type":"stdio","command":"node","args":["'$PWD'/helper/plutonium.ts","mcp"]}}}'
```

Styx's launcher (Super+D) has an entry that starts Claude Code with these tools. The tools are listed in `helper/README.md`.

## If it hangs

- **Ash doesn't respond, or the screen is black:** a hung Ash can't switch VTs (the keys go through it), so from another machine, `ssh` in and run `plutonium stop --drm`, or `loginctl activate <session>` to switch to another session (`loginctl list-sessions`). logind gives the text console back however Ash ends.
- **A shell page misbehaves, but Ash responds:** Super+Tab to another shell, or Ctrl+Alt+Backspace to end the session.
- **The console stays dark after Ash ends:** switch VTs (Ctrl+Alt+F3, then back). logind restores the console's mode whenever Ash exits, crashes included, so this shouldn't happen; please report it.

## Logs

In `~/.local/share/plutonium/logs` for the release (`logs/` in a checkout), one set per session (the name is its Wayland socket, `wayland-plutonium` on DRM, `wayland-plutonium-x11` in a window):
- `session-*.log`: the launcher: what it checked, and why it stopped;
- `ash-*.log`: Ash, Pluto's Chromium, with the previous run kept as `*.prev.log`;
- `helper-*.log`: the helper (apps, threads, the GPU check);
- `login-session.log`, and `journalctl -t plutonium-session`: sessions from the login screen.

## Reporting a bug

Open an issue at https://github.com/ElSargo/pluto/issues with:
- what you did, what you expected and what happened;
- your distribution, and your GPU (`lspci -k | grep -A3 -E 'VGA|3D'`);
- the output of `plutonium doctor` and `plutonium status`;
- the logs above from that session: the session log whole, and the end of the Ash and helper logs. Have a look first: they can hold page URLs and window titles.

## Troubleshooting

| | |
|---|---|
| `podman`: "cannot re-exec process to join the existing user namespace" | `PODMAN=dev/pm.sh` in `plutonium.env` |
| The container exits a minute after starting | Start it with `plutonium container start`, which runs it from a lasting user unit. Starting it from a short-lived wrapper takes its monitor process down with it |
| `run`: "… is in no logind session" or "… is not on a seat's VT" | Run it from a text console you logged in on (not a terminal in your desktop), or pass `--vt ttyN` |
| `run`: "session … is not in front; Ash comes up when it is" | Not an error: the console isn't the one on screen. Switch to it (Ctrl+Alt+F*n*) and Ash comes up |
| `run`: "no system D-Bus where Ash runs" | The container is from before seat management. Make it again: `plutonium container stop`, `podman rm <container>`, then `plutonium container create` |
| Apps render in software | See `logs/helper-*.log` and `docs/features/GPU_X11.md`. The host needs Mesa with your GPU's driver |
| Hotplugged keyboards or mice are ignored on DRM | The container is from before the fix (it maps uid 65534, so libudev drops the host's udev events; `plutonium doctor` says so). Make it again: `plutonium container stop`, `podman rm <container>`, then `plutonium container create` |
| X11 apps don't start | Install `xwayland-satellite`, or set `PLUTONIUM_XWAYLAND_SATELLITE` |
| `run`: the helper says the shells port is taken | Another session in the same slot, or something else on 8770 (+100 per slot), has it. Stop it, or set `SHELLS_PORT` |
