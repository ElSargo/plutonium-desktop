// Stands in for `systemd-socket-activate -E … -l <socket> <satellite> :N
// -listenfd 3`: holds the X socket until it is stopped, in one process (as
// the real one does: it execs the satellite on the first connection). Its
// command line keeps the display, which is how the helper recognizes it.
import { appendFileSync } from "node:fs";
import { createServer } from "node:net";

const args = process.argv.slice(2);
const socketPath = args[args.indexOf("-l") + 1];
if (!socketPath) throw new Error("fake-activate: no -l <socket>");

// Each start, for tests that count them.
if (process.env.FAKE_ACTIVATE_LOG) {
  appendFileSync(process.env.FAKE_ACTIVATE_LOG, `${process.pid} ${args.find((arg) => arg.startsWith(":"))}\n`);
}

const server = createServer((socket) => socket.end());
server.listen(socketPath);
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
