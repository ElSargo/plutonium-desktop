import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { DesktopCapture } from "../src/desktop.ts";
import { Recordings } from "../src/recordings.ts";

/** A gst-launch-1.0 that writes its arguments to its file and finishes on SIGINT. */
function fakeEncoder(directory: string, body = ""): string {
  const path = join(directory, "gst-launch");
  writeFileSync(
    path,
    `#!/bin/sh
for arg; do case "$arg" in location=*) out="\${arg#location=}";; esac; done
${body}
echo "$@" > "$out"
trap 'echo eos >> "$out"; exit 0' INT
while :; do sleep 0.05; done
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function setup(body?: string) {
  const directory = mkdtempSync(join(tmpdir(), "recordings-test-"));
  const commands: [string, Record<string, unknown>][] = [];
  const recordings = new Recordings({
    captureCommand: async (command, args) => {
      commands.push([command, args]);
      return command === "start" ? { captureId: 7, nodeId: 42, width: 640, height: 480 } : {};
    },
    gstLaunch: fakeEncoder(directory, body),
    directory,
    settleMs: 200,
  });
  return { directory, commands, recordings };
}

test("a recording is a capture with the agent as its consumer, written from its node", async () => {
  const { commands, recordings } = setup();
  const started = await recordings.start("t3:thread/a", { type: "window", id: 5 });
  assert.deepEqual(commands[0], [
    "start",
    { source: { type: "window", id: 5 }, cursor: "hidden", consumer: { kind: "agent", thread: "t3:thread/a", name: "An agent" } },
  ]);
  assert.match(started.path, /window-5-.*\.webm$/);
  assert.deepEqual(recordings.list("t3:thread/b"), []);
  await assert.rejects(recordings.stop("t3:thread/b"), /isn't recording/);
  const stopped = await recordings.stop("t3:thread/a");
  const written = readFileSync(started.path, "utf8");
  assert.match(written, /pipewiresrc path=42 /);
  assert.match(written, /eos/);
  assert.ok(stopped.bytes > 0);
  assert.equal(stopped.ended, undefined);
  assert.deepEqual(commands.at(-1), ["stop", { id: 7 }]);
  assert.deepEqual(recordings.list("t3:thread/a"), []);
});

test("a shell stopping the capture ends the recording; stop still returns the file", async () => {
  const { recordings } = setup();
  const started = await recordings.start("t3:thread/a", { type: "tab", id: 3 });
  recordings.onCapture("stop", { id: 7 } as DesktopCapture);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.match(recordings.list("t3:thread/a")[0]!.ended ?? "", /stopped/);
  const stopped = await recordings.stop("t3:thread/a", started.recording_id);
  assert.match(readFileSync(stopped.path, "utf8"), /eos/);
});

test("an encoder that fails stops the capture and says why", async () => {
  const { commands, recordings } = setup('echo "no element pipewiresrc" >&2; exit 1');
  await assert.rejects(recordings.start("t3:thread/a", { type: "window", id: 5 }), /no element pipewiresrc/);
  assert.deepEqual(commands.at(-1), ["stop", { id: 7 }]);
});

test("no GStreamer says what to install", async () => {
  const recordings = new Recordings({
    captureCommand: async (command) => (command === "start" ? { captureId: 1, nodeId: 2 } : {}),
    gstLaunch: "/nonexistent/gst-launch-1.0",
    directory: mkdtempSync(join(tmpdir(), "recordings-test-")),
  });
  await assert.rejects(recordings.start("t", { type: "window", id: 1 }), /needs GStreamer/);
});

test("the recording switch's refusal comes back as it is", async () => {
  const recordings = new Recordings({
    captureCommand: async () => {
      throw new Error("Recording is switched off");
    },
    directory: mkdtempSync(join(tmpdir(), "recordings-test-")),
  });
  await assert.rejects(recordings.start("t", { type: "window", id: 1 }), /switched off/);
});
