// Calls one tool of a T3 Code server's MCP endpoint, as an outside MCP client.
//
//   node t3mcp.ts <port> <token-file> <tool> [<json arguments>]
//   node t3mcp.ts <port> <token-file> --list
//
// The token is an `mcp-client` session (run.sh issues one with
// `t3 auth session issue --subject mcp-client --runtime-mode-ceiling full-access`).
// Prints the tool's structured result as JSON (its text if it has none) and
// exits 1 when the tool reports an error.
import { readFileSync } from "node:fs";

const [port, tokenFile, tool, args = "{}"] = process.argv.slice(2);
if (!port || !tokenFile || !tool) {
  console.error("usage: t3mcp.ts <port> <token-file> <tool>|--list [<json arguments>]");
  process.exit(2);
}
const url = `http://127.0.0.1:${port}/mcp`;
const token = readFileSync(tokenFile, "utf8").trim();
let sessionId: string | null = null;
let nextId = 1;

async function rpc(method: string, params?: unknown, notification = false): Promise<any> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const body = { jsonrpc: "2.0", method, ...(params ? { params } : {}), ...(notification ? {} : { id: nextId++ }) };
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  sessionId = response.headers.get("mcp-session-id") ?? sessionId;
  if (notification) return null;
  const text = await response.text();
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}: ${text.slice(0, 500)}`);
  // Streamable HTTP answers with JSON or with an event stream of JSON messages.
  const json = (response.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((m) => "id" in m)
    : JSON.parse(text);
  if (json?.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json?.result;
}

try {
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "plutonium-agent-tests", version: "1" },
  });
  await rpc("notifications/initialized", undefined, true);
  if (tool === "--list") {
    const result = await rpc("tools/list");
    for (const t of result.tools) console.log(t.name);
  } else {
    const result = await rpc("tools/call", { name: tool, arguments: JSON.parse(args) });
    const text = (result.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    console.log(result.structuredContent ? JSON.stringify(result.structuredContent) : text);
    if (result.isError) process.exit(1);
  }
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
}
