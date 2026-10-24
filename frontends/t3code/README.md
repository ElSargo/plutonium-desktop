# T3 Code as a Plutonium shell

[T3 Code](https://github.com/pingdotgg/t3code) is a chat UI for coding agents. With these patches its web app runs as a Plutonium shell:
- every chat thread gets the apps, terminals and browser tabs its agent and terminals start, in the thread's right panel;
- the agents get Plutonium's MCP tools for their thread's windows and tabs.

T3 Code is optional. The niri and plain shells need nothing from here.

- **`BASE`**: the upstream T3 Code commit the patches apply to: v0.1.0 (`81493efb71`, 2026-10-15).
- **`patches/`**: the series (`git am`): 15 commits, about 3,300 lines, mostly in `apps/web/src/plutonium/` and `packages/shared/src/plutonium.ts`.

```
plutonium t3 fetch     # clone into frontends/t3code/checkout (T3CODE_DIR), branch plutonium
plutonium t3 build     # pnpm install, build the web app
plutonium run t3 niri  # T3 as the desktop, niri behind it (Super+Tab)
```

`plutonium run t3` starts the server if it isn't running, for that session's socket. `plutonium t3 server [--x11]` restarts it, and `plutonium t3 stop` stops it. Each run offers the shell a one-time pairing token (5 minutes) as `#plutoniumPair=`, with the scopes T3's desktop app gets, so the shell can pair other devices from Settings, Connections. The page passes it on to T3 only if the profile isn't paired yet, or its session lacks some of those scopes, so a paired profile doesn't add a session each time.

### The host's T3 Code

The server runs on the host's own T3 Code data, as the T3 Code app and CLI do: `$T3CODE_HOME`, else `~/.t3` (`T3_HOME` overrides it). Threads, settings, and paired devices are the same in and out of Plutonium.

- **One at a time:** before starting, Plutonium looks for anything else using that data: the T3 Code app, a `t3` server, a boot service. It finds them by the open database, and by T3's `server-runtime.json`. If there is one, it refuses and says what it found; quit that one first. Plutonium's own server carries `PLUTONIUM_T3=<this checkout>`, so it is told apart and restarted.
- **The database's version:** T3 migrates its database when it opens it. Plutonium refuses a database from a newer T3 Code than the checkout. An older one is migrated, and first copied to `<database>.before-migration-<n>`. Since 0.1, T3's database is `statev2.sqlite`: on its first start T3 seeds it from a copy of `state.sqlite`, which it leaves as it was, so T3 Code before 0.1 still runs on the old data.
- **T3 Code's own CLI on NixOS:** the `t3` npm package is a native executable since 0.1, which NixOS can't run as it comes. Point it at Nix's loader with `patchelf --set-interpreter` and an rpath to glibc and gcc's `lib` (also for `resource-monitor/linux-x64/t3-resource-monitor`), or use nix-ld. Plutonium runs T3 from its checkout and doesn't need it.
- **Remote devices:** `plutonium t3 <command>` is T3's own CLI on the same data. `fetch` and `build` copy T3's `.env.example` to `.env`, the T3 Connect settings T3's release builds have. Without them, a source build has no T3 Connect. To pair remote devices, use one of:
  - `plutonium t3 connect link`: signs in to T3 Connect once; the server then registers with T3's relay at every start.
  - `T3_TAILSCALE=1` (in `plutonium.env`): Tailscale Serve publishes the server at `https://<machine>.<tailnet>.ts.net` while it runs (on 443; slot N on 8443 + 100 × N, or `T3_TAILSCALE_PORT`). The server stays on loopback, and Settings, Connections shows the pairing link's QR code for that address. It needs tailscaled running, and `sudo tailscale set --operator=$USER` so the server can configure Serve.
  - `plutonium t3 pair --tailscale`: a QR code over your tailnet, in the terminal.
  - `T3_HOST=0.0.0.0` with `plutonium t3 pair`: a QR code on your network.
  - **Settings, Connections, Network access** in the shell (patch 0016): the switch T3's desktop app has. The launcher runs the server under `lib/t3-server.sh`, which binds it to 0.0.0.0 or 127.0.0.1 from `$T3_HOME/plutonium-network-access`. Switching saves the choice there and restarts the server (running agents stop, as in the desktop app), and the shell stays signed in. Then Authorized clients makes pairing links and QR codes for the LAN address, for phones, browsers and other T3 Code apps (Add environment). `T3_HOST` pins the host, and the switch is then disabled. The machine's firewall must let `T3_PORT` (3773, as for T3's desktop app) in.

The log is `logs/t3-server.log`. The server needs Node 24.13+ and pnpm. If pnpm isn't installed, `corepack` provides the version T3 pins.

## What the patches do

| # | What |
|---|---|
| 0001–0003 | Native windows listed under the thread that started them, shown as tabs in its right panel, with pop out. Terminals are tagged with their thread. Each thread gets its own Xwayland for X11 apps |
| 0004 | Uses the Plutonium helper (`helper/`) for the thread environment and the agent bridge, instead of T3's own code |
| 0005 | T3's Browser panel runs on Plutonium's browser tabs |
| 0006 | Panel keys (Alt+1…9, Ctrl+Tab, Ctrl+T), a new browser tab, and an app launcher (Super+Space) |
| 0007–0008 | Thread tags and groups, and an "Elsewhere" list for importing windows and tabs from other shells |
| 0009 | Links and Ctrl+click open in the thread's browser panel |
| 0010 | Panel apps cross-fade when the panel is maximized or restored; an app's maximize button maximizes the panel |
| 0011 | The shell pairs with the launcher's token only when it needs to (not paired, or missing scopes) |
| 0012 | The server drives the panel's tabs, as it drives the desktop app's: over the helper's socket, with Playwright, through a relay to that one tab of the real browser. T3's agents use their own `preview_*` tools |
| 0013 | In a browser, Settings, Connections pairs over the addresses the server reports (its tailnet and LAN addresses, and its Tailscale Serve name), so the shell on loopback can show a QR code |
| 0014 | A page's popup (an OAuth sign-in window) is shown as a new panel tab that keeps `window.opener`, and closes with it |
| 0015 | What the user starts comes to the front: apps from a terminal (not setup or settle scripts) or the launcher open in the thread's panel with the keyboard. In another thread, they wait in its panel. What agents open waits, and a toast with Show says so while its thread is open |
| 0016 | Network access from the shell's Settings, Connections: the server, in a Plutonium session, saves the choice and restarts under the launcher's supervisor on the other host; the session cookie keeps its name |
| 0017 | Agents drive windows and tabs: T3's MCP server offers the helper's native window tools to every provider (listed from and forwarded to the helper, with the caller's thread), instead of Claude alone getting the helper's stdio server; the desktop browser channel's `open` and `close`, so the helper opens a server tab no page shows, instead of a 10 s wait and a headless tab ([AGENT_CONTROL](../../docs/features/AGENT_CONTROL.md#in-t3-code)) |
| 0018 | Windows held at an agent's size: `launch_app` takes a width and height; a window tab shows a held window scaled to fit the panel, locked, saying the agent is using it, with **Take control**; `read_window` and `act_window` ([AGENT_CONTROL](../../docs/features/AGENT_CONTROL.md#sizes-agents-hold)) |
| 0019 | `t3 auth session issue --runtime-mode-ceiling`: an `mcp-client` session issued from the CLI may launch threads up to that runtime mode (it was capped at approval-required), so the agent tool tests can drive a session's T3 Code from outside ([agent-tests](../../docs/agent-tests/README.md)) |

Details and test records are in [docs/history/T3_SHELL_TEST.md](../../docs/history/T3_SHELL_TEST.md), [docs/features/TABS.md](../../docs/features/TABS.md) ("In T3 Code"), [docs/features/CONTROLS.md](../../docs/features/CONTROLS.md) and [docs/features/SHELLS.md](../../docs/features/SHELLS.md).

## Limits

- **Thread tagging:** guaranteed for Claude and Codex threads. The other providers only get the tag when T3 gives the thread an MCP session.
- **T3's browser tools:** agents only get T3's `preview_*` tools with "Agent browser access" on (Settings). Without them, they can still use the helper's tab tools.
- **The agent bridge:** only Claude sessions get the helper's MCP server.
- **New apps:** only apps the user started open by themselves: from a thread's terminal or the launcher (`PLUTONIUM_SHOW`). An agent's wait in Apps, with a toast while their thread is open. Agents can ask for theirs to be shown (`focus: true`, or `PLUTONIUM_SHOW=1 <command>`).
- **X11 apps** started from a terminal don't open by themselves: Plutonium sees their windows as the thread's X server's, which has no `PLUTONIUM_SHOW`. They get the toast. The launcher still opens them.
- **Single-instance apps** (Firefox, VS Code, file managers): a second launch reuses the running process, so its new window goes by how that process was started.

## Changing it

Commit on the `plutonium` branch of the checkout, then `plutonium t3 export` rewrites `patches/`.
