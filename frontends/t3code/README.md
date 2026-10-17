# T3 Code as a Plutonium shell

[T3 Code](https://github.com/pingdotgg/t3code) is a chat UI for coding agents. With these patches its web app runs as a Plutonium shell:
- every chat thread gets the apps, terminals and browser tabs its agent and terminals start, in the thread's right panel;
- the agents get Plutonium's MCP tools for their thread's windows and tabs.

T3 Code is optional. The niri and plain shells need nothing from here.

- **`BASE`**: the upstream T3 Code commit the patches apply to (`6c8fed35dd`, 2026-10-02).
- **`patches/`**: the series (`git am`): 9 commits, about 3,000 lines, mostly in `apps/web/src/plutonium/` and `apps/server/src/plutonium.ts`.

```
plutonium t3 fetch     # clone into frontends/t3code/checkout (T3CODE_DIR), branch plutonium
plutonium t3 build     # pnpm install, build the web app
plutonium t3 server    # start the server for the DRM session (--x11 for an X11 one)
plutonium run t3 niri  # T3 as the desktop, niri behind it (Super+Tab)
```

On the first run, the server prints a pairing URL. Start the session with it once, so the shell's browser profile is paired:

```
plutonium run 't3=http://127.0.0.1:3774/pair#token=…'
```

The server keeps its data in `$DATA_DIR/t3` (default `~/.local/share/plutonium/t3`), and its log is `logs/t3-server.log`. It needs Node 24.13+ and pnpm. If pnpm isn't installed, `corepack` provides the version T3 pins.

## What the patches do

| # | What |
|---|---|
| 0001–0003 | Native windows listed under the thread that started them, shown as tabs in its right panel, with pop out. Terminals are tagged with their thread. Each thread gets its own Xwayland for X11 apps |
| 0004 | Uses the Plutonium helper (`helper/`) for the thread environment and the agent bridge, instead of T3's own code |
| 0005 | T3's Browser panel runs on Plutonium's browser tabs. T3's agents drive them with their `preview_*` tools |
| 0006 | Panel keys (Alt+1…9, Ctrl+Tab, Ctrl+T), a new browser tab, and an app launcher (Super+Space) |
| 0007–0008 | Thread tags and groups, and an "Elsewhere" list for importing windows and tabs from other shells |
| 0009 | Links and Ctrl+click open in the thread's browser panel |
| 0010 | Panel apps cross-fade when the panel resizes; an app's maximize button maximizes the panel |

Details and test records are in [docs/history/T3_SHELL_TEST.md](../../docs/history/T3_SHELL_TEST.md), [docs/features/TABS.md](../../docs/features/TABS.md) ("In T3 Code"), [docs/features/CONTROLS.md](../../docs/features/CONTROLS.md) and [docs/features/SHELLS.md](../../docs/features/SHELLS.md).

## Limits

- **Thread tagging:** guaranteed for Claude threads. Codex and the other providers only get the tag when T3 gives the thread an MCP session.
- **The agent bridge:** only Claude sessions get the helper's MCP server.
- **New apps:** an app that is launched doesn't get a tab by itself; open it from Apps.

## Changing it

Commit on the `plutonium` branch of the checkout, then `plutonium t3 export` rewrites `patches/`.
