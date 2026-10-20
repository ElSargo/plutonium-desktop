import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  rememberLaunch,
  showsForPids,
  stopXDisplays,
  threadForPid,
  threadsForPids,
  Threads,
  wantsShow,
  type XDisplayOptions,
} from "../src/threads.ts";

const FAKE_ACTIVATE = fileURLToPath(new URL("./fixtures/fake-activate.ts", import.meta.url));
const WAYLAND = "wayland-plutonium-test";

async function waitFor(what: string, check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("thread environment", () => {
  test("binds a thread's apps to Exo, the thread and the helper", () => {
    const threads = new Threads(WAYLAND, "/tmp/nowhere/helper.sock", {
      statePath: join(tmpdir(), `plutonium-no-state-${process.pid}.json`),
      satellite: "",
    });
    const environment = threads.environment("t3:thread/one");
    assert.equal(environment.PLUTONIUM_THREAD_ID, "t3:thread/one");
    assert.equal(environment.PLUTONIUM_HELPER, "/tmp/nowhere/helper.sock");
    assert.equal(environment.WAYLAND_DISPLAY, WAYLAND);
    assert.equal(environment.GDK_BACKEND, "wayland");
    assert.equal(environment.QT_QPA_PLATFORM, "wayland");
    // Electron on Wayland: the hint for older ones, the session type for 38+.
    assert.equal(environment.ELECTRON_OZONE_PLATFORM_HINT, "wayland");
    assert.equal(environment.XDG_SESSION_TYPE, "wayland");
    assert.equal(environment.PLUTONIUM_SHOW, undefined);
    // No xwayland-satellite: no DISPLAY (not the host's either).
    assert.equal(environment.DISPLAY, undefined);
    assert.equal(threads.environment("t", { show: true }).PLUTONIUM_SHOW, "1");
    threads.shutdown();
  });

  test("PLUTONIUM_SHOW", () => {
    assert.equal(wantsShow({ PLUTONIUM_SHOW: "1" }), true);
    assert.equal(wantsShow({ PLUTONIUM_SHOW: "0" }), false);
    assert.equal(wantsShow({}), false);
  });
});

describe("thread X displays", () => {
  let dir: string;
  let options: XDisplayOptions & { statePath: string };
  let log: string;
  const running: Threads[] = [];
  const children: ChildProcess[] = [];

  const helper = (extra: Partial<XDisplayOptions> = {}) => {
    const threads = new Threads(WAYLAND, join(dir, "helper.sock"), { ...options, ...extra });
    running.push(threads);
    return threads;
  };
  const starts = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
  const state = () => JSON.parse(readFileSync(options.statePath, "utf8"));
  const socket = (display: number) => join(dir, "x11", `X${display}`);
  /** A process of `threadId` that uses `display`, as an app started before would. */
  const user = (threadId: string, display: string) => {
    const child = spawn("sleep", ["60"], {
      env: { PATH: process.env.PATH, PLUTONIUM_THREAD_ID: threadId, DISPLAY: display },
      stdio: "ignore",
    });
    children.push(child);
    return child;
  };

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "plutonium-x-"));
    mkdirSync(join(dir, "x11"));
    // systemd-socket-activate's stand-in, as an executable.
    const activate = join(dir, "activate");
    writeFileSync(activate, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_ACTIVATE}" "$@"\n`);
    chmodSync(activate, 0o755);
    log = join(dir, "starts.log");
    process.env.FAKE_ACTIVATE_LOG = log;
    options = {
      statePath: join(dir, "x-displays.json"),
      satellite: "/fake/xwayland-satellite",
      activate,
      socketDir: join(dir, "x11"),
      lockDir: dir,
      first: 210,
      last: 219,
      adoptedCheckMs: 100,
    };
  });

  afterEach(() => {
    for (const threads of running.splice(0)) threads.shutdown();
    stopXDisplays(options.statePath, options);
    // And any the state file no longer names.
    for (const line of starts()) {
      try {
        process.kill(Number(line.split(" ")[0]));
      } catch {
        // Stopped.
      }
    }
    rmSync(options.statePath, { force: true });
    rmSync(log, { force: true });
    for (const child of children.splice(0)) child.kill();
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  test("a thread gets its own display, kept in the state file", async () => {
    const threads = helper();
    const display = threads.environment("one").DISPLAY;
    assert.equal(display, ":210");
    assert.equal(threads.environment("one").DISPLAY, ":210", "the same one each time");
    assert.equal(threads.environment("two").DISPLAY, ":211");
    await waitFor("the X sockets", () => existsSync(socket(210)) && existsSync(socket(211)));
    const saved = state();
    assert.equal(saved.waylandDisplay, WAYLAND);
    assert.equal(saved.displays.one.display, 210);
    // The lock names the satellite, as an X server's does.
    assert.equal(Number(readFileSync(join(dir, ".X210-lock"), "utf8").trim()), saved.displays.one.pid);
    assert.equal(starts().length, 2);
  });

  test("a restarted helper takes over the satellites that still run", async () => {
    const first = helper();
    assert.equal(first.environment("one").DISPLAY, ":210");
    await waitFor("the X socket", () => existsSync(socket(210)));
    const { pid } = state().displays.one;
    first.shutdown();
    assert.ok(alive(pid), "the satellite outlives the helper");

    const second = helper();
    assert.deepEqual(second.displays(), { one: 210 });
    assert.equal(second.environment("one").DISPLAY, ":210");
    assert.equal(starts().length, 1, "no second satellite");
    assert.equal(state().displays.one.pid, pid);
  });

  test("an adopted satellite that ends is started again while the thread uses it", async () => {
    const first = helper();
    first.environment("one");
    await waitFor("the X socket", () => existsSync(socket(210)));
    const { pid } = state().displays.one;
    first.shutdown();
    const second = helper();
    user("one", ":210");
    await new Promise((resolve) => setTimeout(resolve, 100));

    process.kill(pid);
    // Noticed by the check, then started again a second later on the same display.
    await waitFor("a new satellite", () => starts().length === 2 && existsSync(socket(210)), 5_000);
    assert.notEqual(state().displays.one.pid, pid);
    assert.equal(state().displays.one.display, 210);
    assert.deepEqual(second.displays(), { one: 210 });
  });

  test("a satellite that ends and that nobody uses is dropped", async () => {
    const threads = helper();
    threads.environment("one");
    await waitFor("the X socket", () => existsSync(socket(210)));
    process.kill(state().displays.one.pid);
    await waitFor("it to be dropped", () => state().displays.one === undefined, 5_000);
    assert.deepEqual(threads.displays(), {});
    assert.equal(starts().length, 1);
    assert.equal(existsSync(join(dir, ".X210-lock")), false, "its files are released");
  });

  test("plutonium stop: stopped satellites start again for the processes that use them", async () => {
    const first = helper();
    first.environment("used");
    first.environment("unused");
    await waitFor("the X sockets", () => existsSync(socket(210)) && existsSync(socket(211)));
    first.shutdown();
    assert.equal(stopXDisplays(options.statePath, options), 2);
    assert.equal(existsSync(socket(210)), false);
    // The map stays for the next helper.
    assert.deepEqual(Object.keys(state().displays).sort(), ["unused", "used"]);

    user("used", ":210");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = helper();
    assert.deepEqual(second.displays(), { used: 210 });
    assert.deepEqual(Object.keys(state().displays), ["used"]);
    await waitFor("the satellite again", () => existsSync(socket(210)));
    // A new thread doesn't take the number back.
    assert.equal(second.environment("new").DISPLAY, ":211");
  });

  test("plutonium stop: satellites that ended by themselves leave no files", async () => {
    // Exo went away first: the satellites end, and the helper stops before it
    // notices (it checks on adopted ones now and then).
    const first = helper();
    first.environment("one");
    await waitFor("the X socket", () => existsSync(socket(210)));
    first.shutdown();
    const second = helper({ adoptedCheckMs: 60_000 });
    assert.deepEqual(second.displays(), { one: 210 });
    const { pid } = state().displays.one;
    // As the satellite would leave them: killed without cleaning up.
    process.kill(pid, "SIGKILL");
    await waitFor("it to end", () => !alive(pid));
    assert.ok(existsSync(socket(210)) && existsSync(join(dir, ".X210-lock")));
    second.shutdown();
    assert.equal(stopXDisplays(options.statePath, options), 0);
    assert.equal(existsSync(socket(210)), false);
    assert.equal(existsSync(join(dir, ".X210-lock")), false);
  });

  test("a state file for another Wayland display is left alone", async () => {
    writeFileSync(options.statePath, JSON.stringify({ waylandDisplay: "wayland-other", displays: { one: { display: 210, pid: 1 } } }));
    const threads = helper();
    assert.deepEqual(threads.displays(), {});
    // Unreadable state is no state.
    writeFileSync(options.statePath, "{");
    assert.deepEqual(helper().displays(), {});
  });
});

describe("pid → thread", () => {
  const children: ChildProcess[] = [];
  const grandchildren: number[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
    for (const pid of grandchildren.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Gone.
      }
    }
  });
  const start = (command: string, args: string[], env: NodeJS.ProcessEnv) => {
    const child = spawn(command, args, { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "ignore"] });
    children.push(child);
    return child;
  };
  const isSleep = (pid: number) => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "latin1").startsWith("sleep");
    } catch {
      return false;
    }
  };
  /** The pid the shell `child` prints for its own child. */
  const grandchildOf = (child: ChildProcess) =>
    new Promise<number>((resolve) =>
      child.stdout!.once("data", (data: Buffer) => {
        const pid = Number(data.toString().trim());
        grandchildren.push(pid);
        resolve(pid);
      }),
    );

  test("from the process's own environment", async () => {
    const child = start("sleep", ["30"], { PLUTONIUM_THREAD_ID: "t-own", PLUTONIUM_SHOW: "1" });
    await new Promise((resolve) => child.once("spawn", resolve));
    assert.equal(threadForPid(child.pid!), "t-own");
    assert.deepEqual(threadsForPids([child.pid!]), { [child.pid!]: "t-own" });
    assert.deepEqual(showsForPids([child.pid!]), { [child.pid!]: true });
  });

  test("from the nearest tagged ancestor, for apps that clear their environment", async () => {
    // A tagged shell whose child has an empty environment.
    const shell = start("sh", ["-c", "env -i sleep 30 & echo $!; wait"], { PLUTONIUM_THREAD_ID: "t-parent" });
    const grandchild = await grandchildOf(shell);
    await waitFor("the child", () => isSleep(grandchild));
    assert.equal(readFileSync(`/proc/${grandchild}/environ`, "latin1"), "");
    assert.equal(threadForPid(grandchild), "t-parent");
    assert.deepEqual(showsForPids([grandchild]), {});
  });

  test("from what the helper started, when an app blanks its environment", async () => {
    // As Electron 43 does: nothing in /proc/<pid>/environ, and its parent
    // (the helper) isn't in any thread.
    const child = start("sleep", ["30"], {});
    await new Promise((resolve) => child.once("spawn", resolve));
    rememberLaunch(child, "t-launched", true);
    assert.equal(threadForPid(child.pid!), "t-launched");
    // Its own children too.
    const shell = start("sh", ["-c", "env -i sleep 30 & echo $!; wait"], {});
    rememberLaunch(shell, "t-launched", false);
    const grandchild = await grandchildOf(shell);
    await waitFor("the child", () => isSleep(grandchild));
    assert.equal(threadForPid(grandchild), "t-launched");
    assert.deepEqual(showsForPids([child.pid!, grandchild]), { [child.pid!]: true });
    // Forgotten once it exits.
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    assert.equal(threadForPid(child.pid!), undefined);
  });

  test("not a process", () => {
    assert.equal(threadForPid(0), undefined);
    assert.equal(threadForPid(1), undefined);
    assert.equal(threadForPid(-5), undefined);
    assert.equal(threadForPid(2 ** 30), undefined);
  });
});
