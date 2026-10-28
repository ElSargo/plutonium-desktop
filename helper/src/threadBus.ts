// Each thread's session bus: a proxy (threadbus.py) in front of the user's
// session bus, so single-instance apps get an instance per thread. Flatpak
// LibreOffice hands a second start's arguments to whoever owns
// org.libreoffice.LibreOfficeIpc0, a GApplication to whoever owns its app id,
// in any session and thread; behind the proxy, the names a thread's apps own
// are their own (NAME._pl<tag> on the bus), and everything else, the
// desktop's portals, notifications, MPRIS, secrets and accessibility, is as
// it was.
//
// Two LibreOffices on one profile restart each other in a loop (it relies on
// its IPC to keep to one), so a thread's LibreOffice also gets a profile of
// its own (UserInstallation, which it reads from the environment too), a
// copy of the user's made the first time: $SYSUSERCONFIG/libreoffice/
// plutonium/<tag>, in the Flatpak's config or the host's. A host
// LibreOffice's IPC is a pipe named after its profile, so that separates it.
//
// Like the threads' X servers, a proxy is socket-activated (python starts on
// the first connection) and outlives the helper; the next helper finds it by
// its pid file.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "threadbus.py");

export interface ThreadBusOptions {
  /** Where the sockets and pid files go. */
  readonly dir: string;
  /** The user's session bus (default DBUS_SESSION_BUS_ADDRESS). */
  readonly upstream?: string;
  /** systemd-socket-activate. */
  readonly activate: string;
  readonly python?: string;
  /** Where LibreOffice's profiles are: the Flatpak's and the host's config (tests use their own). */
  readonly libreOfficeConfigs?: readonly string[];
}

/** The suffix a thread's names get on the bus. */
export function threadBusTag(threadId: string): string {
  return createHash("sha256").update(threadId).digest("hex").slice(0, 12);
}

export class ThreadBuses {
  private readonly options: ThreadBusOptions;
  private readonly addresses = new Map<string, string>();

  constructor(options: ThreadBusOptions) {
    this.options = options;
  }

  /** The variables that give `threadId`'s apps their own bus and LibreOffice profile; none without a bus. */
  environment(threadId: string, threadVariable: string): Record<string, string> {
    const address = this.address(threadId, threadVariable);
    if (!address) return {};
    const tag = threadBusTag(threadId);
    this.seedLibreOffice(tag);
    return { DBUS_SESSION_BUS_ADDRESS: address, UserInstallation: `$SYSUSERCONFIG/libreoffice/plutonium/${tag}` };
  }

  /** Copies the user's LibreOffice profiles for the thread, where it has none yet. */
  private seedLibreOffice(tag: string): void {
    const configs = this.options.libreOfficeConfigs ?? [
      join(homedir(), ".var", "app", "org.libreoffice.LibreOffice", "config"),
      process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    ];
    for (const config of configs) {
      const source = join(config, "libreoffice", "4");
      const target = join(config, "libreoffice", "plutonium", tag);
      if (!existsSync(source) || existsSync(target)) continue;
      try {
        cpSync(source, target, { recursive: true, filter: (path) => !path.endsWith("/.lock") });
      } catch (error) {
        console.error(`plutoniumd: could not copy the LibreOffice profile ${source}: ${(error as Error).message}`);
      }
    }
  }

  /** `threadId`'s DBUS_SESSION_BUS_ADDRESS, its proxy started if need be; undefined without one. */
  address(threadId: string, threadVariable: string): string | undefined {
    const known = this.addresses.get(threadId);
    if (known) return known;
    const upstream = this.options.upstream ?? process.env.DBUS_SESSION_BUS_ADDRESS;
    if (!upstream) return undefined;
    const tag = threadBusTag(threadId);
    const socket = join(this.options.dir, `${tag}.sock`);
    const pidFile = join(this.options.dir, `${tag}.pid`);
    if (!running(pidFile, threadVariable, threadId) || !existsSync(socket)) {
      try {
        mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
        if (existsSync(socket)) unlinkSync(socket);
        const child = spawn(
          this.options.activate,
          [
            ...["DBUS_SESSION_BUS_ADDRESS", threadVariable, "PATH"].flatMap((name) => ["-E", name]),
            "-l",
            socket,
            this.options.python ?? "python3",
            "-I",
            SCRIPT,
            tag,
          ],
          {
            env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: upstream, [threadVariable]: threadId },
            stdio: "ignore",
            // Its thread's apps keep their bus when the helper stops.
            detached: true,
          },
        );
        child.once("error", (error) => console.error(`plutoniumd: thread ${threadId}'s bus: ${error.message}`));
        if (child.pid === undefined) return undefined;
        child.unref();
        writeFileSync(pidFile, `${child.pid}\n`);
        if (!waitForSocket(socket)) {
          console.error(`plutoniumd: thread ${threadId}'s bus didn't start; its apps use the session bus`);
          return undefined;
        }
      } catch (error) {
        console.error(`plutoniumd: could not start thread ${threadId}'s bus: ${(error as Error).message}`);
        return undefined;
      }
    }
    const address = `unix:path=${socket}`;
    this.addresses.set(threadId, address);
    return address;
  }
}

/** Whether the pid file names a live proxy (or its activator) of `threadId`. */
function running(pidFile: string, threadVariable: string, threadId: string): boolean {
  try {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 1) return false;
    const environ = readFileSync(`/proc/${pid}/environ`, "latin1").split("\0");
    return environ.includes(`${threadVariable}=${threadId}`) && readFileSync(`/proc/${pid}/cmdline`, "latin1").includes("threadbus.py");
  } catch {
    return false;
  }
}

/** The activator binds its socket right away; an app given the address before then would find no bus. */
function waitForSocket(socket: string): boolean {
  const deadline = Date.now() + 2_000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(socket)) {
    if (Date.now() > deadline) return false;
    Atomics.wait(pause, 0, 0, 10);
  }
  return true;
}
