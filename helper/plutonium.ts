#!/usr/bin/env node
// Plutonium helper CLI (Node 24+, no dependencies).
//
//   plutonium.ts daemon [--wayland-display wayland-plutonium] --shell-origin http://127.0.0.1:3773[,<origin>…] [--port 3780]
//     [--cdp-socket <path> | --cdp-port 9222]
//   plutonium.ts thread-setup <thread-id>   JSON {env, mcpServer} for a thread's processes
//   plutonium.ts launch <thread-id> <argv>…  start an app in a thread
//   plutonium.ts mcp                        the agent bridge as a stdio MCP server
//   plutonium.ts open <url|file>…           xdg-open for a thread's apps: web links
//                                           become tabs in $PLUTONIUM_THREAD_ID
//   plutonium.ts shells <command>           the installed shells (shellsCli.ts)
//   plutonium.ts appearance [light|dark|toggle|default]
//                                           light or dark for the whole desktop
//   plutonium.ts sites apply|report|read|snapshot <tab> | sites check
//                         | sites import <file|url> [site]
//                                           site extensions, for an agent writing one
//                                           (SITE_EXTENSIONS.md): on a tab of
//                                           $PLUTONIUM_THREAD_ID's (one lent to it)
//   plutonium.ts vim check [--pluto-home <dir>]
//                                           Pluto Vim's init.js in a dry run: errors
//                                           and warnings (vimConfig.ts)
//   plutonium.ts stop-x-displays            stops the threads' X servers a stopped
//                                           helper left running (plutonium stop)
//
// Clients find the daemon's socket in $PLUTONIUM_HELPER (set in every thread
// process), else from --wayland-display / $PLUTONIUM_WAYLAND_DISPLAY.
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { helperJson } from "./src/client.ts";
import { Daemon, defaultSocketPath } from "./src/daemon.ts";
import { runMcpServer } from "./src/mcp.ts";
import { runOpen } from "./src/opener.ts";
import { ShellPackages } from "./src/shellPackages.ts";
import { plutoHome } from "./src/shells.ts";
import { PLUTONIUM_ROOT, runShellsCommand } from "./src/shellsCli.ts";
import { HELPER_VARIABLE, stopXDisplays, THREAD_ID_VARIABLE, wantsShow, xDisplayStatePath } from "./src/threads.ts";
import { checkConfig, configDir, INIT } from "./src/vimConfig.ts";

const [command, ...rest] = process.argv.slice(2);
// An app's own arguments (after `launch <thread-id>`) aren't ours to parse.
const ownArgs = command === "launch" || command === "open" || command === "shells" || command === "sites" ? [] : rest;
const { values, positionals } = parseArgs({
  args: ownArgs,
  allowPositionals: true,
  options: {
    "wayland-display": { type: "string" },
    "shell-origin": { type: "string" },
    port: { type: "string" },
    socket: { type: "string" },
    "cdp-port": { type: "string" },
    "cdp-socket": { type: "string" },
    "pluto-home": { type: "string" },
    "shells-port": { type: "string" },
    slot: { type: "string" },
    "persist-shells": { type: "boolean" },
  },
});

const waylandDisplay = values["wayland-display"] ?? process.env.PLUTONIUM_WAYLAND_DISPLAY ?? "wayland-plutonium";
const socketPath = values.socket ?? process.env[HELPER_VARIABLE] ?? defaultSocketPath(waylandDisplay);

// The browser's DevTools: --cdp-socket (Unix socket) or --cdp-port.
function cdpEndpoint(): { socketPath: string } | { port: number } | undefined {
  const socketPath = values["cdp-socket"] ?? process.env.PLUTONIUM_CDP_SOCKET;
  if (socketPath) return { socketPath };
  const port = Number(values["cdp-port"] ?? process.env.PLUTONIUM_CDP_PORT ?? 0);
  return port ? { port } : undefined;
}

function usage(): never {
  console.error(
    "usage: plutonium.ts daemon --shell-origin <origin>[,<origin>…] [--wayland-display <name>] [--port <n>]\n" +
      "         [--cdp-socket <path> | --cdp-port <n>]   (the browser's DevTools, for server-driven tabs)\n" +
      "         [--shells-port <n> --slot <n> [--pluto-home <dir>] [--persist-shells]]   (installed shells)\n" +
      "       plutonium.ts thread-setup <thread-id>\n" +
      "       plutonium.ts launch <thread-id> <program> [args…]\n" +
      "       plutonium.ts mcp\n" +
      "       plutonium.ts open <url|file>…\n" +
      "       plutonium.ts appearance [light|dark|toggle|default]\n" +
      "       plutonium.ts sites apply|report|read|snapshot <tab-id> | sites check | sites import <file|url> [site]\n" +
      "       plutonium.ts vim check [--pluto-home <dir>]\n" +
      "       plutonium.ts stop-x-displays [--wayland-display <name>]",
  );
  process.exit(2);
}

switch (command) {
  case "daemon": {
    // A stray rejected promise (the browser not up yet, say) is logged, not
    // fatal: every app launch and the launcher go through this process.
    process.on("unhandledRejection", (error) => console.error("plutoniumd: unhandled rejection:", error));
    // Comma-separated: a session can have several shells.
    const shellOrigins = (values["shell-origin"] ?? process.env.PLUTONIUM_SHELL_ORIGIN ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
      .map((origin) => new URL(origin).origin);
    if (shellOrigins.length === 0) usage();
    const port = Number(values.port ?? process.env.PLUTONIUM_HELPER_PORT ?? 3780);
    const shellsPort = Number(values["shells-port"] ?? 0) || undefined;
    const shells = shellsPort
      ? new ShellPackages(
          {
            home: values["pluto-home"] ?? plutoHome(),
            slot: Number(values.slot ?? 0),
            shellsPort,
            helperUrl: `http://127.0.0.1:${port}`,
            helperSocket: socketPath,
            waylandDisplay,
            plutonium: PLUTONIUM_ROOT,
          },
          { persist: values["persist-shells"] ?? false },
        )
      : undefined;
    const daemon = new Daemon({
      waylandDisplay,
      shellOrigins,
      port,
      socketPath,
      shells,
      shellsPort,
      cdp: cdpEndpoint(),
    });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.once(signal, () => {
        daemon.stop();
        process.exit(0);
      });
    }
    await daemon.start();
    break;
  }
  case "thread-setup": {
    const [threadId] = positionals;
    if (!threadId) usage();
    console.log(
      JSON.stringify(await helperJson(socketPath, "GET", `/v1/thread-setup?thread=${encodeURIComponent(threadId)}`)),
    );
    break;
  }
  case "launch": {
    const [threadId, ...argv] = rest[0] === "--" ? rest.slice(1) : rest;
    if (!threadId || argv.length === 0) usage();
    console.log(
      JSON.stringify(
        await helperJson(socketPath, "POST", "/v1/launch", {
          thread: threadId,
          argv,
          waitMs: 10_000,
          // Shown if whoever ran this was (a terminal's command is).
          show: wantsShow(process.env),
        }),
      ),
    );
    break;
  }
  case "mcp":
    runMcpServer();
    break;
  case "open":
    process.exitCode = await runOpen(rest, socketPath);
    break;
  case "shells":
    process.exitCode = runShellsCommand(rest);
    break;
  case "appearance": {
    // Light or dark (docs/features/APPEARANCE.md): prints the scheme, after setting it if asked.
    const [choice] = positionals;
    const base = "/v1/system/services/appearance";
    type State = { colorScheme: string; chosen: boolean };
    let state: State;
    if (!choice) state = await helperJson<State>(socketPath, "GET", base);
    else if (choice === "toggle") state = (await helperJson<{ value: State }>(socketPath, "POST", `${base}/toggle`, {})).value;
    else if (choice === "light" || choice === "dark" || choice === "default") {
      const colorScheme = choice === "default" ? null : choice;
      state = (await helperJson<{ value: State }>(socketPath, "POST", `${base}/set`, { colorScheme })).value;
    } else usage();
    console.log(`${state.colorScheme}${state.chosen ? "" : " (the default)"}`);
    break;
  }
  case "sites": {
    // For an agent writing a site extension, with any provider: the same as the
    // site_apply, site_report, read_tab and snapshot_tab tools, on its thread's tab.
    const [action, tab] = rest;
    if (action === "import") {
      // A user script or user style, from a file or a URL, as a part of its site.
      const [, from, site] = rest;
      if (!from) usage();
      const { readFileSync } = await import("node:fs");
      const text = /^https?:\/\//.test(from) ? await (await fetch(from)).text() : readFileSync(from, "utf8");
      try {
        const result = await helperJson<{ site: string; part: string; notes: string[] }>(socketPath, "POST", "/v1/sites/import", { text, source: from, site });
        console.log(`imported as ${result.site}/${result.part}`);
        for (const note of result.notes) console.log(`  not carried over: ${note}`);
      } catch (error) {
        console.error(`plutonium.ts sites import: ${(error as Error).message}`);
        process.exitCode = 1;
      }
      break;
    }
    if (action === "check") {
      // Stale parts: a site changed under them (SITE_EXTENSIONS.md, "Keeping them working").
      const { stale } = await helperJson<{ stale: { part: string; kind: string; detail: string; url: string }[] }>(socketPath, "GET", "/v1/sites/stale");
      for (const reason of stale) console.log(`${reason.part}: ${reason.kind === "error" ? "throws" : "matches nothing:"} ${reason.detail} (${reason.url})`);
      if (stale.length === 0) console.log("No stale site extensions.");
      process.exitCode = stale.length ? 1 : 0;
      break;
    }
    const thread = process.env[THREAD_ID_VARIABLE];
    if (!tab || !/^\d+$/.test(tab) || !["apply", "report", "read", "snapshot"].includes(action ?? "")) usage();
    // Outside a thread (an agent the user started elsewhere, with a copied prompt), apply
    // and report go to any tab: the helper's socket is this user's only.
    if (!thread && (action === "read" || action === "snapshot")) {
      console.error(`plutonium.ts sites ${action}: only in a Plutonium thread (no PLUTONIUM_THREAD_ID).`);
      process.exit(2);
    }
    const base = thread ? `/v1/threads/${encodeURIComponent(thread)}` : "";
    try {
      if (action === "apply" || action === "report") {
        const path = thread ? `${base}/tabs/${tab}/sites` : `/v1/sites/tabs/${tab}`;
        const report = await helperJson(socketPath, action === "apply" ? "POST" : "GET", `${path}${action === "apply" ? "/apply" : ""}`);
        console.log(JSON.stringify(report, null, 2));
      } else {
        const { content } = await helperJson<{ content: { type: string; text?: string; data?: string }[] }>(socketPath, "POST", `${base}/mcp/call`, {
          name: action === "read" ? "read_tab" : "snapshot_tab",
          arguments: { tab_id: Number(tab) },
        });
        for (const part of content) {
          if (part.type === "text") console.log(part.text);
          else if (part.type === "image" && part.data) {
            const { writeFileSync } = await import("node:fs");
            const { join } = await import("node:path");
            const { tmpdir } = await import("node:os");
            const file = join(tmpdir(), `plutonium-tab-${tab}-${Date.now()}.png`);
            writeFileSync(file, Buffer.from(part.data, "base64"));
            console.log(file);
          }
        }
      }
    } catch (error) {
      console.error(`plutonium.ts sites ${action}: ${(error as Error).message}`);
      process.exitCode = 1;
    }
    break;
  }
  case "vim": {
    // Pluto Vim's init.js, loaded in a dry run against the engine (docs/features/PLUTO_VIM.md, init.js).
    if (positionals[0] !== "check") usage();
    const dir = configDir(values["pluto-home"] ?? plutoHome());
    const result = checkConfig(dir, fileURLToPath(new URL("./web/vim", import.meta.url)));
    const name = `${dir}/${INIT}`;
    if (result.ok) console.log(`${name}: ok (${result.summary})`);
    else console.log(`${name}: doesn't load; a session keeps running the last version that did`);
    for (const error of result.errors) console.log(`error: ${error}`);
    for (const warning of result.warnings) console.log(`warning: ${warning}`);
    process.exitCode = result.ok ? 0 : 1;
    break;
  }
  case "stop-x-displays":
    // The helper keeps them running across its restarts.
    stopXDisplays(xDisplayStatePath(waylandDisplay, socketPath));
    break;
  default:
    usage();
}
