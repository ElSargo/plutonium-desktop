# T3 Code as a Plutonium shell

[T3 Code](https://github.com/pingdotgg/t3code) is a chat UI for coding agents. With these patches its web app runs as a Plutonium shell:
- every chat thread gets the apps, terminals and browser tabs its agent and terminals start, in the thread's right panel;
- the agents get Plutonium's MCP tools for their thread's windows and tabs.

T3 Code is optional. The niri and plain shells need nothing from here.

- **`BASE`**: the upstream T3 Code commit the patches apply to (`6c8fed35dd`, 2026-10-02).
- **`patches/`**: the series (`git am`): 11 commits, about 3,000 lines, mostly in `apps/web/src/plutonium/` and `apps/server/src/plutonium.ts`.

```
plutonium t3 fetch     # clone into frontends/t3code/checkout (T3CODE_DIR), branch plutonium
plutonium t3 build     # pnpm install, build the web app
plutonium run t3 niri  # T3 as the desktop, niri behind it (Super+Tab)
```

`plutonium run t3` starts the server if it isn't running, for that session's socket. `plutonium t3 server [--x11]` restarts it, and `plutonium t3 stop` stops it. Each run offers the shell a one-time pairing token (5 minutes) as `#plutoniumPair=`. The page passes it on to T3 only if the profile isn't paired yet, so a paired profile doesn't add a session each time.

### The host's T3 Code

The server runs on the host's own T3 Code data, as the T3 Code app and CLI do: `$T3CODE_HOME`, else `~/.t3` (`T3_HOME` overrides it). Threads, settings, and paired devices are the same in and out of Plutonium.

- **One at a time:** before starting, Plutonium looks for anything else using that data: the T3 Code app, a `t3` server, a boot service. It finds them by the open database, and by T3's `server-runtime.json`. If there is one, it refuses and says what it found; quit that one first. Plutonium's own server carries `PLUTONIUM_T3=<this checkout>`, so it is told apart and restarted.
- **The database's version:** T3 migrates its database when it opens it. Plutonium refuses a database from a newer T3 Code than the checkout. An older one is migrated, and first copied to `state.sqlite.before-migration-<n>`.
- **Remote devices:** `plutonium t3 <command>` is T3's own CLI on the same data. `fetch` and `build` copy T3's `.env.example` to `.env`, the T3 Connect settings T3's release builds have. Without them, a source build has no T3 Connect. To pair remote devices, use one of:
  - `plutonium t3 connect link`: signs in to T3 Connect once; the server then registers with T3's relay at every start.
  - `plutonium t3 pair --tailscale`: a QR code over your tailnet.
  - `T3_HOST=0.0.0.0` with `plutonium t3 pair`: a QR code on your network.

The log is `logs/t3-server.log`. The server needs Node 24.13+ and pnpm. If pnpm isn't installed, `corepack` provides the version T3 pins.

## What the patches do

| # | What |
|---|---|
| 0001–0003 | Native windows listed under the thread that started them, shown as tabs in its right panel, with pop out. Terminals are tagged with their thread. Each thread gets its own Xwayland for X11 apps |
| 0004 | Uses the Plutonium helper (`helper/`) for the thread environment and the agent bridge, instead of T3's own code |
| 0005 | T3's Browser panel runs on Plutonium's browser tabs. T3's agents drive them with their `preview_*` tools |
| 0006 | Panel keys (Alt+1…9, Ctrl+Tab, Ctrl+T), a new browser tab, and an app launcher (Super+Space) |
| 0007–0008 | Thread tags and groups, and an "Elsewhere" list for importing windows and tabs from other shells |
| 0009 | Links and Ctrl+click open in the thread's browser panel |
| 0010 | Panel apps cross-fade when the panel is maximized or restored; an app's maximize button maximizes the panel |
| 0011 | The shell pairs with the launcher's token only if it isn't paired yet |

Details and test records are in [docs/history/T3_SHELL_TEST.md](../../docs/history/T3_SHELL_TEST.md), [docs/features/TABS.md](../../docs/features/TABS.md) ("In T3 Code"), [docs/features/CONTROLS.md](../../docs/features/CONTROLS.md) and [docs/features/SHELLS.md](../../docs/features/SHELLS.md).

## Limits

- **Thread tagging:** guaranteed for Claude threads. Codex and the other providers only get the tag when T3 gives the thread an MCP session.
- **The agent bridge:** only Claude sessions get the helper's MCP server.
- **New apps:** an app that is launched doesn't get a tab by itself; open it from Apps.

## Changing it

Commit on the `plutonium` branch of the checkout, then `plutonium t3 export` rewrites `patches/`.
