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

/** FakeCdp whose events the test sends. */
class EventCdp extends FakeCdp {
  private listener: ((event: { method: string; params: unknown; sessionId?: string }) => void) | null = null;
  override addEventListener(listener?: (event: { method: string; params: unknown }) => void): void {
    this.listener = listener ?? null;
  }
  fire(method: string, params: unknown): void {
    this.listener?.({ method, params });
  }
}

describe("the relay's downloads", () => {
  const key = { threadId: "thread-1", tabId: "tab-1" };
  const relayed = () => {
    const cdp = new EventCdp();
    const tabs = new ServerTabs(cdp as unknown as BrowserCdp);
    const socket = new FakeSocket();
    tabs.serve(socket as unknown as Socket);
    tabs.attach(key, { targetId: "shown", browserTabId: 2, page: "shell", url: () => "", title: () => "" }, () => true);
    let id = 0;
    const command = (method: string, params: Record<string, unknown> = {}) =>
      socket.command({ type: "cdp", ...key, message: JSON.stringify({ id: ++id, method, params }) });
    const messages = () =>
      socket.events
        .filter((event) => event["type"] === "cdp")
        .map((event) => JSON.parse(String(event["message"])) as Record<string, unknown>);
    const download = (method: string, fields: Record<string, unknown>) =>
      cdp.fire(method, {
        downloadJson: JSON.stringify({ id: 5, tabId: 2, url: "http://x/a.txt", filename: "", path: "", receivedBytes: 0, totalBytes: 3, state: "in-progress", ...fields }),
      });
    return { cdp, tabs, command, messages, download };
  };

  test("Playwright's events for the tab's download, and the file linked where it asked", async () => {
    const { mkdtemp, readFile, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const folder = await mkdtemp(join(tmpdir(), "relay-downloads-"));
    const file = join(folder, "a.txt");
    await writeFile(file, "abc");
    const { command, messages, download } = relayed();
    command("Target.setAutoAttach", { autoAttach: true });
    command("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: join(folder, "artifacts"),
      eventsEnabled: true,
    });
    await settle();
    download("Plutonium.downloadAdded", {});
    // Another tab's: nothing.
    download("Plutonium.downloadAdded", { id: 6, tabId: 1, filename: "b.txt" });
    download("Plutonium.downloadChanged", { filename: "a.txt", path: file, receivedBytes: 1 });
    download("Plutonium.downloadChanged", { filename: "a.txt", path: file, receivedBytes: 3, state: "complete" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const events = messages().filter((message) => String(message["method"]).startsWith("Browser.download"));
    const guid = (events[0]?.["params"] as { guid: string }).guid;
    assert.deepEqual(events, [
      { method: "Browser.downloadWillBegin", params: { frameId: "shown", guid, url: "http://x/a.txt", suggestedFilename: "a.txt" } },
      { method: "Browser.downloadProgress", params: { guid, totalBytes: 3, receivedBytes: 1, state: "inProgress" } },
      { method: "Browser.downloadProgress", params: { guid, totalBytes: 3, receivedBytes: 3, state: "completed" } },
    ]);
    assert.equal(await readFile(join(folder, "artifacts", guid), "utf8"), "abc");
  });

  test("no events unless asked; cancelDownload cancels it in the browser", async () => {
    const { cdp, command, messages, download } = relayed();
    command("Target.setAutoAttach", { autoAttach: true });
    await settle();
    download("Plutonium.downloadAdded", { filename: "a.txt" });
    await settle();
    assert.equal(messages().filter((message) => message["method"] === "Browser.downloadWillBegin").length, 0);
    command("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: "/tmp/x", eventsEnabled: true });
    await settle();
    download("Plutonium.downloadAdded", { id: 7, filename: "a.txt" });
    await settle();
    const begun = messages().find((message) => message["method"] === "Browser.downloadWillBegin");
    command("Browser.cancelDownload", { guid: (begun?.["params"] as { guid: string }).guid });
    await settle();
    assert.deepEqual(cdp.sent.at(-1), { method: "Plutonium.downloadCommand", params: { id: 7, command: "cancel" } });
  });
});

test("the server's input keeps a tab no page shows drawing, until it is let go", async () => {
  const cdp = new FakeCdp();
  const tabs = new ServerTabs(cdp as unknown as BrowserCdp);
  const awake: Array<[number, boolean]> = [];
  tabs.keepAwake = async (id, value) => void awake.push([id, value]);
  const socket = new FakeSocket();
  tabs.serve(socket as unknown as Socket);
  const key = { threadId: "t", tabId: "a" };
  tabs.attach(key, { targetId: "shown", browserTabId: 2, page: "shell", url: () => "", title: () => "" }, () => true);
  const send = (id: number, method: string) =>
    socket.command({ type: "cdp", ...key, message: JSON.stringify({ id, method, sessionId: "plutonium-tab-page" }) });
  send(1, "Runtime.evaluate");
  await settle();
  assert.deepEqual(awake, []);
  send(2, "Input.dispatchMouseEvent");
  send(3, "Input.dispatchMouseEvent");
  await settle();
  assert.deepEqual(awake, [[2, true]]);
  // The move went to the page after it woke.
  assert.ok(cdp.methods().includes("Input.dispatchMouseEvent"));
  tabs.detach(key);
  assert.deepEqual(awake, [[2, true], [2, false]]);
});
