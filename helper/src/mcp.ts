// The agent bridge as an MCP server (stdio, newline-delimited JSON-RPC).
//
// Started by an agent as one of its thread's processes, so it finds its thread
// and the helper in its own environment (PLUTONIUM_THREAD_ID,
// PLUTONIUM_HELPER). The helper only lets it reach that thread's windows.
// This is as strong as the thread tagging itself: a process can copy the
// variables.
import { createInterface } from "node:readline";

import { helperJson, helperRequest } from "./client.ts";
import { HELPER_VARIABLE, THREAD_ID_VARIABLE } from "./threads.ts";

const SERVER_INFO = { name: "plutonium", version: "0.1.0" };
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const windowIdSchema = {
  type: "object",
  properties: { window_id: { type: "integer", description: "A window id from list_windows." } },
  required: ["window_id"],
  additionalProperties: false,
};

const tabIdSchema = {
  type: "object",
  properties: { tab_id: { type: "integer", description: "A tab id from list_tabs or open_tab." } },
  required: ["tab_id"],
  additionalProperties: false,
};

const waitSecondsProperty = {
  type: "number",
  description: "How long to wait for the page to finish loading (default 15, 0 to not wait).",
};

const TOOLS = [
  {
    name: "list_windows",
    description:
      "List the native app windows that belong to this thread (apps you or this thread's terminals started). " +
      "Each has an id, title, app id, size in DIPs, whether the shell is showing it to the user, and whether it has keyboard focus.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "launch_app",
    description:
      "Start a GUI app as part of this thread and wait for its window. The app runs detached from your shell, " +
      "on the Plutonium desktop, and its windows belong to this thread. Its windows wait in the thread (the user is told, " +
      "and can open them) unless focus is true. Returns the new windows (empty if none appeared in time).",
    inputSchema: {
      type: "object",
      properties: {
        argv: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: 'Program and arguments, e.g. ["foot", "-T", "logs"]. No shell is involved.',
        },
        cwd: { type: "string", description: "Working directory (default: your home directory)." },
        wait_seconds: { type: "number", description: "How long to wait for a window (default 10, 0 to not wait)." },
        focus: {
          type: "boolean",
          description:
            "Bring the app's windows to the front (default false). Only when the user asked to see the app, " +
            "since it takes them away from what they're doing.",
        },
      },
      required: ["argv"],
      additionalProperties: false,
    },
  },
  {
    name: "snapshot_window",
    description:
      "Take a screenshot of one of this thread's windows, even if the user isn't looking at it. " +
      "Returns a PNG of the window's contents (no other windows, no desktop).",
    inputSchema: windowIdSchema,
  },
  {
    name: "focus_window",
    description: "Show one of this thread's windows to the user (the shell opens or raises it).",
    inputSchema: windowIdSchema,
  },
  {
    name: "close_window",
    description:
      "Ask one of this thread's windows to close, as its close button would. The app may refuse or ask the user first; " +
      "the result says whether the window went away.",
    inputSchema: windowIdSchema,
  },
  {
    name: "list_tabs",
    description:
      "List the browser tabs that belong to this thread (tabs you opened, and tabs their pages opened). " +
      "Each has an id, URL, title, whether it's loading, whether it can go back or forward, and whether the shell shows it.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "open_tab",
    description:
      "Open a web page in a new browser tab of this thread (a real Chromium tab in the user's browser profile, " +
      "so the user's logins apply). It waits in the thread (the user is told, and can open it) unless focus is true. " +
      "Returns the tab once the page has loaded.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "A URL, or anything an address bar accepts (e.g. example.com)." },
        focus: {
          type: "boolean",
          description: "Bring the tab to the front (default false). Only when the user asked to see the page.",
        },
        wait_seconds: waitSecondsProperty,
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "navigate_tab",
    description: "Load a URL in one of this thread's tabs, as if typed in its address bar.",
    inputSchema: {
      type: "object",
      properties: {
        tab_id: { type: "integer", description: "A tab id from list_tabs or open_tab." },
        url: { type: "string" },
        wait_seconds: waitSecondsProperty,
      },
      required: ["tab_id", "url"],
      additionalProperties: false,
    },
  },
  {
    name: "tab_action",
    description: "Go back, go forward, reload or stop loading in one of this thread's tabs.",
    inputSchema: {
      type: "object",
      properties: {
        tab_id: { type: "integer", description: "A tab id from list_tabs or open_tab." },
        action: { type: "string", enum: ["back", "forward", "reload", "stop"] },
        wait_seconds: waitSecondsProperty,
      },
      required: ["tab_id", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "answer_dialog",
    description:
      "Answer the dialog a tab's page is waiting on (alert, confirm, prompt, or 'leave this page?'); " +
      "list_tabs shows it as the tab's dialog. Pass accept false for Cancel.",
    inputSchema: {
      type: "object",
      properties: {
        tab_id: { type: "integer", description: "A tab id from list_tabs or open_tab." },
        accept: { type: "boolean", description: "OK (true, the default) or Cancel (false)." },
        text: { type: "string", description: "The answer to a prompt() dialog." },
      },
      required: ["tab_id"],
      additionalProperties: false,
    },
  },
  {
    name: "snapshot_tab",
    description:
      "Take a screenshot of one of this thread's browser tabs (the visible part of the page), even if the user isn't looking at it.",
    inputSchema: tabIdSchema,
  },
  {
    name: "focus_tab",
    description: "Show one of this thread's browser tabs to the user.",
    inputSchema: tabIdSchema,
  },
  {
    name: "close_tab",
    description: "Close one of this thread's browser tabs.",
    inputSchema: tabIdSchema,
  },
];

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

async function callTool(name: string, args: Record<string, unknown>): Promise<Content[]> {
  const socket = process.env[HELPER_VARIABLE];
  const threadId = process.env[THREAD_ID_VARIABLE];
  if (!socket || !threadId) {
    throw new Error("This agent isn't running in a Plutonium thread (no PLUTONIUM_THREAD_ID / PLUTONIUM_HELPER).");
  }
  const thread = encodeURIComponent(threadId);
  const text = (value: unknown): Content[] => [{ type: "text", text: JSON.stringify(value, null, 2) }];
  const windowId = () => {
    const id = args.window_id;
    if (typeof id !== "number" || !Number.isInteger(id)) throw new Error("window_id must be an integer.");
    return id;
  };
  const tabId = () => {
    const id = args.tab_id;
    if (typeof id !== "number" || !Number.isInteger(id)) throw new Error("tab_id must be an integer.");
    return id;
  };
  const waitMs = () => (typeof args.wait_seconds === "number" ? Math.max(0, args.wait_seconds * 1000) : 15_000);
  const png = async (path: string): Promise<Content[]> => {
    const response = await helperRequest(socket, "GET", path);
    if (response.status >= 400 || !response.contentType.startsWith("image/png")) {
      const message = (() => {
        try {
          return JSON.parse(response.body.toString("utf8")).error;
        } catch {
          return undefined;
        }
      })();
      throw new Error(message ?? `Snapshot failed (${response.status}).`);
    }
    return [{ type: "image", data: response.body.toString("base64"), mimeType: "image/png" }];
  };
  switch (name) {
    case "list_tabs":
      return text(await helperJson(socket, "GET", `/v1/threads/${thread}/tabs`));
    case "open_tab": {
      if (typeof args.url !== "string" || !args.url) throw new Error("url is required.");
      return text(
        await helperJson(socket, "POST", `/v1/threads/${thread}/tabs`, {
          url: args.url,
          focus: args.focus === true,
          waitMs: waitMs(),
        }),
      );
    }
    case "navigate_tab": {
      if (typeof args.url !== "string" || !args.url) throw new Error("url is required.");
      return text(
        await helperJson(socket, "POST", `/v1/threads/${thread}/tabs/${tabId()}/navigate`, {
          url: args.url,
          waitMs: waitMs(),
        }),
      );
    }
    case "tab_action": {
      const action = String(args.action);
      if (!["back", "forward", "reload", "stop"].includes(action)) {
        throw new Error("action must be back, forward, reload or stop.");
      }
      return text(
        await helperJson(socket, "POST", `/v1/threads/${thread}/tabs/${tabId()}/${action}`, { waitMs: waitMs() }),
      );
    }
    case "answer_dialog":
      return text(
        await helperJson(socket, "POST", `/v1/threads/${thread}/tabs/${tabId()}/dialog`, {
          accept: args.accept !== false,
          text: typeof args.text === "string" ? args.text : "",
        }),
      );
    case "snapshot_tab":
      return png(`/v1/threads/${thread}/tabs/${tabId()}/snapshot`);
    case "focus_tab":
      return text(await helperJson(socket, "POST", `/v1/threads/${thread}/tabs/${tabId()}/focus`));
    case "close_tab":
      return text(await helperJson(socket, "POST", `/v1/threads/${thread}/tabs/${tabId()}/close`));
    case "list_windows":
      return text(await helperJson(socket, "GET", `/v1/threads/${thread}/windows`));
    case "launch_app": {
      const argv = args.argv;
      if (!Array.isArray(argv) || argv.length === 0 || !argv.every((arg) => typeof arg === "string")) {
        throw new Error("argv must be a non-empty array of strings.");
      }
      const waitSeconds = typeof args.wait_seconds === "number" ? args.wait_seconds : 10;
      return text(
        await helperJson(socket, "POST", "/v1/launch", {
          thread: threadId,
          argv,
          cwd: typeof args.cwd === "string" ? args.cwd : undefined,
          waitMs: Math.max(0, waitSeconds * 1000),
          show: args.focus === true,
        }),
      );
    }
    case "snapshot_window": {
      const id = windowId();
      const response = await helperRequest(socket, "GET", `/v1/threads/${thread}/windows/${id}/snapshot`);
      if (response.status >= 400 || !response.contentType.startsWith("image/png")) {
        const message = (() => {
          try {
            return JSON.parse(response.body.toString("utf8")).error;
          } catch {
            return undefined;
          }
        })();
        throw new Error(message ?? `Snapshot failed (${response.status}).`);
      }
      return [{ type: "image", data: response.body.toString("base64"), mimeType: "image/png" }];
    }
    case "focus_window":
      return text(await helperJson(socket, "POST", `/v1/threads/${thread}/windows/${windowId()}/focus`));
    case "close_window":
      return text(await helperJson(socket, "POST", `/v1/threads/${thread}/windows/${windowId()}/close`));
    default:
      throw new Error(`Unknown tool ${name}.`);
  }
}

interface JsonRpcMessage {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message: JsonRpcMessage): Promise<unknown> {
  switch (message.method) {
    case "initialize": {
      const requested = message.params?.protocolVersion;
      return {
        protocolVersion:
          typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          "Native app windows and browser tabs of this chat thread on the Plutonium desktop. Use launch_app to open GUI apps, " +
          "snapshot_window to see them, focus_window to show one to the user and close_window to close it. " +
          "Use open_tab to open web pages in real browser tabs, snapshot_tab to see them, and navigate_tab, " +
          "tab_action, focus_tab and close_tab to drive them. What you open waits in the thread without interrupting " +
          "the user; pass focus: true (or run a command as PLUTONIUM_SHOW=1 <command>) only when they asked to see it.",
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const name = String(message.params?.name ?? "");
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        return { content: await callTool(name, args) };
      } catch (error) {
        return { content: [{ type: "text", text: (error as Error).message }], isError: true };
      }
    }
    default:
      throw Object.assign(new Error(`Method not found: ${message.method}`), { code: -32601 });
  }
}

export function runMcpServer(): void {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    // Notifications (no id) need no answer.
    if (message.id === undefined || message.id === null) return;
    handle(message).then(
      (result) => send({ jsonrpc: "2.0", id: message.id, result }),
      (error: Error & { code?: number }) =>
        send({ jsonrpc: "2.0", id: message.id, error: { code: error.code ?? -32603, message: error.message } }),
    );
  });
  lines.once("close", () => process.exit(0));
}
