// The process a shell's native side runs in (shellNative.ts): loads the
// shell's module ("native" in its shell.json) and runs its exported functions
// for the shell's page. Talks to the helper over Node's IPC channel, so the
// module's console output only goes to the shell's log.
//
//   node nativeHost.ts <module> <shell name> <data dir>
//
// The module: `export async function <name>(args, context)` for each call
// the page makes; an optional `export function start(context)` runs once.
// context: { shell, dataDir, emit(event, detail) }.
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [path, shell, dataDir] = process.argv.slice(2) as [string, string, string];
mkdirSync(dataDir, { recursive: true });
const send = (message: unknown) => process.send?.(message);
const context = {
  shell,
  dataDir,
  /** Sends an event to the shell's pages (shell.native's `event`). */
  emit(event: string, detail?: unknown) {
    send({ event, detail: detail ?? null });
  },
};

type NativeModule = Record<string, unknown>;
let module: NativeModule;
try {
  module = (await import(pathToFileURL(path).href)) as NativeModule;
  if (typeof module.start === "function") await (module.start as (c: typeof context) => unknown)(context);
  send({ ready: true });
} catch (error) {
  send({ failed: String((error as Error)?.stack ?? error) });
  process.exit(1);
}

process.on("message", async (message: { id: number; method: string; args: unknown }) => {
  const { id, method, args } = message;
  const fn = module[method];
  if (method === "start" || typeof fn !== "function") {
    send({ id, error: `The native side has no function "${method}".`, missing: true });
    return;
  }
  try {
    send({ id, value: (await (fn as (a: unknown, c: typeof context) => unknown)(args, context)) ?? null });
  } catch (error) {
    send({ id, error: String((error as Error)?.message ?? error) });
  }
});
// The helper went away: so does the native side.
process.on("disconnect", () => process.exit(0));
