import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DBusConnection } from "../src/dbus.ts";
import { findExecutable, THREAD_ID_VARIABLE } from "../src/threads.ts";
import { threadBusTag, ThreadBuses } from "../src/threadBus.ts";

const FD_SCRIPT = fileURLToPath(new URL("./fixtures/busfd.py", import.meta.url));
const NAME = "org.libreoffice.LibreOfficeIpc0";
const PRIMARY_OWNER = 1;
const EXISTS = 3;

const bus = (connection: DBusConnection, member: string, signature = "", body: unknown[] = []) =>
  connection.call({
    destination: "org.freedesktop.DBus",
    path: "/org/freedesktop/DBus",
    interface: "org.freedesktop.DBus",
    member,
    signature,
    body,
  });

describe("thread session buses", () => {
  let daemon: ChildProcess | undefined;
  let address = "";
  let dir: string;
  let buses: ThreadBuses;
  const activate = findExecutable("systemd-socket-activate");
  const open: DBusConnection[] = [];
  const connect = async (where: string) => {
    const connection = await DBusConnection.connect(where);
    open.push(connection);
    return connection;
  };

  before(async () => {
    if (!activate || !findExecutable("dbus-daemon")) return;
    dir = mkdtempSync(join(tmpdir(), "plutonium-bus-"));
    daemon = spawn("dbus-daemon", ["--session", "--nofork", "--print-address=1"], { stdio: ["ignore", "pipe", "ignore"] });
    address = await new Promise<string>((resolve) => daemon!.stdout!.once("data", (data: Buffer) => resolve(data.toString().trim())));
    buses = new ThreadBuses({ dir, upstream: address, activate });
  });

  after(() => {
    for (const connection of open) connection.close();
    for (const tag of ["thread-a", "thread-b"].map(threadBusTag)) {
      try {
        process.kill(Number(readFileSync(join(dir, `${tag}.pid`), "utf8")));
      } catch {
        // Not started.
      }
    }
    daemon?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("a name each thread's app owns is that thread's own", async (t) => {
    if (!daemon) return t.skip("no dbus-daemon or systemd-socket-activate");
    const a = buses.address("thread-a", THREAD_ID_VARIABLE)!;
    const b = buses.address("thread-b", THREAD_ID_VARIABLE)!;
    assert.notEqual(a, b);
    assert.equal(buses.address("thread-a", THREAD_ID_VARIABLE), a, "one bus per thread");

    // The desktop's instance, and one in each thread: all primary owners.
    const desktop = await connect(address);
    assert.deepEqual(await bus(desktop, "RequestName", "su", [NAME, 4]), [PRIMARY_OWNER]);
    const first = await connect(a);
    assert.deepEqual(await bus(first, "RequestName", "su", [NAME, 4]), [PRIMARY_OWNER]);
    const other = await connect(b);
    assert.deepEqual(await bus(other, "RequestName", "su", [NAME, 4]), [PRIMARY_OWNER]);

    // A second start in thread A finds thread A's instance.
    const second = await connect(a);
    assert.deepEqual(await bus(second, "RequestName", "su", [NAME, 4]), [EXISTS]);
    const [owner] = (await bus(second, "GetNameOwner", "s", [NAME])) as [string];
    const [ownerOnBus] = (await bus(desktop, "GetNameOwner", "s", [`${NAME}._pl${threadBusTag("thread-a")}`])) as [string];
    assert.equal(owner, ownerOnBus, "the owner is thread A's app");

    // Thread A sees its name as the app owns it; the bus has it suffixed.
    const [seen] = (await bus(second, "ListNames")) as [string[]];
    assert.ok(seen.includes(NAME));
    assert.ok(!seen.includes(`${NAME}._pl${threadBusTag("thread-a")}`));
    const [all] = (await bus(desktop, "ListNames")) as [string[]];
    assert.ok(all.includes(`${NAME}._pl${threadBusTag("thread-b")}`));

    // Desktop services stay the desktop's.
    assert.deepEqual(await bus(desktop, "RequestName", "su", ["org.freedesktop.Notifications", 4]), [PRIMARY_OWNER]);
    assert.deepEqual(await bus(second, "NameHasOwner", "s", ["org.freedesktop.Notifications"]), [true]);
  });

  test("fds pass through", async (t) => {
    if (!daemon) return t.skip("no dbus-daemon or systemd-socket-activate");
    const a = buses.address("thread-a", THREAD_ID_VARIABLE)!;
    // A desktop service gets a thread's app's fd.
    const service = spawn("python3", ["-I", FD_SCRIPT, "serve", address, "org.example.Desk"], { stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    service.stdout!.on("data", (data: Buffer) => (output += data.toString()));
    try {
      const deadline = Date.now() + 5_000;
      while (!output.includes("ready") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      const sent = spawnSync("python3", ["-I", FD_SCRIPT, "send", a, "org.example.Desk", "through the pipe"], { timeout: 5_000 });
      assert.equal(sent.status, 0, sent.stderr?.toString());
      while (!output.includes("through the pipe") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.match(output, /through the pipe/);
    } finally {
      service.kill();
    }
  });

  test("a thread's LibreOffice gets a copy of the user's profile", async (t) => {
    if (!daemon) return t.skip("no dbus-daemon or systemd-socket-activate");
    const config = join(dir, "config");
    mkdirSync(join(config, "libreoffice", "4", "user"), { recursive: true });
    writeFileSync(join(config, "libreoffice", "4", "user", "registrymodifications.xcu"), "<settings/>");
    writeFileSync(join(config, "libreoffice", "4", ".lock"), "held");
    const seeded = new ThreadBuses({ dir, upstream: address, activate: activate!, libreOfficeConfigs: [config, join(dir, "none")] });
    const environment = seeded.environment("thread-a", THREAD_ID_VARIABLE);
    const tag = threadBusTag("thread-a");
    assert.equal(environment.UserInstallation, `$SYSUSERCONFIG/libreoffice/plutonium/${tag}`);
    assert.match(environment.DBUS_SESSION_BUS_ADDRESS!, /^unix:path=/);
    const copy = join(config, "libreoffice", "plutonium", tag);
    assert.equal(readFileSync(join(copy, "user", "registrymodifications.xcu"), "utf8"), "<settings/>");
    assert.equal(existsSync(join(copy, ".lock")), false, "not the user's lock");
    // Made once: the thread's own changes stay.
    writeFileSync(join(copy, "user", "registrymodifications.xcu"), "<mine/>");
    new ThreadBuses({ dir, upstream: address, activate: activate!, libreOfficeConfigs: [config] }).environment("thread-a", THREAD_ID_VARIABLE);
    assert.equal(readFileSync(join(copy, "user", "registrymodifications.xcu"), "utf8"), "<mine/>");
  });
});

