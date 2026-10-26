import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { AudioService, type AudioState } from "../src/services/audio.ts";
import type { FakeGraph } from "./fixtures/fake-pipewire.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-pipewire.ts", import.meta.url));

const GRAPH: FakeGraph = {
  nodes: [
    { id: 64, name: "alsa_output.analog", description: "Speakers", kind: "Sink", linear: 0.125, mute: false },
    { id: 70, name: "bluez_output.headset", description: "Headset", kind: "Sink", linear: 1, mute: true },
    { id: 71, name: "alsa_input.mic", description: "Microphone", kind: "Source", linear: 1, mute: false },
  ],
  sink: "alsa_output.analog",
  source: "alsa_input.mic",
};

/** Resolves with the first state `changed` gets that `match` accepts. */
function waitFor(states: AudioState[], match: (state: AudioState) => boolean): Promise<AudioState> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5_000;
    const check = () => {
      const found = states.find(match);
      if (found) resolve(found);
      else if (Date.now() > deadline) reject(new Error(`no such state; last ${JSON.stringify(states.at(-1))}`));
      else setTimeout(check, 20);
    };
    check();
  });
}

describe("audio service", () => {
  let dir: string;
  let graph: string;
  let audio: AudioService;
  const states: AudioState[] = [];

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "plutonium-audio-"));
    graph = join(dir, "graph.json");
    writeFileSync(graph, JSON.stringify(GRAPH));
    for (const tool of ["wpctl", "pw-dump"]) {
      writeFileSync(join(dir, tool), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" ${tool} "$@"\n`);
      chmodSync(join(dir, tool), 0o755);
    }
    audio = new AudioService({ env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_PIPEWIRE: graph } });
    await audio.start((state) => states.push(state as AudioState));
  });

  after(() => {
    audio.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("lists outputs and inputs, the default output up front", async () => {
    const state = await audio.state();
    assert.equal(state.available, true);
    assert.equal(state.volume, 0.5);
    assert.equal(state.muted, false);
    assert.deepEqual(state.output, { id: 64, node: "alsa_output.analog", name: "Speakers", default: true, volume: 0.5, muted: false });
    assert.deepEqual(state.outputs.map((device) => [device.id, device.default, device.muted]), [[64, true, false], [70, false, true]]);
    assert.equal(state.input?.name, "Microphone");
  });

  test("set-volume, set-mute and step change the default output", async () => {
    assert.equal((await audio.call("set-volume", { volume: 0.4 })).volume, 0.4);
    assert.equal((await audio.call("set-mute", {})).muted, true);
    // Up unmutes, and stops at 1.
    let state = await audio.call("step", { by: 0.05 });
    assert.equal(state.muted, false);
    assert.equal(state.volume, 0.45);
    await audio.call("set-volume", { volume: 0.98 });
    state = await audio.call("step", { by: 0.05 });
    assert.equal(state.volume, 1);
    state = await audio.call("step", { by: -0.1 });
    assert.equal(state.volume, 0.9);
    assert.equal((await audio.call("set-volume", { volume: 9 })).volume, 1.5);
    const log = readFileSync(`${graph}.log`, "utf8");
    assert.match(log, /^set-volume @DEFAULT_AUDIO_SINK@ 5%\+ --limit 1$/m);
  });

  test("the mic: set-mute on the default input", async () => {
    assert.equal((await audio.call("set-mute", { device: "input", muted: true })).input?.muted, true);
    assert.equal((await audio.call("set-mute", { device: "input", muted: false })).input?.muted, false);
  });

  test("set-default moves the default", async () => {
    const state = await audio.call("set-default", { device: 70 });
    assert.equal(state.output?.id, 70);
    assert.equal(state.muted, true);
    assert.deepEqual(state.outputs.map((device) => device.default), [false, true]);
  });

  test("refuses bad arguments and unknown actions", async () => {
    await assert.rejects(audio.call("set-volume", { volume: "loud" }), { status: 400 });
    await assert.rejects(audio.call("set-volume", { device: 9999, volume: 0.2 }), { status: 400 });
    await assert.rejects(audio.call("set-default", {}), { status: 400 });
    await assert.rejects(audio.call("dance", {}), { status: 404 });
  });

  test("a change made elsewhere (pavucontrol) arrives as a change", async () => {
    const changed = JSON.parse(readFileSync(graph, "utf8")) as FakeGraph;
    changed.nodes[0]!.linear = 0.027; // 0.3
    writeFileSync(graph, JSON.stringify(changed));
    const state = await waitFor(states, (state) => state.outputs[0]?.volume === 0.3);
    assert.equal(state.outputs[0]!.id, 64);
  });
});

describe("audio service without PipeWire", () => {
  test("is not available, and says so instead of failing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plutonium-audio-"));
    try {
      const audio = new AudioService({ env: { PATH: dir } });
      await audio.start(() => {});
      assert.equal((await audio.state()).available, false);
      await assert.rejects(audio.call("step", { by: 0.05 }), { status: 404 });
      audio.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
