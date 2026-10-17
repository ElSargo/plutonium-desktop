#!/usr/bin/env node
// Plutonium helper CLI (Node 24+, no dependencies).
//
//   plutonium.ts daemon [--wayland-display wayland-plutonium] --shell-origin http://127.0.0.1:3774[,<origin>…] [--port 3780]
//   plutonium.ts thread-setup <thread-id>   JSON {env, mcpServer} for a thread's processes
//   plutonium.ts launch <thread-id> <argv>…  start an app in a thread
//   plutonium.ts mcp                        the agent bridge as a stdio MCP server
//   plutonium.ts open <url|file>…           xdg-open for a thread's apps: web links
//                                           become tabs in $PLUTONIUM_THREAD_ID
//
// Clients find the daemon's socket in $PLUTONIUM_HELPER (set in every thread
// process), else from --wayland-display / $PLUTONIUM_WAYLAND_DISPLAY.
import { parseArgs } from "node:util";

import { helperJson } from "./src/client.ts";
import { Daemon, defaultSocketPath } from "./src/daemon.ts";
import { runMcpServer } from "./src/mcp.ts";
import { runOpen } from "./src/opener.ts";
import { HELPER_VARIABLE } from "./src/threads.ts";

const [command, ...rest] = process.argv.slice(2);
// An app's own arguments (after `launch <thread-id>`) aren't ours to parse.
const ownArgs = command === "launch" || command === "open" ? [] : rest;
const { values, positionals } = parseArgs({
  args: ownArgs,
  allowPositionals: true,
  options: {
    "wayland-display": { type: "string" },
    "shell-origin": { type: "string" },
    port: { type: "string" },
    socket: { type: "string" },
  },
});

const waylandDisplay = values["wayland-display"] ?? process.env.PLUTONIUM_WAYLAND_DISPLAY ?? "wayland-plutonium";
const socketPath = values.socket ?? process.env[HELPER_VARIABLE] ?? defaultSocketPath(waylandDisplay);

function usage(): never {
  console.error(
    "usage: plutonium.ts daemon --shell-origin <origin>[,<origin>…] [--wayland-display <name>] [--port <n>]\n" +
      "       plutonium.ts thread-setup <thread-id>\n" +
      "       plutonium.ts launch <thread-id> <program> [args…]\n" +
      "       plutonium.ts mcp\n" +
      "       plutonium.ts open <url|file>…",
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
    const daemon = new Daemon({
      waylandDisplay,
      shellOrigins,
      port: Number(values.port ?? process.env.PLUTONIUM_HELPER_PORT ?? 3780),
      socketPath,
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
      JSON.stringify(await helperJson(socketPath, "POST", "/v1/launch", { thread: threadId, argv, waitMs: 10_000 })),
    );
    break;
  }
  case "mcp":
    runMcpServer();
    break;
  case "open":
    process.exitCode = await runOpen(rest, socketPath);
    break;
  default:
    usage();
}
