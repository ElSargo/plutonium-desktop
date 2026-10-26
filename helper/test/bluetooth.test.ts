import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { BluetoothService, type BluetoothState } from "../src/services/bluetooth.ts";
import { FakeBluez } from "./fixtures/fakeBluez.ts";
import { FakeBus } from "./fixtures/fakeBus.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

describe("bluetooth", () => {
  let bus: FakeBus;
  let bluez: FakeBluez;
  let service: BluetoothService;
  const states: BluetoothState[] = [];
  const asked: { kind: string; detail: Record<string, unknown>; signal?: AbortSignal }[] = [];
  let answer: Record<string, unknown> | null | undefined | "wait" = {};
  let mouse: string;

  before(async () => {
    bus = await FakeBus.start();
    bluez = new FakeBluez(bus);
    mouse = bluez.addDevice({ address: "AA:00:00:00:00:01", name: "MX Master", icon: "input-mouse", paired: true, connected: true, battery: 80 });
    bluez.addDevice({ address: "AA:00:00:00:00:02", name: "Headphones", icon: "audio-headset", paired: true });
    bluez.addDevice({ address: "AA:00:00:00:00:03" }); // A beacon: no name.
    bluez.start();
    service = new BluetoothService({
      address: bus.address,
      ask: async (kind, detail, signal) => {
        asked.push({ kind, detail, signal });
        if (answer === "wait") return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(null)));
        return answer;
      },
    });
    await service.start((state) => states.push(state as BluetoothState));
  });

  after(async () => {
    service.stop();
    await bus.stop();
  });

  test("the state: the adapter and the named devices", async () => {
    const state = await service.state();
    assert.equal(state.available, true);
    assert.deepEqual(state.adapter, {
      id: "/org/bluez/hci0",
      name: "laptop",
      address: "00:11:22:33:44:55",
      powered: true,
      discovering: false,
      discoverable: false,
    });
    assert.deepEqual(
      state.devices.map(({ name, icon, paired, connected, battery }) => [name, icon, paired, connected, battery]),
      [
        ["MX Master", "input-mouse", true, true, 80],
        ["Headphones", "audio-headset", true, false, null],
      ],
    );
    assert.equal(bluez.agent?.capability, "KeyboardDisplay");
  });

  test("changes, discovery and devices found", async () => {
    bluez.set(mouse, "org.bluez.Device1", { Connected: ["b", false] });
    await settle();
    assert.equal(states.at(-1)?.devices.find((device) => device.id === mouse)?.connected, false);
    await service.call("discover", { on: true, seconds: 1 });
    await settle();
    assert.equal(states.at(-1)?.adapter?.discovering, true);
    bluez.addDevice({ address: "AA:00:00:00:00:04", name: "Speaker" });
    await settle();
    assert.ok(states.at(-1)?.devices.some((device) => device.name === "Speaker" && !device.paired));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.deepEqual(bluez.log.slice(-2), ["StartDiscovery", "StopDiscovery"]);
    await assert.rejects(service.call("discover", {}), /on: true/);
  });

  test("power, connect, disconnect, forget", async () => {
    await service.call("set-powered", { powered: false });
    await settle();
    assert.equal((await service.state()).adapter?.powered, false);
    await service.call("set-powered", { powered: true });
    await service.call("connect", { device: mouse });
    await service.call("disconnect", { device: mouse });
    assert.deepEqual(bluez.log.slice(-2), [`Connect ${mouse}`, `Disconnect ${mouse}`]);
    const speaker = (await service.state()).devices.find((device) => device.name === "Speaker")!;
    await service.call("forget", { device: speaker.id });
    await settle();
    assert.ok(!(await service.state()).devices.some((device) => device.name === "Speaker"));
    await assert.rejects(service.call("connect", { device: speaker.id }), /device's id/);
    await assert.rejects(service.call("connect", {}), /device's id/);
    await assert.rejects(service.call("explode", {}), /no action/);
  });

  test("pairing: the shell confirms the code, or gives the PIN", async () => {
    const phone = bluez.addDevice({ address: "AA:00:00:00:00:05", name: "Phone" });
    await settle();
    answer = {};
    await service.call("pair", { device: phone });
    assert.equal(asked.at(-1)?.kind, "confirm");
    assert.equal(asked.at(-1)?.detail.code, "987654");
    assert.equal(asked.at(-1)?.detail.name, "Phone");
    await settle();
    const paired = (await service.state()).devices.find((device) => device.id === phone)!;
    assert.deepEqual([paired.paired, paired.trusted, paired.connected, paired.pairing], [true, true, true, false]);

    const keyboard = bluez.addDevice({ address: "AA:00:00:00:00:06", name: "Old keyboard", pairWith: "RequestPinCode" });
    await settle();
    answer = { pin: "0000" };
    await service.call("pair", { device: keyboard });
    assert.equal(asked.at(-1)?.kind, "pin");
    assert.ok(bluez.log.includes('agent RequestPinCode → ["0000"]'));

    // The user says no: the pairing fails.
    const other = bluez.addDevice({ address: "AA:00:00:00:00:07", name: "Stranger" });
    await settle();
    answer = null;
    await assert.rejects(service.call("pair", { device: other }), /Rejected/);
    assert.match(String(bluez.lastAgentReply?.errorName), /Rejected$/);
    // No shell to ask: canceled.
    answer = undefined;
    await assert.rejects(service.call("pair", { device: other }), /Rejected/);
    assert.match(String(bluez.lastAgentReply?.errorName), /Canceled$/);
  });

  test("a code to type on the device: shown until the pairing ends", async () => {
    const keyboard = bluez.addDevice({ address: "AA:00:00:00:00:08", name: "Keyboard", pairWith: "DisplayPasskey" });
    await settle();
    answer = "wait";
    const pairing = service.call("pair", { device: keyboard });
    await settle();
    assert.equal(asked.at(-1)?.kind, "display");
    assert.equal(asked.at(-1)?.detail.code, "001234");
    assert.equal((await service.state()).devices.find((device) => device.id === keyboard)?.pairing, true);
    bluez.typed();
    await pairing;
    assert.equal(asked.at(-1)?.signal?.aborted, true);
    assert.ok(!bluez.log.includes(`CancelPairing ${keyboard}`));

    // The user cancels it.
    const another = bluez.addDevice({ address: "AA:00:00:00:00:09", name: "Keyboard 2", pairWith: "DisplayPasskey" });
    await settle();
    answer = null;
    await assert.rejects(service.call("pair", { device: another }), /Canceled/);
    assert.ok(bluez.log.includes(`CancelPairing ${another}`));
  });
});

describe("bluetooth without BlueZ", () => {
  test("is unavailable", async () => {
    const bus = await FakeBus.start();
    const service = new BluetoothService({ address: bus.address });
    await service.start(() => {});
    assert.deepEqual(await service.state(), { available: false, adapter: null, devices: [] });
    await assert.rejects(service.call("set-powered", { powered: true }), /no Bluetooth adapter/);
    service.stop();
    await bus.stop();
  });
});
