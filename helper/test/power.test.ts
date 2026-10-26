import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Variant } from "../src/dbus.ts";
import { PowerService, type PowerState } from "../src/services/power.ts";
import { FakeBus, type ObjectHandler } from "./fixtures/fakeBus.ts";

const PROPERTIES = "org.freedesktop.DBus.Properties";
const SESSION = "/org/freedesktop/login1/session/_3";

/** An object with properties (Get, GetAll) and methods. */
function object(properties: Record<string, Record<string, Variant>>, methods: Record<string, ObjectHandler> = {}): ObjectHandler {
  return (method, body, message) => {
    if (method === `${PROPERTIES}.GetAll`) return { signature: "a{sv}", body: [new Map(Object.entries(properties[String(body[0])] ?? {}))] };
    if (method === `${PROPERTIES}.Get`) {
      const value = properties[String(body[0])]?.[String(body[1])];
      return value ? { signature: "v", body: [value] } : { error: "org.freedesktop.DBus.Error.UnknownProperty" };
    }
    return methods[method]?.(method, body, message) ?? { error: "org.freedesktop.DBus.Error.UnknownMethod" };
  };
}

describe("power service", () => {
  let bus: FakeBus;
  let dir: string;
  let power: PowerService;
  let loggedOut = 0;
  const done: string[] = [];
  const states: PowerState[] = [];
  const battery: Record<string, Variant> = {
    Type: ["u", 2],
    IsPresent: ["b", true],
    State: ["u", 2],
    Percentage: ["d", 57.4],
    TimeToEmpty: ["x", 7200],
    TimeToFull: ["x", 0],
  };
  const upower: Record<string, Variant> = { OnBattery: ["b", true] };

  before(async () => {
    bus = await FakeBus.start();
    dir = mkdtempSync(join(tmpdir(), "plutonium-power-"));
    // Two backlights: the firmware one is used.
    for (const [name, type, max] of [["acpi_video0", "raw", 15], ["amdgpu_bl1", "firmware", 1000]] as const) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "type"), `${type}\n`);
      writeFileSync(join(dir, name, "max_brightness"), `${max}\n`);
      writeFileSync(join(dir, name, "brightness"), `${max / 2}\n`);
    }
    const ok = (name: string): ObjectHandler => () => (done.push(name), { signature: "", body: [] });
    bus.serveObject("org.freedesktop.login1", "/org/freedesktop/login1", object({}, {
      "org.freedesktop.login1.Manager.CanSuspend": () => ({ signature: "s", body: ["yes"] }),
      "org.freedesktop.login1.Manager.CanReboot": () => ({ signature: "s", body: ["yes"] }),
      "org.freedesktop.login1.Manager.CanPowerOff": () => ({ signature: "s", body: ["challenge"] }),
      "org.freedesktop.login1.Manager.GetUser": (_, [uid]) =>
        uid === userInfo().uid ? { signature: "o", body: ["/org/freedesktop/login1/user/_1000"] } : { error: "org.freedesktop.login1.NoSuchUser" },
      "org.freedesktop.login1.Manager.GetSession": () => ({ error: "org.freedesktop.login1.NoSuchSession" }),
      "org.freedesktop.login1.Manager.Suspend": ok("Suspend"),
      "org.freedesktop.login1.Manager.Reboot": ok("Reboot"),
      "org.freedesktop.login1.Manager.PowerOff": (_, body) =>
        body[0] === false ? { error: "org.freedesktop.DBus.Error.InteractiveAuthorizationRequired", message: "Interactive authentication required." } : ok("PowerOff")(_, body, undefined!),
    }));
    bus.serveObject("org.freedesktop.login1", "/org/freedesktop/login1/user/_1000", object({
      "org.freedesktop.login1.User": { Display: ["(so)", ["3", SESSION]] },
    }));
    bus.serveObject("org.freedesktop.login1", SESSION, object({}, {
      "org.freedesktop.login1.Session.SetBrightness": (_, [subsystem, name, value]) => {
        done.push(`SetBrightness ${subsystem} ${name} ${value}`);
        writeFileSync(join(dir, String(name), "brightness"), `${value}\n`);
        return { signature: "", body: [] };
      },
    }));
    bus.serveObject("org.freedesktop.UPower", "/org/freedesktop/UPower", object({ "org.freedesktop.UPower": upower }));
    bus.serveObject("org.freedesktop.UPower", "/org/freedesktop/UPower/devices/DisplayDevice", object({ "org.freedesktop.UPower.Device": battery }));
    delete process.env.XDG_SESSION_ID;
    power = new PowerService({ address: bus.address, backlights: dir, backlightPollMs: 50, logOut: () => loggedOut++ });
    await power.start((state) => states.push(state as PowerState));
  });

  after(async () => {
    power.stop();
    await bus.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("reads the battery, AC, the backlight and what logind allows", async () => {
    assert.deepEqual(await power.state(), {
      battery: { percent: 57, charging: false, state: "discharging", timeLeft: 7200 },
      ac: false,
      brightness: { available: true, value: 0.5 },
      can: { suspend: "yes", reboot: "yes", powerOff: "challenge", logOut: "yes" },
    });
  });

  test("the battery's changes arrive with UPower's signal", async () => {
    battery.State = ["u", 1];
    battery.TimeToFull = ["x", 1800];
    upower.OnBattery = ["b", false];
    bus.signal("org.freedesktop.UPower", "/org/freedesktop/UPower/devices/DisplayDevice", PROPERTIES, "PropertiesChanged", "sa{sv}as", [
      "org.freedesktop.UPower.Device",
      new Map([["State", ["u", 1]]]),
      [],
    ]);
    const deadline = Date.now() + 3_000;
    while (!states.at(-1)?.battery?.charging && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(states.at(-1)!.battery, { percent: 57, charging: true, state: "charging", timeLeft: 1800 });
    assert.equal(states.at(-1)!.ac, true);
  });

  test("set-brightness and step go through the session's SetBrightness", async () => {
    assert.equal((await power.call("set-brightness", { brightness: 0.3 }))!.brightness.value, 0.3);
    assert.equal(readFileSync(join(dir, "amdgpu_bl1", "brightness"), "utf8").trim(), "300");
    assert.equal((await power.call("step", { by: -0.1 }))!.brightness.value, 0.2);
    // Never quite off.
    assert.equal((await power.call("set-brightness", { brightness: 0 }))!.brightness.value, 0.01);
    assert.ok(done.includes("SetBrightness backlight amdgpu_bl1 300"));
    await assert.rejects(power.call("set-brightness", { brightness: "dim" }), { status: 400 });
  });

  test("a change made elsewhere is read again", async () => {
    writeFileSync(join(dir, "amdgpu_bl1", "brightness"), "800\n");
    const deadline = Date.now() + 3_000;
    while (states.at(-1)?.brightness.value !== 0.8 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(states.at(-1)!.brightness.value, 0.8);
  });

  test("suspend, reboot, power off (refused here) and log out", async () => {
    await power.call("suspend", {});
    await power.call("reboot", {});
    await assert.rejects(power.call("power-off", {}), { status: 403, message: /Interactive authentication required/ });
    await power.call("log-out", {});
    assert.deepEqual(done.filter((name) => !name.startsWith("SetBrightness")), ["Suspend", "Reboot"]);
    assert.equal(loggedOut, 1);
    await assert.rejects(power.call("hibernate", {}), { status: 404 });
  });
});

describe("power service on a desktop", () => {
  test("no battery, no backlight, no log out", async () => {
    const bus = await FakeBus.start();
    const dir = mkdtempSync(join(tmpdir(), "plutonium-power-"));
    try {
      bus.serveObject("org.freedesktop.UPower", "/org/freedesktop/UPower", object({ "org.freedesktop.UPower": { OnBattery: ["b", false] } }));
      bus.serveObject("org.freedesktop.UPower", "/org/freedesktop/UPower/devices/DisplayDevice", object({
        "org.freedesktop.UPower.Device": { Type: ["u", 0], IsPresent: ["b", false] },
      }));
      const power = new PowerService({ address: bus.address, backlights: dir });
      await power.start(() => {});
      const state = await power.state();
      assert.equal(state.battery, null);
      assert.equal(state.ac, true);
      assert.deepEqual(state.brightness, { available: false, value: 0 });
      assert.equal(state.can.logOut, "na");
      await assert.rejects(power.call("step", { by: 0.1 }), { status: 404 });
      await assert.rejects(power.call("log-out", {}), { status: 404 });
      power.stop();
    } finally {
      await bus.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
