import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { afterEach, describe, test } from "node:test";
import { RelayError, ShellRelay } from "../src/relay.ts";

/** A shell page's request stream, as the relay writes it. */
class FakeStream extends EventEmitter {
  status = 0;
  ended = false;
  readonly events: { id?: string; op: string; args: Record<string, unknown> }[] = [];
  writeHead(status: number): this {
    this.status = status;
    return this;
  }
  write(chunk: string): boolean {
    for (const line of chunk.split("\n")) {
      if (line.startsWith("data: ")) this.events.push(JSON.parse(line.slice(6)));
    }
    return true;
  }
  end(): this {
    this.ended = true;
    return this;
  }
  close(): void {
    this.emit("close");
  }
  /** The requests (with an id) sent to it. */
  requests() {
    return this.events.filter((event) => event.id !== undefined);
  }
}

// Every stream, closed after each test (their heartbeats keep the process up).
const streams: FakeStream[] = [];
afterEach(() => {
  for (const stream of streams.splice(0)) stream.close();
});

function attach(relay: ShellRelay, key: string, shellId = "", visible = true): FakeStream {
  const stream = new FakeStream();
  streams.push(stream);
  relay.attach(stream as unknown as ServerResponse, key, "http://shell.test", shellId, visible);
  return stream;
}

const json = (value: unknown) => Buffer.from(JSON.stringify(value));

describe("ShellRelay", () => {
  test("with no shell, requests fail at once", async () => {
    const relay = new ShellRelay();
    assert.equal(relay.connected, false);
    await assert.rejects(relay.windows(), (error: unknown) => error instanceof RelayError && error.status === 503);
  });

  test("sends a request to the shell and resolves with its reply", async () => {
    const relay = new ShellRelay();
    const stream = attach(relay, "page-1");
    assert.equal(stream.status, 200);
    const windows = relay.windows();
    const [request] = stream.requests();
    assert.equal(request?.op, "windows");
    assert.equal(relay.reply(request!.id!, "application/json", json({ ok: true, value: [{ id: 1 }] })), true);
    assert.deepEqual(await windows, [{ id: 1 }]);
    // Answered once.
    assert.equal(relay.reply(request!.id!, "application/json", json({ ok: true })), false);
  });

  test("a request for one page goes to that page, whichever was shown last", async () => {
    const relay = new ShellRelay();
    const first = attach(relay, "display-1");
    const second = attach(relay, "display-2");
    assert.deepEqual(relay.pages(), [
      { key: "display-1", visible: true },
      { key: "display-2", visible: true },
    ]);
    const answer = relay.requestPage("display-1", "file_chooser", { handle: "h" }, 1_000);
    assert.equal(second.requests().length, 0);
    const [request] = first.requests();
    assert.equal(request?.op, "file_chooser");
    relay.reply(request!.id!, "application/json", json({ ok: true, value: { paths: [] } }));
    assert.equal((await answer).kind, "json");
    await assert.rejects(relay.requestPage("gone", "file_chooser"), (error: unknown) => error instanceof RelayError);
  });

  test("a refusal, a malformed reply and an image", async () => {
    const relay = new ShellRelay();
    const stream = attach(relay, "page-1");
    const refused = relay.json("focus", { windowId: 2 });
    const malformed = relay.json("close", {});
    const image = relay.request("snapshot", {});
    const [a, b, c] = stream.requests();
    relay.reply(a!.id!, "application/json", json({ ok: false, error: "No such window." }));
    relay.reply(b!.id!, "application/json", Buffer.from("{nope"));
    relay.reply(c!.id!, "image/png", Buffer.from([0x89, 0x50]));
    await assert.rejects(refused, (error: unknown) => error instanceof RelayError && error.status === 409 && error.message === "No such window.");
    await assert.rejects(malformed, (error: unknown) => error instanceof RelayError && error.status === 502);
    assert.deepEqual(await image, { kind: "png", data: Buffer.from([0x89, 0x50]) });
  });

  test("a shell that doesn't answer in time", async () => {
    const relay = new ShellRelay();
    attach(relay, "page-1");
    await assert.rejects(relay.request("windows", {}, 20), (error: unknown) => error instanceof RelayError && error.status === 504);
  });

  test("groups: older shells that don't know them have none", async () => {
    const relay = new ShellRelay();
    const stream = attach(relay, "page-1");
    const groups = relay.groups();
    relay.reply(stream.requests()[0]!.id!, "application/json", json({ ok: false, error: "Unknown op groups" }));
    assert.deepEqual(await groups, []);
  });

  test("picks the owning shell, else the visible one, else the one seen last", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
    const relay = new ShellRelay();
    const plain = attach(relay, "plain", "shell-plain", false);
    t.mock.timers.tick(10);
    const t3 = attach(relay, "t3", "shell-t3", true);
    const sent = (stream: FakeStream) => stream.requests().length;

    void relay.request("windows", {}, 1_000, "shell-plain").catch(() => {});
    assert.equal(sent(plain), 1, "the group's owner, though hidden");
    void relay.request("windows", {}, 1_000, "shell-gone").catch(() => {});
    assert.equal(sent(t3), 1, "an unknown owner: the visible one");

    relay.setVisible("t3", false);
    t.mock.timers.tick(10);
    relay.setVisible("plain", false);
    void relay.request("windows", {}, 1_000).catch(() => {});
    assert.equal(sent(plain), 2, "none visible: the one visible most recently");
    assert.equal(relay.setVisible("nobody", true), false);
    assert.deepEqual(
      relay.shells().map((shell) => shell.shellId).sort(),
      ["shell-plain", "shell-t3"],
    );
  });

  test("a shell that goes away fails its requests; a reconnect replaces it", async () => {
    const relay = new ShellRelay();
    const disconnects: string[] = [];
    const attaches: string[] = [];
    relay.onDisconnect = (key) => disconnects.push(key);
    relay.onAttach = (key) => attaches.push(key);
    const first = attach(relay, "page-1");
    const pending = relay.windows();
    // The page reloads: same key, a new stream.
    const second = attach(relay, "page-1");
    await assert.rejects(pending, (error: unknown) => error instanceof RelayError && error.status === 503);
    assert.equal(first.ended, true);
    assert.deepEqual(disconnects, [], "a reconnect isn't a disconnect");
    assert.deepEqual(attaches, ["page-1", "page-1"]);
    // The old stream closing later doesn't drop the new one.
    first.close();
    assert.equal(relay.has("page-1"), true);
    second.close();
    assert.equal(relay.has("page-1"), false);
    assert.deepEqual(disconnects, ["page-1"]);
  });

  test("notices go to one page or all, without an id", () => {
    const relay = new ShellRelay();
    const a = attach(relay, "a");
    const b = attach(relay, "b");
    relay.notify("a", "pointer", { x: 1 });
    relay.notifyAll("agent_windows", { windows: [] });
    assert.deepEqual(a.events, [
      { op: "pointer", args: { x: 1 } },
      { op: "agent_windows", args: { windows: [] } },
    ]);
    assert.deepEqual(b.events, [{ op: "agent_windows", args: { windows: [] } }]);
  });
});
