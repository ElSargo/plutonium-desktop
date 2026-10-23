// The helper end to end: a daemon, a fake shell page connected to it as the
// browser's shell would be, and an agent's MCP server (plutonium.ts mcp) in
// one thread. Checks that the agent reaches its own thread's windows and no
// others, through the relay, and the accessibility tools through a fake bus.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request, type IncomingMessage } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { helperJson, helperRequest } from "../src/client.ts";
import { Daemon } from "../src/daemon.ts";
import type { NativeWindowEntry } from "../src/relay.ts";
import { FakeBus, STATE } from "./fixtures/fakeBus.ts";

const CLI = fileURLToPath(new URL("../plutonium.ts", import.meta.url));
const SHELL_ORIGIN = "http://shell.test";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function windowEntry(id: number, title: string, pid: number, tags?: string[]): NativeWindowEntry {
  return {
    id,
    appId: `app-${id}`,
    title,
    width: 400,
    height: 300,
    deviceScaleFactor: 1,
    embedded: false,
    focused: false,
    pid,
    ...(tags ? { tag: tags[0] ?? "", tags } : {}),
  };
}

/** A shell page: answers the helper's requests over its EventSource stream. */
class FakeShell {
  readonly ops: { op: string; args: Record<string, unknown> }[] = [];
  windows: NativeWindowEntry[] = [];
  private stream: IncomingMessage | undefined;
  private readonly port: number;
  constructor(port: number) {
    this.port = port;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: this.port,
          path: "/v1/shell/requests?page=page-1&shell=shell-1&visible=1",
          headers: { Origin: SHELL_ORIGIN },
        },
        (response) => {
          if (response.statusCode !== 200) return reject(new Error(`stream: ${response.statusCode}`));
          this.stream = response;
          const lines = createInterface({ input: response });
          lines.on("line", (line) => {
            if (line.startsWith("data: ")) void this.onEvent(JSON.parse(line.slice(6)));
          });
          resolve();
        },
      );
      req.once("error", reject);
      req.end();
    });
  }

  close(): void {
    this.stream?.destroy();
  }

  private async onEvent(event: { id?: string; op: string; args: Record<string, unknown> }): Promise<void> {
    if (event.id === undefined) return;
    this.ops.push({ op: event.op, args: event.args });
    switch (event.op) {
      case "windows":
        return this.reply(event.id, { ok: true, value: this.windows });
      case "tabs":
        return this.reply(event.id, { ok: true, value: [] });
      case "groups":
        return this.reply(event.id, { ok: true, value: [{ tag: "t-a", label: "Thread A", shellId: "shell-1" }] });
      case "focus":
        return this.reply(event.id, { ok: true, value: { how: "tab" } });
      case "close":
        this.windows = this.windows.filter((window) => window.id !== event.args.windowId);
        return this.reply(event.id, { ok: true, value: null });
      case "snapshot":
        return this.send(event.id, "image/png", PNG);
      default:
        return this.reply(event.id, { ok: false, error: `Unknown op ${event.op}` });
    }
  }

  private reply(id: string, value: unknown): Promise<void> {
    return this.send(id, "application/json", Buffer.from(JSON.stringify(value)));
  }

  private send(id: string, contentType: string, body: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: this.port,
          method: "POST",
          path: `/v1/shell/replies/${id}`,
          headers: { Origin: SHELL_ORIGIN, "Content-Type": contentType, "Content-Length": body.length },
        },
        (response) => {
          response.resume();
          response.once("end", resolve);
        },
      );
      req.once("error", reject);
      req.end(body);
    });
  }
}

/** An agent's MCP server, as its frontend starts it in a thread. */
class McpClient {
  private readonly child: ChildProcess;
  private readonly waiting = new Map<number, (message: Record<string, unknown>) => void>();
  private nextId = 1;
  constructor(socketPath: string, threadId: string) {
    this.child = spawn(process.execPath, [CLI, "mcp"], {
      env: { ...process.env, PLUTONIUM_HELPER: socketPath, PLUTONIUM_THREAD_ID: threadId },
      stdio: ["pipe", "pipe", "inherit"],
    });
    createInterface({ input: this.child.stdout! }).on("line", (line) => {
      const message = JSON.parse(line) as { id: number };
      this.waiting.get(message.id)?.(message);
      this.waiting.delete(message.id);
    });
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  /** A tool's result: its content, and whether it is an error. */
  async call(name: string, args: Record<string, unknown> = {}) {
    const { result } = (await this.request("tools/call", { name, arguments: args })) as {
      result: { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean };
    };
    return result;
  }

  async close(): Promise<void> {
    const exited = new Promise((resolve) => this.child.once("exit", resolve));
    this.child.stdin!.end();
    await exited;
  }
}

describe("helper end to end", () => {
  let dir: string;
  let socketPath: string;
  let daemon: Daemon;
  let shell: FakeShell;
  let agent: McpClient;
  let bus: FakeBus;
  let tagged: ChildProcess;
  const save = { role: "push button", name: "Save", states: [STATE.showing, STATE.enabled], actions: ["click"], log: [] as string[] };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "plutonium-e2e-"));
    socketPath = join(dir, "helper.sock");
    bus = await FakeBus.start();
    bus.addApp(4242, [{ role: "frame", name: "Editor", states: [STATE.showing, STATE.active], children: [save] }]);
    process.env.DBUS_SESSION_BUS_ADDRESS = bus.address;
    const port = await freePort();
    daemon = new Daemon({
      waylandDisplay: "wayland-plutonium-e2e",
      shellOrigins: [SHELL_ORIGIN],
      port,
      socketPath,
      // No X servers here.
      xDisplays: { statePath: join(dir, "x-displays.json"), satellite: "" },
    });
    await daemon.start();
    // A process thread A started, whose window an older browser reports untagged.
    tagged = spawn("sleep", ["60"], { env: { PATH: process.env.PATH, PLUTONIUM_THREAD_ID: "t-a" }, stdio: "ignore" });
    await new Promise((resolve) => tagged.once("spawn", resolve));
    shell = new FakeShell(port);
    shell.windows = [
      windowEntry(1, "Editor", 4242, ["t-a"]),
      windowEntry(2, "Thread B's", 4343, ["t-b"]),
      // Thread B's window a shell added to thread A.
      windowEntry(3, "Shared", 4444, ["t-b", "t-a"]),
      windowEntry(4, "Untagged", tagged.pid!),
    ];
    await shell.connect();
    agent = new McpClient(socketPath, "t-a");
  });

  after(async () => {
    await agent?.close();
    shell?.close();
    tagged?.kill();
    daemon?.stop();
    await bus?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the helper sees the shell", async () => {
    const status = await helperJson<{ shellConnected: boolean; shells: { shellId: string }[] }>(socketPath, "GET", "/v1/status");
    assert.equal(status.shellConnected, true);
    assert.deepEqual(
      status.shells.map((entry) => entry.shellId),
      ["shell-1"],
    );
  });

  test("only shells may use the shell API", async () => {
    const port = (daemon as unknown as { options: { port: number } }).options.port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path: "/v1/shell/requests?page=evil", headers: { Origin: "http://evil.test" } },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      req.once("error", reject);
      req.end();
    });
    assert.equal(status, 403);
  });

  test("the MCP server initializes and lists its tools", async () => {
    const init = (await agent.request("initialize", { protocolVersion: "2025-06-18" })) as {
      result: { protocolVersion: string; capabilities: unknown };
    };
    assert.equal(init.result.protocolVersion, "2025-06-18");
    const { result } = (await agent.request("tools/list")) as { result: { tools: { name: string }[] } };
    const names = result.tools.map((tool) => tool.name);
    for (const name of ["list_windows", "launch_app", "snapshot_window", "focus_window", "close_window", "read_window", "act_window"]) {
      assert.ok(names.includes(name), name);
    }
    const unknown = (await agent.request("no/such")) as { error: { code: number } };
    assert.equal(unknown.error.code, -32601);
  });

  test("an agent lists its own thread's windows only", async () => {
    const result = await agent.call("list_windows");
    assert.equal(result.isError, undefined);
    const windows = JSON.parse(result.content[0]!.text!) as { id: number; title: string }[];
    // Its own, the one added to it, and the untagged one its process opened.
    assert.deepEqual(
      windows.map((window) => window.id),
      [1, 3, 4],
    );
  });

  test("another thread's windows are out of reach", async () => {
    const before = shell.ops.length;
    for (const tool of ["focus_window", "close_window", "snapshot_window", "read_window"]) {
      const result = await agent.call(tool, { window_id: 2 });
      assert.equal(result.isError, true, tool);
      assert.match(result.content[0]!.text!, /no window 2/, tool);
    }
    // The shell was only asked which windows there are.
    assert.deepEqual(
      [...new Set(shell.ops.slice(before).map((entry) => entry.op))].filter((op) => op !== "groups"),
      ["windows"],
    );
  });

  test("an agent focuses and snapshots its windows through the shell", async () => {
    const focus = await agent.call("focus_window", { window_id: 1 });
    assert.equal(focus.isError, undefined, focus.content[0]?.text);
    assert.deepEqual(shell.ops.findLast((entry) => entry.op === "focus")?.args, { windowId: 1, threadId: "t-a" });
    const snapshot = await agent.call("snapshot_window", { window_id: 3 });
    assert.equal(snapshot.content[0]?.type, "image");
    assert.equal(snapshot.content[0]?.mimeType, "image/png");
    assert.deepEqual(Buffer.from(snapshot.content[0]!.data!, "base64"), PNG);
  });

  test("read_window and act_window go through the accessibility bus", async () => {
    const read = await agent.call("read_window", { window_id: 1 });
    assert.equal(read.isError, undefined, read.content[0]?.text);
    const outline = read.content[0]!.text!;
    assert.match(outline, /^- frame "Editor" \[ref=a1\]/);
    const ref = outline.match(/push button "Save" \[ref=(a\d+)\]/)?.[1];
    assert.ok(ref, outline);
    const act = await agent.call("act_window", { window_id: 1, ref, action: "click" });
    assert.equal(act.isError, undefined, act.content[0]?.text);
    assert.deepEqual(save.log, ["DoAction click"]);
    // A window whose app isn't on the bus says what to use instead.
    const missing = await agent.call("read_window", { window_id: 3 });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0]!.text!, /snapshot_window/);
  });

  test("an agent closes its window", async () => {
    const result = await agent.call("close_window", { window_id: 4 });
    assert.deepEqual(JSON.parse(result.content[0]!.text!), { closed: true });
    assert.ok(!shell.windows.some((window) => window.id === 4));
  });

  test("an agent finds apps, and a program not on PATH points it to find_apps", async () => {
    const found = await agent.call("find_apps", { filter: "^sh$" });
    assert.equal(found.isError, undefined, found.content[0]?.text);
    const { apps, onPath } = JSON.parse(found.content[0]!.text!);
    assert.ok(Array.isArray(apps));
    assert.deepEqual(onPath, ["sh"]);
    const missing = await agent.call("launch_app", { argv: ["plutonium-no-such-app", "--calc"], wait_seconds: 0 });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0]!.text!, /^plutonium-no-such-app isn't on PATH; find_apps lists installed apps/);
    const badCwd = await agent.call("launch_app", { argv: ["sh"], cwd: join(dir, "nowhere"), wait_seconds: 0 });
    assert.match(badCwd.content[0]!.text!, /working directory .*nowhere doesn't exist/);
  });

  test("launched apps get the thread environment, Electron's on Wayland", async () => {
    const out = join(dir, "env.txt");
    const { pid } = await helperJson<{ pid: number }>(socketPath, "POST", "/v1/launch", {
      thread: "t-a",
      argv: ["sh", "-c", `env > ${out}`],
    });
    assert.ok(pid > 0);
    const deadline = Date.now() + 5_000;
    while (!existsSync(out) || !readFileSync(out, "utf8").includes("\n")) {
      if (Date.now() > deadline) throw new Error("no env.txt");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const environment = new Map(
      readFileSync(out, "utf8")
        .trim()
        .split("\n")
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const),
    );
    assert.equal(environment.get("PLUTONIUM_THREAD_ID"), "t-a");
    assert.equal(environment.get("PLUTONIUM_HELPER"), socketPath);
    assert.equal(environment.get("WAYLAND_DISPLAY"), "wayland-plutonium-e2e");
    assert.equal(environment.get("ELECTRON_OZONE_PLATFORM_HINT"), "wayland");
    assert.equal(environment.get("XDG_SESSION_TYPE"), "wayland");
    // Agents' launches aren't shown unless asked.
    assert.equal(environment.get("PLUTONIUM_SHOW"), undefined);
  });

  test("an app that blanks its environment still resolves to its thread", async () => {
    // `env -i` execs in the launched process itself: its /proc environ is
    // empty, as Electron 43's is once it sets its process title.
    const { pid } = await helperJson<{ pid: number }>(socketPath, "POST", "/v1/launch", {
      thread: "t-a",
      argv: ["env", "-i", "sleep", "30"],
      show: true,
    });
    try {
      const deadline = Date.now() + 5_000;
      while (!readFileSync(`/proc/${pid}/cmdline`, "latin1").startsWith("sleep")) {
        if (Date.now() > deadline) throw new Error("sleep didn't start");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(readFileSync(`/proc/${pid}/environ`, "latin1"), "");
      const threads = await helperJson<Record<string, string>>(socketPath, "GET", `/v1/window-threads?pids=${pid}`);
      assert.deepEqual(threads, { [pid]: "t-a" });
      const shows = await helperJson<Record<string, boolean>>(socketPath, "GET", `/v1/window-shows?pids=${pid}`);
      assert.deepEqual(shows, { [pid]: true });
    } finally {
      process.kill(pid);
    }
  });

  test("a window the browser couldn't tag goes to the thread that launched its client", async () => {
    // As a Flatpak's: the browser can't read the sandboxed client's
    // environment and reports no tags; the helper started its process.
    const { pid } = await helperJson<{ pid: number }>(socketPath, "POST", "/v1/launch", {
      thread: "t-a",
      argv: ["env", "-i", "sleep", "30"],
    });
    const stranger = spawn("sleep", ["30"], { env: { PATH: process.env.PATH }, stdio: "ignore" });
    await new Promise((resolve) => stranger.once("spawn", resolve));
    const saved = shell.windows;
    try {
      shell.windows = [...saved, windowEntry(5, "Sandboxed", pid, []), windowEntry(6, "Someone else's", stranger.pid!, [])];
      const result = await agent.call("list_windows");
      const windows = JSON.parse(result.content[0]!.text!) as { id: number }[];
      assert.deepEqual(
        windows.map((window) => window.id),
        [1, 3, 5],
      );
    } finally {
      shell.windows = saved;
      stranger.kill();
      process.kill(pid);
    }
  });

  test("the thread setup a frontend asks for", async () => {
    const setup = await helperJson<{ env: Record<string, string>; terminalEnv: Record<string, string>; mcpServer: { args: string[] } }>(
      socketPath,
      "GET",
      "/v1/thread-setup?thread=t-a",
    );
    assert.equal(setup.env.PLUTONIUM_THREAD_ID, "t-a");
    assert.equal(setup.env.PLUTONIUM_SHOW, undefined);
    assert.equal(setup.terminalEnv.PLUTONIUM_SHOW, "1");
    assert.deepEqual(setup.mcpServer.args.slice(-1), ["mcp"]);
    const missing = await helperRequest(socketPath, "GET", "/v1/thread-setup");
    assert.equal(missing.status, 400);
  });
});
