# How Plutonium works

```
 your apps (host)          shell pages (web apps)                    agents
 foot, Firefox, games…     niri / plain / T3 Code / yours            Claude Code, …
   │ Wayland, X11 via        │ navigator.windowBroker,                 │ MCP (stdio)
   │ xwayland-satellite      │ <native-window>, <embed> tabs           │
   ▼                         ▼                                         ▼
┌──────────────────────────────────────────────┐  HTTP/SSE   ┌────────────────────────────┐
│ Ash (Chromium, in the container)             │◄───────────►│ helper: plutoniumd (host)  │
│  • Exo: the Wayland server (wayland-…)       │  shell lib  │  • thread environment      │
│  • window broker: windows, grants, tags      │             │  • pid → thread            │
│  • tab registry: real WebContents as tabs    │             │  • launching apps          │
│  • shell mode: the page is the whole desktop │             │  • links → tabs            │
│  • several shells, the Super+Tab overlay     │             │  • agent bridge (MCP)      │
│  • viz: composites, display planes on DRM    │             └────────────────────────────┘
└──────────────────────────────────────────────┘
        KMS/DRM + evdev/libinput  (or an X11 window)
```

## The pieces

**Ash on DRM.**
- Chromium built with `target_os = "chromeos"` is Ash, the ChromeOS desktop, as a Linux program. With `--ozone-platform=drm` it drives the display through KMS and reads input from evdev and libinput, like a Wayland compositor.
- **Shell mode** (`--plutonium-shell-url`, patch 0006) turns Ash's own UI off: no shelf, tray, notifications, desks or window frames. The shell page opens as the single fullscreen window. Ash runs in kiosk mode, so only a few system keys remain.
- **Several shells:** `--plutonium-shells` runs more shell pages behind the first one. Super+Tab switches between them, and its overlay lists every window and tab.

**Exo** is ChromeOS's Wayland server.
- Apps connect to its socket (`$XDG_RUNTIME_DIR/wayland-plutonium`).
- **X11 apps** go through a rootless Xwayland (`xwayland-satellite`), one per thread, which the helper starts on demand.
- **Windows stay off Ash's desktop** (`--plutonium-hide-windows`). They are "parked" until a page embeds them.

**`<native-window>`** (patch 0001) is an element that shows an Exo window inside the page.
- **Drawing:** the window is a surface layer, composited by viz with the rest of the page. It gets no CPU copy, and a fullscreen one goes on a display plane.
- **Size:** the element's size is sent to the app (`xdg_toplevel.configure`). The page alone sizes a window it shows: the app's own maximize, minimize and move/resize requests reach the page as `windowrequest` events instead, and anything in Ash that changes the window's state or size is undone. `object-fit` places a frame that isn't the box's size, and `crossfade` animates resizes (`features/WINDOW_SIZING.md`).
- **Input:** pointer and keyboard input over the element is routed to the app, through the same hit testing that routes input into iframes. So are touchpad scrolling, drag and drop (`features/DRAG_AND_DROP.md`), pointer lock and fullscreen (`features/CONTROLS.md`).

**The window broker** (`navigator.windowBroker`) is how the shell finds and controls windows.
- **Contents:** it lists Exo's windows with title, app id, client pid and tags, and pushes add, change and remove events.
- **Grants:** these are per-document tokens. A page can embed a window only with one.
- **Who gets it:** only a shell page does: a top-level document whose origin is one of `--plutonium-shell-origin` or the shells. Ordinary pages and iframes get nothing, and the browser enforces this (`history/PHASE2_REPORT.md`).

**Browser tabs** (patch 0007, `features/TABS.md`) are real `WebContents`, owned by the browser.
- **Display:** the shell shows them as `<embed type="application/x-chromium-surface-embed">`. They are composited and get input like an out-of-process iframe, and there is no script channel between page and tab.
- **Driving them:** the shell navigates them, answers their dialogs and snapshots them.
- **Agents:** they automate them through a shell-only DevTools passthrough.
- **New tabs:** links a tab opens in a new tab become tabs too, with the opener's tags. Since patch 0016, so do links from shell pages (`features/OPENING_LINKS.md`).

**Tags and threads.** Every window and tab carries tags.
- **The first tag** is its origin and never changes. For a window, it is the `PLUTONIUM_THREAD_ID` of its process, or of the nearest ancestor that has one; the browser reads this from `/proc`. For a tab, it is the thread it was opened for.
- **Other tags:** shells add and remove these, for example to bring an item into another thread. They describe their tags as groups (label, owning shell).
- This is how T3's chat threads, niri's desktop and the plain shell's threads share one pool of windows (`features/SHELLS.md`).

**The helper** (`plutoniumd`, `helper/`) is the frontend-neutral part. It runs on the host, as you, because it starts your apps.
- **Thread environment:** gives each thread's processes `PLUTONIUM_THREAD_ID`, Exo's `WAYLAND_DISPLAY`, a per-thread `DISPLAY`, toolkit backend variables, and link openers (`xdg-open`, `$BROWSER`) that open tabs in the thread.
- **pid → thread:** maps a pid to its thread, for browsers that can't read `/proc`.
- **Launching:** lists and launches desktop apps.
- **Agent bridge:** an agent's MCP server (`plutonium.ts mcp`, or T3 Code's own, which forwards the window tools) calls the helper's Unix socket. With a browser that has the `Plutonium` DevTools domain, the helper does the work itself, on the session's debugging port: it lists, captures and opens windows and tabs, sends windows mouse and keys, and drives pages with Playwright. Showing something to the user, and everything with an older browser, it relays over SSE to the shell that owns the agent's thread, and that shell carries it out with the window broker. Agents only reach items tagged with their own thread ([features/AGENT_CONTROL.md](features/AGENT_CONTROL.md)).
- **Shell library:** shell pages load `/v1/shell.js` from it, which wraps all of the above.

**The container.**
- **Why:** Chromium's toolchain and runtime expect Ubuntu, so both the build and Ash run in a rootless podman container.
- **What it shares:** the host's pid namespace (so Exo reports real client pids), network, GPU and input devices.
- **Where apps run:** on the host, with the host's Mesa. They reach Exo through the shared runtime dir.

## Security model, briefly

- **Pages:** only shell origins get the broker, `<native-window>` grants and the tab API.
- **The helper's TCP port:** it serves only shell origins, and only to connections from the same user.
- **The Unix socket:** mode 0600.
- **Agents:** an agent's reach is its thread's tag, and that tag comes from a process environment variable. A process can copy the variable, so this separates work, not attackers. The stronger design is one Exo server per thread, with windows bound to a thread by the socket they connect to (`BACKLOG.md`).

## Where to read more

| Topic | Doc |
|---|---|
| Fullscreen, shell shortcuts, pointer capture, the app launcher | [features/CONTROLS.md](features/CONTROLS.md) |
| Tabs | [features/TABS.md](features/TABS.md) |
| Several shells, tags, the overlay | [features/SHELLS.md](features/SHELLS.md) |
| The niri shell; keyboard, touchpad and scrolling fixes | [features/NIRI_SHELL.md](features/NIRI_SHELL.md) |
| Drag and drop | [features/DRAG_AND_DROP.md](features/DRAG_AND_DROP.md) |
| Window sizing, `object-fit`, cross-fade, `windowrequest` | [features/WINDOW_SIZING.md](features/WINDOW_SIZING.md) |
| Links as tabs in their thread | [features/OPENING_LINKS.md](features/OPENING_LINKS.md) |
| Chrome's own UI in the shell: DevTools, context menus, browser and Ash keys | [features/CHROME_UI.md](features/CHROME_UI.md) |
| Screenshots, screen sharing, recording (design) | [features/CAPTURE.md](features/CAPTURE.md) |
| Password manager adapter (design) | [features/PASSWORDS.md](features/PASSWORDS.md) |
| Several monitors (design) | [features/MULTI_MONITOR.md](features/MULTI_MONITOR.md) |
| GPU for apps, dmabuf | [features/GPU_X11.md](features/GPU_X11.md), [history/VIABILITY_REPORT.md](history/VIABILITY_REPORT.md) |
| Shell mode on DRM, display planes | [history/PHASE4_PROGRESS.md](history/PHASE4_PROGRESS.md) |
| The helper's HTTP API and shell library | [../helper/README.md](../helper/README.md) |
