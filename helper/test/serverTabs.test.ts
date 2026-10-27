import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { describe, test } from "node:test";
import type { BrowserCdp } from "../src/cdp.ts";
import { ServerTabs } from "../src/serverTabs.ts";

/** The browser's DevTools, recording each command. */
class FakeCdp {
  readonly sent: { method: string; params: Record<string, unknown> }[] = [];
  private targets = 0;
  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.sent.push({ method, params });
    if (method === "Target.createTarget") return { targetId: `hidden-${++this.targets}` };
    if (method === "Plutonium.getTabs") {
      return { tabs: [{ id: 1, targetId: "other", embedded: true }, { id: 2, targetId: "shown", embedded: false }] };
    }
    return {};
  }
  addEventListener(): void {}
  addCloseListener(): void {}
  methods(): string[] {
    return this.sent.map((command) => command.method);
  }
}

/** The server's end of the desktop browser channel. */
class FakeSocket extends EventEmitter {
  readonly events: Record<string, unknown>[] = [];
  write(chunk: string): boolean {
    for (const line of chunk.split("\n")) if (line) this.events.push(JSON.parse(line));
    return true;
  }
  destroy(): void {
    this.emit("close");
  }
  command(command: Record<string, unknown>): void {
    this.emit("data", Buffer.from(`${JSON.stringify(command)}\n`));
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

const serving = () => {
  const cdp = new FakeCdp();
  const tabs = new ServerTabs(cdp as unknown as BrowserCdp);
  const socket = new FakeSocket();
  tabs.serve(socket as unknown as Socket);
  return { cdp, tabs, socket };
};

describe("scratch pages", () => {
  const key = { threadId: "thread-1", tabId: "scratch-1" };

  test("opens a hidden page and attaches it", async () => {
    const { cdp, tabs, socket } = serving();
    socket.command({ type: "scratch", ...key });
    await settle();
    assert.deepEqual(cdp.sent[0], {
      method: "Target.createTarget",
      params: { url: "about:blank", hidden: true, background: true },
    });
    assert.deepEqual(socket.events, [{ type: "attached", ...key }]);
    assert.deepEqual(tabs.attachedTabs(), [key]);
  });

  test("close closes the page", async () => {
    const { cdp, tabs, socket } = serving();
    socket.command({ type: "scratch", ...key });
    await settle();
    socket.command({ type: "close", ...key });
    await settle();
    assert.deepEqual(cdp.sent.at(-1), { method: "Target.closeTarget", params: { targetId: "hidden-1" } });
    assert.deepEqual(socket.events.at(-1), { type: "detached", ...key });
    assert.deepEqual(tabs.attachedTabs(), []);
  });

  test("the server's disconnect closes its pages", async () => {
    const { cdp, tabs, socket } = serving();
    socket.command({ type: "scratch", ...key });
    await settle();
    socket.destroy();
    await settle();
    assert.ok(cdp.methods().includes("Target.closeTarget"));
    assert.deepEqual(tabs.attachedTabs(), []);
  });

  test("a page opened after the server left is closed at once", async () => {
    const cdp = new FakeCdp();
    const tabs = new ServerTabs(cdp as unknown as BrowserCdp);
    const socket = new FakeSocket();
    tabs.serve(socket as unknown as Socket);
    socket.command({ type: "scratch", ...key });
    socket.destroy();
    await settle();
    assert.deepEqual(cdp.methods(), ["Target.createTarget", "Target.closeTarget"]);
    assert.deepEqual(tabs.attachedTabs(), []);
  });
});

describe("the relay", () => {
  test("answers Plutonium.getTabs with its own tab alone", async () => {
    const { tabs, socket } = serving();
    const key = { threadId: "thread-1", tabId: "tab-1" };
    tabs.attach(key, { targetId: "shown", browserTabId: 2, page: "shell", url: () => "", title: () => "" }, () => true);
    socket.command({ type: "cdp", ...key, message: JSON.stringify({ id: 7, method: "Plutonium.getTabs" }) });
    await settle();
    const reply = socket.events.find((event) => event["type"] === "cdp");
    assert.deepEqual(JSON.parse(String(reply?.["message"])), {
      id: 7,
      result: { tabs: [{ id: 2, targetId: "shown", embedded: false }] },
    });
  });
});

const fakeCdp = { addEventListener: () => {}, addCloseListener: () => {} } as unknown as BrowserCdp;

test("the server's open asks for an incognito tab only when it says so", () => {
  const tabs = new ServerTabs(fakeCdp);
  const opened: Array<[string, string, boolean]> = [];
  tabs.onOpen = (key, tag, incognito) => opened.push([key.tabId, tag, incognito]);
  const socket = Object.assign(new EventEmitter(), { write: () => true, destroy: () => {} });
  tabs.serve(socket as unknown as Socket);
  const send = (command: Record<string, unknown>) =>
    socket.emit("data", Buffer.from(`${JSON.stringify(command)}\n`));
  send({ type: "open", threadId: "t", tabId: "a", tag: "thread:t" });
  send({ type: "open", threadId: "t", tabId: "b", tag: "thread:t", incognito: true });
  assert.deepEqual(opened, [
    ["a", "thread:t", false],
    ["b", "thread:t", true],
  ]);
});

test("a tab a page brought from elsewhere replaces the one the helper opened, which closes", () => {
  const tabs = new ServerTabs(fakeCdp);
  const closed: number[] = [];
  tabs.onClose = (_key, browserTabId) => closed.push(browserTabId);
  const key = { threadId: "t", tabId: "a" };
  const info = (page: string, browserTabId: number) => ({
    targetId: `target-${browserTabId}`,
    browserTabId,
    page,
    url: () => "",
    title: () => "",
  });
  tabs.attach(key, info("plutoniumd", 7), () => true);
  // A page's own new tab shows the helper's instead.
  assert.equal(tabs.attach(key, info("shell", 8), () => true), 7);
  assert.deepEqual(closed, []);
  assert.equal(tabs.attach(key, info("shell", 6), () => true, true), 6);
  assert.deepEqual(closed, [7]);
  // Not another page's, though.
  assert.equal(tabs.attach(key, info("other", 9), () => true, true), 6);
});
