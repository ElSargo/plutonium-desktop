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

Early, but usable day to day. Not there yet:
- a login-screen session entry (you start it from a text console);
- multiple monitors;
- the clipboard between apps and pages;
- desktop portals (Flatpak link opening, screen sharing).

It has been developed on AMD graphics. Intel should work; NVIDIA is untested. See [docs/BACKLOG.md](docs/BACKLOG.md).

## Running it

You need a Linux machine with podman, Node.js 24 and Python 3. [INSTALL.md](INSTALL.md) has the details, along with the build-from-source path.

```sh
git clone https://github.com/ElSargo/plutonium-desktop.git plutonium
cd plutonium
echo PREBUILT=1 > plutonium.env

bin/plutonium image pull          # prebuilt Chromium, ~1.3 GB
bin/plutonium container create
```

Try it in a window on your current desktop:

```sh
bin/plutonium run --x11 :0 niri
```

Or run it as your whole desktop. First set up a kill switch, a key that gets you out if something hangs:

```sh
bin/plutonium killswitch find      # press a spare key, copy the two lines into plutonium.env
bin/plutonium killswitch install
```

Then switch to a text console (Ctrl+Alt+F2), log in, and run:

```sh
bin/plutonium run niri plain
```

In niri, Super+T opens a terminal, Super+D the launcher, and Super+Shift+/ lists every key. Super+Tab switches shells.

## Building from source

To change Chromium, or not use the prebuilt image, build it yourself. This needs about 50 GB of disk and a couple of hours:

```sh
bin/plutonium container build && bin/plutonium container create
bin/plutonium chromium fetch && bin/plutonium chromium patch && bin/plutonium chromium build
```

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
| `docs/` | [Using](docs/USING.md), [architecture](docs/ARCHITECTURE.md), [developing](docs/DEVELOPING.md), per-feature docs |

## License

MIT. See [LICENSE](LICENSE). The Chromium patches are under Chromium's BSD-style license.
