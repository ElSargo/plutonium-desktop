// Turns a tester thread's Claude transcript (JSONL) into a timeline a reviewer
// can read: what the agent said, each tool call with its input, how long it
// took and what came back. Images in tool results (window snapshots, page
// screenshots) are written out, so the reviewer sees what the agent saw.
//
//   node timeline.ts <transcript.jsonl> <out-dir>
//
// Writes <out-dir>/timeline.txt, <out-dir>/tools.json (per-tool counts) and
// <out-dir>/seen/<n>-<tool>.<ext>.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [transcript, outDir] = process.argv.slice(2);
if (!transcript || !outDir) {
  console.error("usage: timeline.ts <transcript.jsonl> <out-dir>");
  process.exit(2);
}
const entries = readFileSync(transcript, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((e) => (e.type === "assistant" || e.type === "user") && !e.isSidechain);

const cut = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};
const shortName = (name: string) => name.replace(/^mcp__[^_]+(?:-[^_]+)*__/, "");
const start = entries.length ? Date.parse(entries[0].timestamp) : 0;
const clock = (ts: string) => {
  const t = Date.parse(ts);
  return `${new Date(t).toISOString().slice(11, 22)} +${((t - start) / 1000).toFixed(1).padStart(6)}s`;
};

mkdirSync(join(outDir, "seen"), { recursive: true });
const calls = new Map<string, { name: string; at: number; line: number }>();
const stats: Record<string, { calls: number; errors: number; totalMs: number }> = {};
const lines: string[] = [];
let images = 0;

for (const entry of entries) {
  const content = typeof entry.message?.content === "string" ? [{ type: "text", text: entry.message.content }] : entry.message?.content ?? [];
  for (const block of content) {
    if (entry.type === "assistant" && block.type === "text" && block.text.trim()) {
      lines.push(`${clock(entry.timestamp)}  SAY   ${cut(block.text, 400)}`);
    } else if (entry.type === "assistant" && block.type === "tool_use") {
      const name = shortName(block.name);
      calls.set(block.id, { name, at: Date.parse(entry.timestamp), line: lines.length });
      lines.push(`${clock(entry.timestamp)}  CALL  ${name} ${cut(JSON.stringify(block.input), 600)}`);
    } else if (entry.type === "user" && block.type === "text" && block.text.trim() && !entry.isMeta) {
      lines.push(`${clock(entry.timestamp)}  USER  ${cut(block.text, 1000)}`);
    } else if (entry.type === "user" && block.type === "tool_result") {
      const call = calls.get(block.tool_use_id);
      const name = call?.name ?? "?";
      const ms = call ? Date.parse(entry.timestamp) - call.at : 0;
      const parts = typeof block.content === "string" ? [{ type: "text", text: block.content }] : block.content ?? [];
      const text = parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join(" ");
      const seen: string[] = [];
      for (const part of parts) {
        if (part.type !== "image" || part.source?.type !== "base64") continue;
        const ext = (part.source.media_type ?? "image/png").split("/")[1];
        const file = `seen/${String(++images).padStart(3, "0")}-${name}.${ext}`;
        writeFileSync(join(outDir, file), Buffer.from(part.source.data, "base64"));
        seen.push(file);
      }
      const s = (stats[name] ??= { calls: 0, errors: 0, totalMs: 0 });
      s.calls++;
      s.totalMs += ms;
      if (block.is_error) s.errors++;
      const status = block.is_error ? "ERROR" : "ok";
      lines.push(
        `${clock(entry.timestamp)}  ${block.is_error ? "FAIL" : "RES "}  ${name} ${status} ${(ms / 1000).toFixed(1)}s ${cut(text, block.is_error ? 1200 : 400)}${seen.length ? ` [images: ${seen.join(", ")}]` : ""}`,
      );
    }
  }
}

writeFileSync(join(outDir, "timeline.txt"), lines.join("\n") + "\n");
writeFileSync(join(outDir, "tools.json"), JSON.stringify(stats, null, 2) + "\n");
const errors = Object.values(stats).reduce((n, s) => n + s.errors, 0);
const total = Object.values(stats).reduce((n, s) => n + s.calls, 0);
console.log(`${total} tool calls, ${errors} errors, ${images} images; ${join(outDir, "timeline.txt")}`);
