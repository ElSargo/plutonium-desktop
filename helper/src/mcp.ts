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

const pointProperties = {
  window_id: { type: "integer", description: "A window id from list_windows." },
  x: { type: "number", description: "Pixels from the left of snapshot_window's image." },
  y: { type: "number", description: "Pixels from the top of snapshot_window's image." },
};

const elementProperties = {
  tab_id: { type: "integer", description: "A tab id from list_tabs or open_tab." },
  ref: { type: "string", description: 'An element\'s ref from read_tab (e.g. "e12").' },
  selector: { type: "string", description: "Or a Playwright selector (CSS, text=…, role=…), when there is no ref." },
};

const timeoutProperty = { type: "number", description: "Seconds to wait for the element (default 10)." };

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
      "Returns a PNG of the window's contents (no other windows, no desktop). Points for click_window and the " +
      "other window tools are in this image's pixels.",
    inputSchema: windowIdSchema,
  },
  {
    name: "click_window",
    description:
      "Click in one of this thread's windows at a point of its snapshot_window image. The app gets the click " +
      "even if the user isn't looking at it, and the user's own pointer and keyboard stay where they are. " +
      "Take a new snapshot to see what happened.",
    inputSchema: {
      type: "object",
      properties: {
        ...pointProperties,
        button: { type: "string", enum: ["left", "right", "middle"], description: "Default left." },
        count: { type: "integer", enum: [1, 2, 3], description: "2 for a double click (default 1)." },
      },
      required: ["window_id", "x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "hover_window",
    description: "Move the pointer to a point in one of this thread's windows (for tooltips and hover menus).",
    inputSchema: {
      type: "object",
      properties: pointProperties,
      required: ["window_id", "x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "drag_window",
    description: "Press at one point of one of this thread's windows, move to another and release there.",
    inputSchema: {
      type: "object",
      properties: {
        window_id: pointProperties.window_id,
        from: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "[x, y]" },
        to: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "[x, y]" },
        button: { type: "string", enum: ["left", "right", "middle"], description: "Default left." },
      },
      required: ["window_id", "from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "scroll_window",
    description: "Turn the mouse wheel over a point in one of this thread's windows.",
    inputSchema: {
      type: "object",
      properties: {
        ...pointProperties,
        dy: { type: "number", description: "Wheel notches down (negative: up)." },
        dx: { type: "number", description: "Wheel notches right (negative: left)." },
      },
      required: ["window_id", "x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "type_window",
    description:
      "Type text into one of this thread's windows, as from a keyboard (into whatever in the window has the " +
      "keyboard: click a field first). The window gets the keys even if the user is typing elsewhere; their " +
      "keyboard stays where it is. Keys are a US keyboard's: other characters are refused. \n presses Enter; " +
      "after an Enter that should move the focus (a toolbar box, a dialog field), click where the next text goes.",
    inputSchema: {
      type: "object",
      properties: { window_id: pointProperties.window_id, text: { type: "string" } },
      required: ["window_id", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "press_window",
    description:
      'Press keys in one of this thread\'s windows: "Enter", "Escape", "ctrl+s", "ctrl+shift+t", "alt+F4", ' +
      '"Down", "ctrl+]", or a list of them pressed in turn.',
    inputSchema: {
      type: "object",
      properties: {
        window_id: pointProperties.window_id,
        keys: {
          anyOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1 }],
          description: "A key combination, or a list of them.",
        },
      },
      required: ["window_id", "keys"],
      additionalProperties: false,
    },
  },
  {
    name: "resize_window",
    description:
      "Ask the app to resize one of this thread's windows (DIPs, as list_windows gives sizes). Only while the " +
      "shell isn't showing it: then the shell decides its size.",
    inputSchema: {
      type: "object",
      properties: {
        window_id: pointProperties.window_id,
        width: { type: "integer", minimum: 1 },
        height: { type: "integer", minimum: 1 },
      },
      required: ["window_id", "width", "height"],
      additionalProperties: false,
    },
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
    name: "read_tab",
    description:
      "Read the page in one of this thread's tabs as an accessibility tree (YAML): roles, names, text, and a ref " +
      'for each element ("[ref=e12]") that click_tab, type_tab and the other tab tools take. Read again after ' +
      "the page changes: refs are only good for the snapshot they came from.",
    inputSchema: {
      type: "object",
      properties: { tab_id: elementProperties.tab_id },
      required: ["tab_id"],
      additionalProperties: false,
    },
  },
  {
    name: "click_tab",
    description:
      "Click an element of the page in one of this thread's tabs (Playwright: it waits for the element to be " +
      "visible and stable, and scrolls it into view).",
    inputSchema: {
      type: "object",
      properties: {
        ...elementProperties,
        button: { type: "string", enum: ["left", "right", "middle"] },
        double: { type: "boolean", description: "Double click." },
        timeout_seconds: timeoutProperty,
      },
      required: ["tab_id"],
      additionalProperties: false,
    },
  },
  {
    name: "type_tab",
    description:
      "Type into a field of the page in one of this thread's tabs. Replaces what the field holds, unless " +
      "slowly is true (then it presses each key, for fields that react to typing).",
    inputSchema: {
      type: "object",
      properties: {
        ...elementProperties,
        text: { type: "string" },
        submit: { type: "boolean", description: "Press Enter afterwards." },
        slowly: { type: "boolean" },
        timeout_seconds: timeoutProperty,
      },
      required: ["tab_id", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "press_tab",
    description:
      'Press a key in the page of one of this thread\'s tabs (where its focus is): "Enter", "Escape", ' +
      '"ArrowDown", "Control+a", "Shift+Tab".',
    inputSchema: {
      type: "object",
      properties: { tab_id: elementProperties.tab_id, key: { type: "string" } },
      required: ["tab_id", "key"],
      additionalProperties: false,
    },
  },
  {
    name: "hover_tab",
    description: "Move the pointer over an element of the page in one of this thread's tabs.",
    inputSchema: {
      type: "object",
      properties: { ...elementProperties, timeout_seconds: timeoutProperty },
      required: ["tab_id"],
      additionalProperties: false,
    },
  },
  {
    name: "select_tab",
    description: "Choose options in a <select> of the page in one of this thread's tabs (by value or label).",
    inputSchema: {
      type: "object",
      properties: {
        ...elementProperties,
        values: { type: "array", items: { type: "string" }, minItems: 1 },
        timeout_seconds: timeoutProperty,
      },
      required: ["tab_id", "values"],
      additionalProperties: false,
    },
  },
  {
    name: "scroll_tab",
    description: "Scroll the page in one of this thread's tabs, by CSS pixels (over an element, if given).",
    inputSchema: {
      type: "object",
      properties: {
        ...elementProperties,
        dy: { type: "number", description: "Pixels down (negative: up)." },
        dx: { type: "number", description: "Pixels right (negative: left)." },
      },
      required: ["tab_id"],
      additionalProperties: false,
    },
  },
  {
    name: "evaluate_tab",
    description:
      "Run JavaScript in the page of one of this thread's tabs and return its (JSON) result: an expression, " +
      'or a function ("() => document.title"; with ref or selector, it gets the element: "(el) => el.value").',
    inputSchema: {
      type: "object",
      properties: { ...elementProperties, expression: { type: "string" }, timeout_seconds: timeoutProperty },
      required: ["tab_id", "expression"],
      additionalProperties: false,
    },
  },
  {
    name: "wait_for_tab",
    description:
      "Wait until text appears (text) or goes (text_gone), or an element appears (selector), in the page of " +
      "one of this thread's tabs; with none of these, until it has loaded.",
    inputSchema: {
      type: "object",
      properties: {
        tab_id: elementProperties.tab_id,
        text: { type: "string" },
        text_gone: { type: "string" },
        selector: { type: "string" },
        timeout_seconds: timeoutProperty,
      },
      required: ["tab_id"],
      additionalProperties: false,
    },
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

/**
 * The native window tools: what a frontend that drives tabs its own way
 * (T3 Code, with its preview tools) offers its agents, through the helper
 * (GET /v1/mcp/tools?set=windows, POST /v1/threads/:thread/mcp/call).
 */
export const WINDOW_TOOLS = new Set([
  "list_windows",
  "launch_app",
  "snapshot_window",
  "click_window",
  "hover_window",
  "drag_window",
  "scroll_window",
  "type_window",
  "press_window",
  "resize_window",
  "focus_window",
  "close_window",
]);

/** The tools of `set` ("windows": WINDOW_TOOLS), or all of them. */
export function mcpTools(set?: string): readonly (typeof TOOLS)[number][] {
  return set === "windows" ? TOOLS.filter((tool) => WINDOW_TOOLS.has(tool.name)) : TOOLS;
}

export type McpContent = Content;

/** Runs tool `name` for thread `threadId`, through the helper on `socket`. */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  socket: string,
  threadId: string,
): Promise<Content[]> {
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
  const windowInput = async (body: Record<string, unknown>) =>
    text(await helperJson(socket, "POST", `/v1/threads/${thread}/windows/${windowId()}/input`, body));
  const pageAction = async (action: string, keys: readonly string[]) => {
    const body: Record<string, unknown> = { action };
    for (const key of keys) if (args[key] !== undefined) body[key] = args[key];
    if (typeof args.timeout_seconds === "number") body.timeoutMs = Math.max(0, args.timeout_seconds * 1000);
    const result = await helperJson(socket, "POST", `/v1/threads/${thread}/tabs/${tabId()}/page`, body);
    // The snapshot reads better as it is.
    if (action === "snapshot" && result && typeof result === "object" && "snapshot" in result) {
      const { url, title, snapshot } = result as { url: string; title: string; snapshot: string };
      return [{ type: "text", text: `${title}\n${url}\n\n${snapshot}` }] as Content[];
    }
    return text(result);
  };
  const element = ["ref", "selector"];
  switch (name) {
    case "click_window":
      return windowInput({ action: "click", x: args.x, y: args.y, button: args.button, count: args.count });
    case "hover_window":
      return windowInput({ action: "move", x: args.x, y: args.y });
    case "drag_window":
      return windowInput({ action: "drag", from: args.from, to: args.to, button: args.button });
    case "scroll_window":
      return windowInput({ action: "scroll", x: args.x, y: args.y, dx: args.dx, dy: args.dy });
    case "type_window":
      return windowInput({ action: "type", text: args.text });
    case "press_window":
      return windowInput({ action: "press", keys: args.keys });
    case "resize_window":
      return windowInput({ action: "resize", width: args.width, height: args.height });
    case "read_tab":
      return pageAction("snapshot", []);
    case "click_tab":
      return pageAction("click", [...element, "button", "double"]);
    case "type_tab":
      return pageAction("type", [...element, "text", "submit", "slowly"]);
    case "press_tab":
      return pageAction("press", ["key"]);
    case "hover_tab":
      return pageAction("hover", element);
    case "select_tab":
      return pageAction("select", [...element, "values"]);
    case "scroll_tab":
      return pageAction("scroll", [...element, "dx", "dy"]);
    case "evaluate_tab":
      return pageAction("evaluate", [...element, "expression"]);
    case "wait_for_tab":
      return pageAction("wait_for", ["text", "text_gone", "selector"]);
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
          "snapshot_window to see them, click_window, type_window, press_window, scroll_window and drag_window to use " +
          "them (points are snapshot_window's pixels), focus_window to show one to the user and close_window to close it. " +
          "Use open_tab to open web pages in real browser tabs (the user's browser profile), read_tab to read a page " +
          "with element refs, click_tab, type_tab, press_tab, select_tab and evaluate_tab to use it, snapshot_tab to " +
          "see it, and navigate_tab, tab_action, focus_tab and close_tab. You work in the background: the user's own " +
          "pointer and keyboard aren't moved. What you open waits in the thread without interrupting the user; pass " +
          "focus: true (or run a command as PLUTONIUM_SHOW=1 <command>) only when they asked to see it.",
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const name = String(message.params?.name ?? "");
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      const socket = process.env[HELPER_VARIABLE];
      const threadId = process.env[THREAD_ID_VARIABLE];
      try {
        if (!socket || !threadId) {
          throw new Error(
            "This agent isn't running in a Plutonium thread (no PLUTONIUM_THREAD_ID / PLUTONIUM_HELPER).",
          );
        }
        return { content: await callTool(name, args, socket, threadId) };
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
