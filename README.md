# Plutonium

A web-based desktop environment for Linux.

In Plutonium, the desktop is a web page. Native apps (Wayland and X11) and real browser tabs are elements in that page, which you can lay out, style and script like any other part of the page. So a window manager, a launcher or a whole desktop shell is just a web app.

![The niri shell: a terminal and a browser tab side by side](docs/images/niri.png)

- **Bring your own shell.** It comes with three: [niri](docs/features/NIRI_SHELL.md) (scrollable tiling), a minimal reference shell, and [T3 Code](frontends/t3code/README.md) (coding agents). You can run several at once and switch between them with Super+Tab.
- **Apps and tabs side by side.** Apps get the GPU, keyboard, mouse, touchpad, fullscreen, pointer lock, and drag and drop. Tabs are real Chromium tabs.
- **Work stays together.** Every app and tab belongs to the thread or workspace that started it. A link clicked in a terminal opens as a tab next to it, and a file opens in its app in the same place.
- **Built for agents.** An agent can see, launch, screenshot and drive its own thread's apps and tabs over MCP.

Plutonium is built on Chromium's ChromeOS desktop (Ash) and its Wayland server (Exo). It runs directly on the display hardware, like any Wayland compositor, or in a window on your current desktop.

## Status

A public beta: usable day to day by its developer, new to everyone else. Working: several monitors, the clipboard between apps and pages, screen sharing and screenshots (the desktop portal, grim), the file picker, global shortcuts, H.264 video in tabs, and a login screen entry. Not there yet:
- input methods in native apps (in progress);
- installing and editing shells as packages (in progress);
- the other desktop portals, such as printing from native apps.

**Supported:** x86-64 Linux with systemd and rootless podman, and an AMD or Intel GPU on Mesa. It's developed on NixOS with AMD graphics. Fedora 44 and Ubuntu 24.04 are tested as far as a container allows, not on hardware yet; Intel should work, and NVIDIA is untested. See [docs/BACKLOG.md](docs/BACKLOG.md).

## Quick start

With the prebuilt Chromium; [INSTALL.md](INSTALL.md) explains each step, and [docs/BUILDING.md](docs/BUILDING.md) builds it from source.

1. Install podman, Node.js 24, Python 3, git and curl, and add yourself to the `input` group ([INSTALL.md](INSTALL.md) has the command for your distribution). Then get Plutonium:

   ```sh
   git clone https://github.com/ElSargo/plutonium-desktop.git plutonium
   cd plutonium
   echo PREBUILT=1 > plutonium.env
   bin/plutonium doctor              # what's missing, and the command that fixes each
   ```

2. Download Chromium, and make its container:

   ```sh
   bin/plutonium image pull          # ~1.3 GB
   bin/plutonium container create
   ```

3. Try it in a window on your current desktop:

   ```sh
   bin/plutonium run --x11 :0 niri   # bin/plutonium stop --x11 ends it
   ```

4. To run it as your whole desktop, first set up a kill switch, a key that gets you out if something hangs:

   ```sh
   bin/plutonium killswitch find     # press a spare key, copy the two lines into plutonium.env
   bin/plutonium killswitch install
   ```

5. Then either switch to a text console (Ctrl+Alt+F2), log in, and run `bin/plutonium run niri plain`; or add it to your login screen with `bin/plutonium session install`, log out, and pick Plutonium.

In niri, Super+T opens a terminal, Super+D the launcher, and Super+Shift+/ lists every key. Super+Tab switches shells. Ctrl+Alt+Backspace ends the session.

**If it hangs,** press the kill switch: Ash is killed and you're back where you were. **Logs** are in `logs/` in the checkout. To **report a bug**, open an issue with what `plutonium doctor` says and those logs (INSTALL.md, "Reporting a bug").

## Repository

| Path | |
|---|---|
| `bin/plutonium` | The command for setup, builds and sessions (`plutonium help`) |
| `chromium/` | The Chromium revision, patches and build settings ([README](chromium/README.md)) |
| `helper/` | `plutoniumd`: threads, app launching, links, the agent bridge ([README](helper/README.md)) |
| `shells/` | The niri and plain shells |
| `frontends/t3code/` | Patches that turn T3 Code into a shell |
| `container/` | The build image and the prebuilt runtime image |
| `killswitch/`, `tools/` | The kill switch; test tools |
| `docs/` | [Using](docs/USING.md), [building](docs/BUILDING.md), [architecture](docs/ARCHITECTURE.md), [developing](docs/DEVELOPING.md), per-feature docs |

## License

MIT. See [LICENSE](LICENSE). The Chromium patches are under Chromium's BSD-style license.
