import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { ERROR } from "../src/dbus.ts";
import { NetworkService, type NetworkState } from "../src/services/network.ts";
import type { AskUser } from "../src/services/systemBus.ts";
import { FakeBus } from "./fixtures/fakeBus.ts";
import { FakeNetworkManager, WIFI_DEVICE } from "./fixtures/fakeNetworkManager.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

describe("network", () => {
  let bus: FakeBus;
  let nm: FakeNetworkManager;
  let service: NetworkService;
  const states: NetworkState[] = [];
  const asked: { kind: string; detail: Record<string, unknown>; signal?: AbortSignal }[] = [];
  let answer: Awaited<ReturnType<AskUser>> = undefined;
  let home: { path: string; uuid: string };
  let homeAp: string;

  before(async () => {
    bus = await FakeBus.start();
    nm = new FakeNetworkManager(bus);
    home = nm.addConnection("Home", "802-11-wireless");
    nm.addConnection("Wired", "802-3-ethernet");
    nm.addConnection("Work VPN", "vpn");
    nm.addConnection("lo", "loopback");
    homeAp = nm.addAp({ ssid: "Home", strength: 70 });
    nm.addAp({ ssid: "Home", strength: 40 });
    nm.addAp({ ssid: "Cafe", strength: 80, security: "open" });
    nm.addAp({ ssid: "Neighbour", strength: 30, security: "sae" });
    nm.addAp({ ssid: "Office", strength: 20, security: "enterprise" });
    nm.addAp({ ssid: "", strength: 90 });
    nm.activate(home.path, homeAp);
    nm.start();
    service = new NetworkService({
      address: bus.address,
      agentId: "org.plutonium.helper.test",
      ask: async (kind, detail, signal) => {
        asked.push({ kind, detail, signal });
        if (answer === "hang" as unknown) return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(null)));
        return answer;
      },
    });
    await service.start((state) => states.push(state as NetworkState));
  });

  after(async () => {
    service.stop();
    await bus.stop();
  });

  test("the state: connected, the primary connection, networks and saved connections", async () => {
    const state = await service.state();
    assert.equal(state.available, true);
    assert.equal(state.state, "connected");
    assert.equal(state.connectivity, "full");
    assert.deepEqual(state.primary, { id: home.uuid, name: "Home", type: "wifi", strength: 70 });
    assert.deepEqual(state.wifi, { available: true, enabled: true, hardwareEnabled: true, scanning: false });
    // One per network (its strongest), the active one first, no hidden ones.
    assert.deepEqual(
      state.accessPoints.map(({ ssid, strength, secured, security, known, active }) => [ssid, strength, secured, security, known, active]),
      [
        ["Home", 70, true, "wpa", true, true],
        ["Cafe", 80, false, "open", false, false],
        ["Neighbour", 30, true, "sae", false, false],
        ["Office", 20, true, "enterprise", false, false],
      ],
    );
    assert.equal(state.accessPoints[0]!.id, home.uuid);
    assert.deepEqual(
      state.connections.map(({ name, type, active, state }) => [name, type, active, state]),
      [
        ["Home", "wifi", true, "activated"],
        ["Wired", "ethernet", false, null],
        ["Work VPN", "vpn", false, null],
      ],
    );
  });

  test("changes arrive as NetworkManager's signals do", async () => {
    states.length = 0;
    nm.set(homeAp, "org.freedesktop.NetworkManager.AccessPoint", { Strength: ["y", 55] });
    await settle();
    assert.equal(states.at(-1)?.primary?.strength, 55);
    nm.addAp({ ssid: "Library", strength: 60, security: "open" });
    await settle();
    assert.ok(states.at(-1)?.accessPoints.some((ap) => ap.ssid === "Library"));
    // A burst is one new state.
    states.length = 0;
    nm.set(homeAp, "org.freedesktop.NetworkManager.AccessPoint", { Strength: ["y", 56] });
    nm.set(homeAp, "org.freedesktop.NetworkManager.AccessPoint", { Strength: ["y", 57] });
    await settle();
    assert.equal(states.length, 1);
  });

  test("Wi-Fi off and on, and a scan", async () => {
    await service.call("set-wifi", { enabled: false });
    await settle();
    assert.equal((await service.state()).wifi.enabled, false);
    await service.call("set-wifi", { enabled: true });
    await assert.rejects(service.call("set-wifi", {}), /enabled/);
    await service.call("scan", {});
    assert.ok(nm.log.includes(`RequestScan ${WIFI_DEVICE}`));
    await settle();
    assert.equal((await service.state()).wifi.scanning, true);
    nm.set(WIFI_DEVICE, "org.freedesktop.NetworkManager.Device.Wireless", { LastScan: ["x", 2000] });
    await settle();
    assert.equal((await service.state()).wifi.scanning, false);
  });

  test("connect: a known network, a new one with its password, an open one", async () => {
    nm.log.length = 0;
    await service.call("connect", { ssid: "Home" });
    assert.match(nm.log[0]!, new RegExp(`^ActivateConnection ${home.path} ${WIFI_DEVICE} ${homeAp}$`));
    await service.call("connect", { ssid: "Neighbour", password: "hunter22" });
    assert.match(nm.log[1]!, /^AddAndActivateConnection .* key-mgmt=sae psk=hunter22$/);
    await service.call("connect", { ssid: "Cafe" });
    assert.match(nm.log[2]!, /^AddAndActivateConnection \S+ \S+$/);
    await assert.rejects(service.call("connect", { ssid: "Library2" }), /in range/);
    await assert.rejects(service.call("connect", { ssid: "Office", password: "x" }), /enterprise/);
    await settle();
    const state = await service.state();
    assert.ok(state.connections.some((connection) => connection.ssid === "Neighbour"));
    assert.equal(state.accessPoints.find((ap) => ap.ssid === "Neighbour")?.known, true);
  });

  test("a secured new network needs its password", async () => {
    nm.addAp({ ssid: "Locked", strength: 50 });
    await settle();
    await assert.rejects(service.call("connect", { ssid: "Locked" }), /needs a password/);
  });

  test("disconnect and forget", async () => {
    nm.log.length = 0;
    await service.call("disconnect", { id: home.uuid });
    assert.match(nm.log[0]!, /^DeactivateConnection /);
    await settle();
    await assert.rejects(service.call("disconnect", { id: home.uuid }), /isn't active/);
    await service.call("forget", { ssid: "Cafe" });
    assert.match(nm.log[1]!, /^Delete /);
    await settle();
    assert.ok(!(await service.state()).connections.some((connection) => connection.ssid === "Cafe"));
    await assert.rejects(service.call("forget", { ssid: "Cafe" }), /no such/);
    await assert.rejects(service.call("explode", {}), /no action/);
  });

  test("the secret agent asks the shell, and answers NetworkManager", async () => {
    assert.equal(nm.agent?.id, "org.plutonium.helper.test");
    answer = { password: "new-secret" };
    let reply = await nm.getSecrets(home.path, "802-11-wireless-security", 0x1 | 0x2);
    assert.equal(asked.at(-1)?.kind, "secret");
    assert.equal(asked.at(-1)?.detail.ssid, "Home");
    assert.equal(asked.at(-1)?.detail.retry, true);
    assert.deepEqual((asked.at(-1)?.detail.fields as { name: string }[]).map((field) => field.name), ["password"]);
    const secrets = reply.body?.[0] as Map<string, Map<string, unknown>>;
    assert.equal(secrets.get("802-11-wireless-security")?.get("psk"), "new-secret");

    // The user says no; no shell to ask; no interaction allowed.
    answer = null;
    reply = await nm.getSecrets(home.path, "802-11-wireless-security", 0x1);
    assert.equal(reply.type, ERROR);
    assert.match(String(reply.errorName), /UserCanceled$/);
    answer = undefined;
    reply = await nm.getSecrets(home.path, "802-11-wireless-security", 0x1);
    assert.match(String(reply.errorName), /NoSecrets$/);
    const count = asked.length;
    reply = await nm.getSecrets(home.path, "802-11-wireless-security", 0);
    assert.match(String(reply.errorName), /NoSecrets$/);
    assert.equal(asked.length, count);

    // connect's password goes to NetworkManager when it asks, without the shell.
    nm.addAp({ ssid: "Home", strength: 10 });
    await settle();
    await service.call("connect", { ssid: "Home", password: "given" });
    reply = await nm.getSecrets(home.path, "802-11-wireless-security", 0x1);
    assert.equal((reply.body?.[0] as Map<string, Map<string, unknown>>).get("802-11-wireless-security")?.get("psk"), "given");
    assert.equal(asked.length, count);

    // NetworkManager takes the question back.
    answer = "hang" as never;
    const pending = nm.getSecrets(home.path, "802-11-wireless-security", 0x1);
    await settle();
    await nm.cancelSecrets(home.path, "802-11-wireless-security");
    assert.equal(asked.at(-1)?.signal?.aborted, true);
    assert.match(String((await pending).errorName), /AgentCanceled$/);
  });
});

describe("network without NetworkManager", () => {
  test("is unavailable, then there when NetworkManager starts", async () => {
    const bus = await FakeBus.start();
    const service = new NetworkService({ address: bus.address });
    const states: NetworkState[] = [];
    await service.start((state) => states.push(state as NetworkState));
    assert.equal((await service.state()).available, false);
    await assert.rejects(service.call("scan", {}), /no NetworkManager/);
    const nm = new FakeNetworkManager(bus);
    nm.start();
    bus.signal("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "NameOwnerChanged", "sss", [
      "org.freedesktop.NetworkManager",
      "",
      ":1.99",
    ]);
    await settle();
    assert.equal(states.at(-1)?.available, true);
    assert.equal(states.at(-1)?.state, "connected");
    service.stop();
    await bus.stop();
  });
});
