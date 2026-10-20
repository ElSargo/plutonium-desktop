import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  DBusConnection,
  DBusError,
  decodeMessage,
  encodeMessage,
  METHOD_CALL,
  messageLength,
  splitSignature,
} from "../src/dbus.ts";
import { FakeBus } from "./fixtures/fakeBus.ts";

describe("dbus marshalling", () => {
  test("splits signatures into complete types", () => {
    assert.deepEqual(splitSignature("sa{sv}(iiii)aau"), ["s", "a{sv}", "(iiii)", "aau"]);
    assert.deepEqual(splitSignature(""), []);
    assert.throws(() => splitSignature("(ii"), /Bad signature/);
    assert.throws(() => splitSignature("z"), /Bad signature/);
  });

  test("a message comes back as it went", () => {
    const body = [
      "text",
      7,
      -3,
      true,
      0.25,
      [1, 2, 3],
      new Map<string, unknown>([
        ["Name", ["s", "Save"]],
        ["Count", ["i", 4]],
      ]),
      [10, -20, 30, 40],
      [["org.a11y", "/org/a11y/atspi/1"]],
      ["(so)", [":1.5", "/x"]],
    ];
    const signature = "suibdaua{sv}(iiii)a(so)v";
    const buffer = encodeMessage({
      type: METHOD_CALL,
      serial: 42,
      path: "/org/a11y/atspi/accessible/root",
      interface: "org.a11y.atspi.Accessible",
      member: "GetChildren",
      destination: ":1.9",
      signature,
      body,
    });
    assert.equal(messageLength(buffer), buffer.length);
    assert.equal(messageLength(buffer.subarray(0, 10)), undefined);
    const message = decodeMessage(buffer);
    assert.equal(message.type, METHOD_CALL);
    assert.equal(message.serial, 42);
    assert.equal(message.path, "/org/a11y/atspi/accessible/root");
    assert.equal(message.member, "GetChildren");
    assert.equal(message.destination, ":1.9");
    assert.equal(message.signature, signature);
    // Variants come back as their values.
    assert.deepEqual(message.body, [
      "text",
      7,
      -3,
      true,
      0.25,
      [1, 2, 3],
      new Map<string, unknown>([
        ["Name", "Save"],
        ["Count", 4],
      ]),
      [10, -20, 30, 40],
      [["org.a11y", "/org/a11y/atspi/1"]],
      [":1.5", "/x"],
    ]);
  });

  test("reads big-endian messages too", () => {
    // A method return with one string, as a big-endian peer sends it.
    const fields = Buffer.from([
      // a(yv) of 2 fields: REPLY_SERIAL u 7, SIGNATURE g "s"
      5, 1, 0x75, 0, 0, 0, 0, 7, // (y=5, v: sig "u", pad, u32 7)
      8, 1, 0x67, 0, 1, 0x73, 0, // (y=8, v: sig "g", "s")
    ]);
    const header = Buffer.alloc(16);
    header.write("B", 0, "latin1");
    header[1] = 2;
    header[3] = 1;
    const text = Buffer.concat([Buffer.from([0, 0, 0, 2]), Buffer.from("hi\0")]);
    header.writeUInt32BE(text.length, 4);
    header.writeUInt32BE(9, 8);
    header.writeUInt32BE(fields.length, 12);
    const padding = Buffer.alloc((8 - ((16 + fields.length) % 8)) % 8);
    const buffer = Buffer.concat([header, fields, padding, text]);
    assert.equal(messageLength(buffer), buffer.length);
    const message = decodeMessage(buffer);
    assert.equal(message.replySerial, 7);
    assert.deepEqual(message.body, ["hi"]);
  });
});

describe("DBusConnection", () => {
  let bus: FakeBus;
  before(async () => {
    bus = await FakeBus.start();
  });
  after(() => bus.stop());

  test("authenticates, says Hello and calls", async () => {
    const connection = await DBusConnection.connect(bus.address);
    try {
      assert.match(connection.name, /^:1\.\d+$/);
      const [address] = await connection.call({
        destination: "org.a11y.Bus",
        path: "/org/a11y/bus",
        interface: "org.a11y.Bus",
        member: "GetAddress",
      });
      assert.equal(address, bus.address);
    } finally {
      connection.close();
    }
  });

  test("an error reply rejects with its name", async () => {
    const connection = await DBusConnection.connect(bus.address);
    try {
      await assert.rejects(
        connection.call({
          destination: "org.freedesktop.DBus",
          path: "/org/freedesktop/DBus",
          interface: "org.freedesktop.DBus",
          member: "GetConnectionUnixProcessID",
          signature: "s",
          body: [":1.999"],
        }),
        (error: unknown) => error instanceof DBusError && error.errorName === "org.freedesktop.DBus.Error.NameHasNoOwner",
      );
      // Still usable.
      assert.ok(connection.isOpen);
    } finally {
      connection.close();
    }
  });

  test("calls fail once the bus goes away", async () => {
    const other = await FakeBus.start();
    const connection = await DBusConnection.connect(other.address);
    await other.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(connection.isOpen, false);
    await assert.rejects(
      connection.call({ destination: "x", path: "/", interface: "x", member: "y" }),
      /closed/,
    );
  });
});
