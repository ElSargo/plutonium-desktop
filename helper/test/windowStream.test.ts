import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";

import type { ScreencastFrame } from "../src/desktop.ts";
import { encodeFrame, FrameReader, type ScreencastSource, streamWindow } from "../src/windowStream.ts";

describe("window stream", () => {
  test("frames survive any split", () => {
    const frames = [
      { data: Buffer.from("first jpeg"), width: 640, height: 480 },
      { data: Buffer.from("2"), width: 1, height: 2 },
    ];
    const bytes = Buffer.concat(frames.map(encodeFrame));
    for (let cut = 0; cut <= bytes.length; cut++) {
      const reader = new FrameReader();
      const got = [...reader.push(bytes.subarray(0, cut)), ...reader.push(bytes.subarray(cut))];
      assert.deepEqual(got, frames, `cut at ${cut}`);
    }
  });

  test("streams a window's frames, keeps it awake, and stops with the reader", async () => {
    let listener: ((frame: ScreencastFrame | null) => void) | null = null;
    let options: unknown;
    let stopped = false;
    const awake: boolean[] = [];
    const source: ScreencastSource = {
      async screencast(_id, given, onFrame) {
        options = given;
        listener = onFrame;
        return () => (stopped = true);
      },
    };
    const server = createServer((_request, response) => {
      void streamWindow(source, 7, { maxWidth: 800 }, response, (on) => awake.push(on));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const reader = new FrameReader();
      const received: { width: number; height: number; data: Buffer }[] = [];
      const response = await new Promise<import("node:http").IncomingMessage>((resolve) =>
        get(`http://127.0.0.1:${port}/`, resolve),
      );
      assert.equal(response.statusCode, 200);
      assert.deepEqual(options, { format: "jpeg", maxWidth: 800 });
      assert.deepEqual(awake, [true]);
      const got = new Promise<void>((resolve) =>
        response.on("data", (chunk: Buffer) => {
          received.push(...reader.push(chunk));
          if (received.length === 2) resolve();
        }),
      );
      listener!({ windowId: 7, data: Buffer.from("a"), width: 10, height: 20 });
      listener!({ windowId: 7, data: Buffer.from("bc"), width: 30, height: 40 });
      await got;
      assert.deepEqual(
        received.map((frame) => [frame.width, frame.height, frame.data.toString()]),
        [
          [10, 20, "a"],
          [30, 40, "bc"],
        ],
      );
      // The window closing ends the response.
      const ended = new Promise((resolve) => response.on("end", resolve));
      listener!(null);
      await ended;
      assert.equal(stopped, true);
      assert.deepEqual(awake, [true, false]);
    } finally {
      server.close();
    }
  });
});
