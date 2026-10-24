import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { test } from "node:test";

import type { BrowserCdp } from "../src/cdp.ts";
import { ServerTabs } from "../src/serverTabs.ts";

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
