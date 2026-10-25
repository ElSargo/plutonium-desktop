#!/usr/bin/env node
// Plutonium helper CLI (Node 24+, no dependencies).
//
//   plutonium.ts daemon [--wayland-display wayland-plutonium] --shell-origin http://127.0.0.1:3773[,<origin>…] [--port 3780]
//     [--cdp-port 9222]
//   plutonium.ts thread-setup <thread-id>   JSON {env, mcpServer} for a thread's processes
//   plutonium.ts launch <thread-id> <argv>…  start an app in a thread
//   plutonium.ts mcp                        the agent bridge as a stdio MCP server
//   plutonium.ts open <url|file>…           xdg-open for a thread's apps: web links
//                                           become tabs in $PLUTONIUM_THREAD_ID
//   plutonium.ts shells <command>           the installed shells (shellsCli.ts)
//   plutonium.ts stop-x-displays            stops the threads' X servers a stopped
//                                           helper left running (plutonium stop)
//
// Clients find the daemon's socket in $PLUTONIUM_HELPER (set in every thread
// process), else from --wayland-display / $PLUTONIUM_WAYLAND_DISPLAY.
import { parseArgs } from "node:util";

import { helperJson } from "./src/client.ts";
import { Daemon, defaultSocketPath } from "./src/daemon.ts";
import { runMcpServer } from "./src/mcp.ts";
import { runOpen } from "./src/opener.ts";
import { plutoHome, ShellPackages } from "./src/shells.ts";
import { PLUTONIUM_ROOT, runShellsCommand } from "./src/shellsCli.ts";
import { HELPER_VARIABLE, stopXDisplays, wantsShow, xDisplayStatePath } from "./src/threads.ts";

const [command, ...rest] = process.argv.slice(2);
// An app's own arguments (after `launch <thread-id>`) aren't ours to parse.
const ownArgs = command === "launch" || command === "open" || command === "shells" ? [] : rest;
const { values, positionals } = parseArgs({
  args: ownArgs,
  allowPositionals: true,
  options: {
    "wayland-display": { type: "string" },
    "shell-origin": { type: "string" },
    port: { type: "string" },
    socket: { type: "string" },
    "cdp-port": { type: "string" },
    "pluto-home": { type: "string" },
    "shells-port": { type: "string" },
    slot: { type: "string" },
    "persist-shells": { type: "boolean" },
  },
});

const waylandDisplay = values["wayland-display"] ?? process.env.PLUTONIUM_WAYLAND_DISPLAY ?? "wayland-plutonium";
const socketPath = values.socket ?? process.env[HELPER_VARIABLE] ?? defaultSocketPath(waylandDisplay);

function usage(): never {
  console.error(
    "usage: plutonium.ts daemon --shell-origin <origin>[,<origin>…] [--wayland-display <name>] [--port <n>]\n" +
      "         [--cdp-port <n>]   (the browser's DevTools port, for server-driven tabs)\n" +
      "         [--shells-port <n> --slot <n> [--pluto-home <dir>] [--persist-shells]]   (installed shells)\n" +
      "       plutonium.ts thread-setup <thread-id>\n" +
      "       plutonium.ts launch <thread-id> <program> [args…]\n" +
      "       plutonium.ts mcp\n" +
      "       plutonium.ts open <url|file>…\n" +
      "       plutonium.ts stop-x-displays [--wayland-display <name>]",
  );
  process.exit(2);
}

switch (command) {
  case "daemon": {
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
      cdpPort: Number(values["cdp-port"] ?? process.env.PLUTONIUM_CDP_PORT ?? 0) || undefined,
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
  case "stop-x-displays":
    // The helper keeps them running across its restarts.
    stopXDisplays(xDisplayStatePath(waylandDisplay, socketPath));
    break;
  default:
    usage();
}
