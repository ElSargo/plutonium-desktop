# Hydra: T3 Code as a Plutonium shell

Hydra is built on [T3 Code](https://github.com/pingdotgg/t3code), a chat UI for coding agents by its authors (MIT license). The code is theirs; these patches make its web app a Plutonium shell, named Hydra:
- every chat thread gets the apps, terminals and browser tabs its agent and terminals start, in the thread's right panel;
- the agents get Plutonium's MCP tools for their thread's windows and tabs.

Hydra is optional, and all of it is in this folder: Plutonium knows it only through `shell.json` ([SHELL_PACKAGES.md](../../docs/features/SHELL_PACKAGES.md)). Styx, Charon and the plain shell need nothing from here.

- **`shell.json`**: a server shell, whose server is `bin/hydra serve`, and whose own command (`cli`) is `bin/hydra`: `plutonium hydra help`.
- **`bin/hydra`**: serving and pairing (the helper runs them), T3 Code's own CLI, and from a checkout `fetch`, `build`, `export`, `live` and `bundle`. **`bin/supervise`** keeps the server on the host the shell's Network access setting picks. **`lib/env.sh`**: its settings (`T3CODE_DIR`, `T3_HOME`, `T3_PORT`, …), which `plutonium.env` can set.
- **`src/BASE`**: the upstream T3 Code commit the patches apply to, a stable release's: v0.1.7 (`322f6544df`, 2026-11-03).
- **`src/patches/`**: the series (`git am`), one patch per part of Hydra, and no two touch the same file ("The patches" below). Most of it is in `apps/web/src/plutonium/`, `apps/server/src/plutonium/` and `packages/shared/src/plutonium.ts`.
- **`src/runtime.ts`**: the native packages a release's build carries (`hydra bundle`).

A release's build keeps Hydra's icons: T3's build and T3's own release step put T3's over `apps/web/public`'s, so `hydra bundle` copies `public/` back. The boot splash shows `apple-touch-icon.png`. A checkout's build never has T3's, so test this on a `hydra bundle` build (into `shells/hydra/build`, which a slot's session then runs).

An install copies `shell.json`, `bin/` and `lib/` into `~/.pluto/shells/hydra` (`exclude` leaves out `src/`, `build/` and this file). A release has the server built beside it, in `shells/hydra/build`; a checkout runs it from its T3 Code checkout's source.

```
plutonium hydra fetch     # clone into shells/hydra/src/checkout (T3CODE_DIR), branch plutonium
plutonium hydra build     # pnpm install, build the web app
plutonium hydra update    # move the patches to the newest stable T3 Code ("Updating T3 Code")
plutonium run hydra niri  # Hydra as the desktop, Styx behind it (Super+Tab)
```

`plutonium run hydra` starts the server if it isn't running, for that session's socket. `plutonium shells restart hydra [--x11]` restarts it, and `plutonium shells stop hydra` stops it. Each run offers the shell a one-time pairing token (5 minutes) as `#plutoniumPair=`, with the scopes T3's desktop app gets, so the shell can pair other devices from Settings, Connections. The page passes it on to T3 only if the profile isn't paired yet, or its session lacks some of those scopes, so a paired profile doesn't add a session each time.

### The host's T3 Code

The server runs on the host's own T3 Code data, as the T3 Code app and CLI do: `$T3CODE_HOME`, else `~/.t3` (`T3_HOME` overrides it). Threads, settings, and paired devices are the same in and out of Plutonium.

- **One at a time:** before starting, Plutonium looks for anything else using that data: the T3 Code app, a `t3` server, a boot service. It finds them by the open database, and by T3's `server-runtime.json`. If there is one, it refuses and says what it found; quit that one first. Plutonium's own server carries `PLUTONIUM_T3=<this checkout>`, so it is told apart and restarted.
- **The database's version:** T3 migrates its database when it opens it. Plutonium refuses a database from a newer T3 Code than the checkout. An older one is migrated, and first copied to `<database>.before-migration-<n>`. Since 0.1, T3's database is `statev2.sqlite`: on its first start T3 seeds it from a copy of `state.sqlite`, which it leaves as it was, so T3 Code before 0.1 still runs on the old data.
- **T3 Code's own CLI on NixOS:** the `t3` npm package is a native executable since 0.1, which NixOS can't run as it comes. Point it at Nix's loader with `patchelf --set-interpreter` and an rpath to glibc and gcc's `lib` (also for `resource-monitor/linux-x64/t3-resource-monitor`), or use nix-ld. Plutonium runs T3 from its checkout and doesn't need it.
- **Remote devices:** `plutonium hydra <command>` is T3's own CLI on the same data. `fetch` and `build` copy T3's `.env.example` to `.env`, the T3 Connect settings T3's release builds have. Without them, a source build has no T3 Connect. To pair remote devices, use one of:
  - `plutonium hydra connect link`: signs in to T3 Connect once; the server then registers with T3's relay at every start.
  - `T3_TAILSCALE=1` (in `plutonium.env`): Tailscale Serve publishes the server at `https://<machine>.<tailnet>.ts.net` while it runs (on 443; slot N on 8443 + 100 × N, or `T3_TAILSCALE_PORT`). The server stays on loopback, and Settings, Connections shows the pairing link's QR code for that address. It needs tailscaled running, and `sudo tailscale set --operator=$USER` so the server can configure Serve.
  - `plutonium hydra pair --tailscale`: a QR code over your tailnet, in the terminal.
  - `T3_HOST=0.0.0.0` with `plutonium hydra pair`: a QR code on your network.
  - **Settings, Connections, Network access** in the shell (T3 patch 0016): the switch T3's desktop app has. The launcher runs the server under `shells/hydra/bin/supervise`, which binds it to 0.0.0.0 or 127.0.0.1 from `$T3_HOME/plutonium-network-access`. Switching saves the choice there and restarts the server (running agents stop, as in the desktop app), and the shell stays signed in. Then Authorized clients makes pairing links and QR codes for the LAN address, for phones, browsers and other T3 Code apps (Add environment). `T3_HOST` pins the host, and the switch is then disabled. The machine's firewall must let `T3_PORT` (3773, as for T3's desktop app) in.

The log is `~/.pluto/logs/hydra.log`. The server needs Node 24.13+ and pnpm. If pnpm isn't installed, `corepack` provides the version T3 pins.

## The patches

One patch per part of Hydra, in this order. Each file T3 Code's source has belongs to one patch only, so a patch is the change to its files, and updating T3 Code meets each conflict once, in one place. A change goes into the patch whose files it touches ("Changing it").

| # | Part | Its files |
|---|---|---|
| 0001 | The shared module (`@t3tools/shared/plutonium`: the helper's socket, thread tags, the agent and terminal environment) and what the contracts add: the desktop browser channel's Plutonium commands, preview tools' drag paths and `busy`, keybindings (the dock, the launcher, panel keys, the file manager), usage warnings | `packages/` |
| 0002 | The app is Hydra: its name, mark and icons where the text means this app; the welcome wizard keeps the computer serving it selected, and has no usage-data notice or ChatGPT plan dialog | `apps/web`: branding, settings and onboarding text, `public/` |
| 0003 | The page's start: the helper's origin, pairing with the launcher's token, the boot error reloading by itself; Settings, Connections: network access and pairing over the server's addresses | `apps/web/src/main.tsx`, `ConnectionsSettings.tsx`, `lib/bootError.ts`, `plutonium/{helperOrigin,pairing,directEndpoints,networkAccess}.ts` |
| 0004 | The dock (Super+1…9, the sidebar's buttons, the slot editor, site icons) | `plutonium/{dock,PlutoniumDock}.ts(x)`, `SidebarChrome.tsx` |
| 0005 | The status cluster and quick settings | `plutonium/{PlutoniumStatus,systemServices}`, the headers, `index.css` |
| 0006 | The browser panel on Plutonium's browser tabs: the preview bridge, the floating preview's cursor and private badge | `plutonium/{PlutoniumBrowserHost,previewBridge}`, `components/preview/`, `browser/` |
| 0007 | A thread's right panel: native windows and the Apps tab, terminals tagged with their thread, panel keys and the app launcher, tags and Elsewhere, what opens comes to the front, hidden tabs' background tabs, the file manager and picker (`plutonium/files/`, [FILE_MANAGER](../../docs/features/FILE_MANAGER.md)); `plutonium/useThreadPlutonium.ts` is everything ChatView adds | the rest of `apps/web` |
| 0008 | The server's thread environment (agents' and terminals' processes tagged with their thread), `auth session issue --runtime-mode-ceiling`, network access, forgetting archived threads' permissions; connecting clients' owners aren't recorded (0011) | `apps/server/src/{server,ws}.ts`, `terminal/`, `orchestration-v2/`, `auth/`, `cli/` |
| 0009 | The server's browser tabs through Plutonium's helper: the helper opens and closes them, recordings are captures, stuck actions are abandoned, snapshots in click coordinates, native windows' tabs | `apps/server/src/preview/`, `apps/desktop/` |
| 0010 | Agents drive windows and tabs: the helper's window and tab tools in T3's MCP server, usage-limit warnings, native windows as every client's server tabs | `apps/server/src/mcp/`, `apps/server/src/plutonium/` |
| 0011 | No telemetry, ads or upsells; update checks are opt-in. Usage analytics are dropped where they're recorded (`AnalyticsService` keeps its interface, sends nothing), the server doesn't read the Claude or OpenAI account ids, clients send no owner hashes, relay traces are never configured. Gone: the GitHub star prompt, "Created in T3 Code" in new projects' READMEs, T3 Chat upgrade prompts, the hosted pages' download links. `enableProviderUpdateChecks` (agent CLI versions, the model catalog) defaults to off, and `plutonium/UpdateChecksPrompt.tsx` asks once on the first launch | `apps/server/src/telemetry/`, `cloud/publicConfig.ts`, `packages/client-runtime/src/authorization/remote.ts`, `packages/contracts/src/settings.ts`, `apps/web` (`__root.tsx`, settings, cloud and clerk pages) |
| 0013 | Pluto Vim in the composer ([PLUTO_VIM.md](../../docs/features/PLUTO_VIM.md), Pages that integrate): the editor declares its actions (submit, the prompt history, an open menu's Ctrl+N/P/Y/E, yielded while it's open) and the `model` and `stash` commands; each runs the composer's own key handling | `plutonium/plutoVim.ts`, `components/chat/ChatComposer.tsx` (one hook call) |

Until v0.1.7 the series was 56 patches, one per change, which older docs and commit messages cite as "T3 patch 00NN". That series is the branch `plutonium-v0.1.0` of the T3 Code checkout; the table below says what each of them added. 0053 (websocket tickets at `/api/auth/websocket-ticket/<use>`) is upstream since 0.1.x and was dropped. In 0.1.7 T3 Code intercepts a desktop tab's file picker itself while an agent acts on the tab, so 0051's picker is the desktop's only otherwise.

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
| 0031 | The dock: Super+1…9 slots for T3's terminal drawer, apps and sites, kept per thread, per project or everywhere; run, raise and go back, split or fold the chat; Super+Shift+N and the tab menu assign them ([HYDRA_DOCK](../../docs/features/HYDRA_DOCK.md)). A focused tab or app no longer loses the keyboard to the composer |
| 0032 | The dock in the sidebar, above the settings row: a button per slot (its icon, its number, whether it runs or shows), clicked as Super+N; a right click puts the panel's tab or the terminal there, or sets the scope or layout. Panel tabs in the dock show their number |
| 0033 | The dock's slot editor (right click, or click an empty slot): terminal, app (searchable picker) or site, name, scope, layout, clear; sites show their own icon (open tab, T3's remembered one, then `/favicon.ico`), not Google's favicon service ([HYDRA_DOCK](../../docs/features/HYDRA_DOCK.md)) |
| 0034 | Dock sites kept per project or everywhere: one tab with the scope's tag, which moves to the thread whose key or button asks for it; closing it closes it. A tab brought into a preview (the dock's, or imported from Elsewhere) replaces the server's own blank tab instead of being closed ([HYDRA_DOCK](../../docs/features/HYDRA_DOCK.md#sites-in-a-scope-patch-0034-2026-10-27)) |
| 0035 | The dock's key hides what its slot shows in a thread just switched to (the switch gave the composer the keyboard, so the key used to only focus it); going back never shows the slot's own thing again ([HYDRA_DOCK](../../docs/features/HYDRA_DOCK.md#keys)) |
| 0036 | Agents get the helper's tab tools preview tools have no counterpart for (`find_in_tab`, `answer_permission`, `request_permission`, `choose_files`, `print_tab`, `cancel_print`, `list_printers`, `list_downloads`, `download_action`, and `tab_requests`), on T3's tab ids ([AGENT_CONTROL](../../docs/features/AGENT_CONTROL.md#in-t3-code)) |
| 0037 | An archived or deleted thread's permission grants are forgotten: the server asks the helper, which has a shell page call `forgetThreadPermissions` ([TAB_FEATURES](../../docs/features/TAB_FEATURES.md)) |
| 0038 | `orchestrator_capabilities` gives each provider instance near (80%) or at a subscription usage limit a `usageWarning`: the window, how much is used, when it resets |
| 0044 | The app names itself Hydra (title, sidebar, welcome, settings and errors that mean this app) with a mark of its own instead of T3's wordmark and icons; text about T3 Code itself (its desktop and mobile apps, T3 Connect, the `t3` CLI, privacy and license notices) keeps its name |
| 0046 | The welcome wizard's "Connect your computers" step keeps the computer serving the app selected; its box is disabled |
| 0047 | The status cluster at the title bar's right end, always shown: the time, the battery when not on AC, offline and muted icons; a click opens quick settings (calendar, volume, brightness, Wi-Fi, Bluetooth, media, lock and power) over the helper's desktop services. The panel toggles and headers make room for it ([HYDRA_DOCK](../../docs/features/HYDRA_DOCK.md#the-tray)) |
| 0049 | Quick settings' Displays and All settings rows, over the helper's `display` service: they open the switcher's Displays page (the display configuration tool) and its quick settings ([SHELLS](../../docs/features/SHELLS.md#step-3-the-overlay-the-switcher)) |
| 0050 | Dock sites' icons from the helper: after an open tab's and the remembered one, the shell library's `siteIcon` (the helper reads the site's `<link rel="icon">`, else its `/favicon.ico`, and isn't held to the site's cross-origin rules, as claude.ai's `/favicon.ico` is for a page); the page's own `/favicon.ico` with an older library ([HYDRA_DOCK](../../docs/features/HYDRA_DOCK.md)) |
| 0051 | A desktop tab's file picker is the desktop's: the server no longer listens for Playwright's `filechooser` on tabs Plutonium renders (it intercepted every `<input type=file>`, and only T3's streamed surface shows that), so the shell draws its picker over the tab; agents answer it with `choose_files` ([TAB_FEATURES](../../docs/features/TAB_FEATURES.md#file-pickers)) |
| 0054 | Native windows are their threads' server tabs, for every T3 client: the mobile app and T3's desktop app list and stream a window as they do a page (`/api/preview-stream`), take control of it, and type into it; closing the tab asks the app to close the window. Agents' preview tools and Hydra's own browser panel leave them out ([REMOTE_WINDOWS](../../docs/features/REMOTE_WINDOWS.md#windows-as-server-tabs-for-every-t3-client)) |

Details and test records are in [docs/history/T3_SHELL_TEST.md](../../docs/history/T3_SHELL_TEST.md), [docs/features/TABS.md](../../docs/features/TABS.md) ("In T3 Code"), [docs/features/CONTROLS.md](../../docs/features/CONTROLS.md) and [docs/features/SHELLS.md](../../docs/features/SHELLS.md).

## Limits

- **Thread tagging:** guaranteed for Claude and Codex threads. The other providers only get the tag when T3 gives the thread an MCP session.
- **T3's browser tools:** agents only get T3's `preview_*` tools with "Agent browser access" on (Settings). Without them, they can still use the helper's tab tools.
- **The agent bridge:** only Claude sessions get the helper's MCP server.
- **New apps:** only apps the user started open by themselves: from a thread's terminal or the launcher (`PLUTONIUM_SHOW`). An agent's wait in Apps, with a toast while their thread is open. Agents can ask for theirs to be shown (`focus: true`, or `PLUTONIUM_SHOW=1 <command>`).
- **X11 apps** started from a terminal don't open by themselves: Plutonium sees their windows as the thread's X server's, which has no `PLUTONIUM_SHOW`. They get the toast. The launcher still opens them.
- **Single-instance apps** (Firefox, VS Code, file managers): a second launch reuses the running process, so its new window goes by how that process was started.

## Changing it

Work on the `plutonium` branch of the checkout (`T3CODE_DIR`), or a branch off it. Commit each change as a fixup of the patch whose files it changes (`git commit --fixup=<that patch's commit>`, then `git rebase -i --autosquash $(cat src/BASE)`), so the series stays one patch per part. A new file goes to the part it belongs to (`apps/web/src/plutonium/` and `apps/server/src/plutonium/` files to the patch that uses them); a new part is a new patch at the end, with this table updated. Then `plutonium hydra export` rewrites `src/patches/`. To try a T3 Code worktree's web app in a running session without restarting its server: `plutonium hydra live apply --from <worktree>` (`plutonium hydra live --help`).

Keep upstream files' changes small: a hook or a few lines that call into `plutonium/` (as ChatView calls `useThreadPlutonium`) cost little at the next update; logic inside upstream's files is what conflicts.

## Updating T3 Code

Hydra follows T3 Code's stable releases (`vX.Y.Z` tags; nightlies aren't followed). Plutonium's history gets one commit per update, `src/BASE` and the rewritten patches; T3 Code's commits stay in the T3 Code checkout.

```
plutonium hydra update              # the newest vX.Y.Z (or: plutonium hydra update v0.1.8)
# conflicts: resolve them in ~/.local/share/plutonium/hydra-update, git add, then
plutonium hydra update --continue   # or --abort
```

It applies `src/patches` to `src/BASE` in a worktree of the checkout, on a branch `plutonium-<tag>`, and rebases it onto the tag, with rerere on, so a conflict resolved once isn't asked again. When the rebase is done it rewrites `src/BASE` and `src/patches`, commits them here (`Hydra: T3 Code <tag> (from <old tag>), N patches`, on the current branch: make one first), and moves the checkout's `plutonium` branch to the new series; the old one stays as `plutonium-<old tag>`. Then, in the checkout:

1. `plutonium hydra build`.
2. Typecheck: `npx tsc-rs --noEmit` in `packages/contracts`, `packages/shared`, `apps/server` and `apps/web`. Run it with `env -u PLUTONIUM_T3 -u PLUTONIUM_HELPER` from inside a Plutonium session, whose variables the agent's shell inherits.
3. Test the Plutonium parts: `node_modules/.bin/vp test run src/plutonium src/preview src/mcp src/auth` in `apps/server` (the same `env -u`), `../../node_modules/.bin/vp test run src/plutonium src/rightPanelStore.test.ts src/lib/bootError.test.ts` in `apps/web`.
4. Try it in a session (`plutonium run hydra`), then merge the commit.

Resolving a conflict: keep the patch to its files and to what it adds. When upstream rewrote a file, take upstream's version and add the patch's lines again where the code now is; when upstream now does what a patch did, drop that part of the patch. The release's own changelog (`git log <old>..<new> -- <file>`) says why a file changed.
