# Desktop services for shells

What users expect of any desktop (volume, brightness, battery, Wi-Fi,
Bluetooth, media, notifications), for every shell to show its own way. The
helper does the work over the host's usual services (PipeWire, D-Bus: logind,
UPower, NetworkManager, BlueZ, MPRIS); a shell only draws it. ChromeOS's own
system tray isn't used: it needs ChromeOS daemons (cras, shill) that a Linux
desktop doesn't have.

## For shells

```js
const shell = connect();
const audio = shell.system.audio;          // a SystemService
await audio.ready;                         // its first state (throws if it can't be used)
show(audio.state);
audio.addEventListener("change", (event) => show(event.detail));
await audio.call("set-volume", { device: id, volume: 0.4 });
await shell.system.available();            // [{ name, allowed }]: what this helper has
```

- Each service has a **state** (JSON), sent again whenever it changes, and
  **actions**. Each one's state and actions are listed below.
- **An installed shell names what it uses** in its `shell.json`:
  `"uses": ["audio", "power"]`. It gets only those (403 otherwise); a page that
  isn't an installed shell (a URL given to `plutonium run`) gets them all.
  The names: `audio`, `power`, `network`, `bluetooth`, `media`,
  `notifications`, `session`.
- A service the computer doesn't have (no NetworkManager, no battery) answers
  its state with what's there (`{ available: false }` or an empty list), not an
  error, so a shell can hide its control.

## In the helper

`helper/src/services.ts`: a `DesktopService` is `{ name, start(changed),
state(), call(action, args), stop?() }`. `DesktopServices` starts one on a
shell's first use, sends its changes to the shells that may use it (the `system`
notice on the shell's request stream), and stops them with the helper. One file
per service (`helper/src/services/<name>.ts`), registered in the daemon's
constructor; unit tests against a fake (the fake D-Bus in
`test/fixtures/fakeBus.ts`, a fake `wpctl`).

The routes (shell origins only, like the rest of `/v1/shell/`):

| | |
|---|---|
| `GET /v1/shell/system` | `{ services: [{ name, allowed }] }` |
| `GET /v1/shell/system/<name>` | its state |
| `POST /v1/shell/system/<name>/<action>` | JSON args → `{ value }` |

Errors: 403 (not in `uses`), 404 (no such service or action), 400 (bad args).

## A native side and storage

Between a static page and a whole server, for a shell that needs the computer
(read files, run a command, keep a database) or keeps settings.

**Storage**, every installed shell's: JSON values by key, kept in
`~/.pluto/data/<name>/storage/<key>.json`: outside the shell's git repository,
so rolling back an edit doesn't lose them, and the same in every slot (unlike
`localStorage`, whose origin has the slot's port).

```js
await shell.storage.set("prefs", { dock: "left" });
await shell.storage.get("prefs");          // undefined when there's none
await shell.storage.keys(); await shell.storage.delete("prefs");
```

**The native side**: `"native": "native.js"` in `shell.json`. The helper runs
the module in its own Node process (as the user: like a server shell, it can
do anything you can, and Add a shell says it runs it), starts it on the
page's first call, stops it when the shell is edited or turned off (the next
call starts the new version), and starts it again after a crash. Its output
goes to `~/.pluto/logs/<name>.log`.

```js
// native.js: each exported function is something the page can call.
import { readdir } from "node:fs/promises";
export function start(context) { /* optional, once: watch something, context.emit("changed", …) */ }
export async function listNotes({ folder }, context) { return readdir(folder); }
// context: { shell, dataDir (~/.pluto/data/<name>), emit(event, detail) }
```

```js
// The page.
const notes = await shell.native.call("listNotes", { folder: "/home/me/notes" });
shell.native.addEventListener("changed", (event) => show(event.detail));
```

A call takes up to 60 s; a function that throws rejects the page's call with
its message. Routes: `POST /v1/shell/native/<function>` (JSON args →
`{ value }`), `GET /v1/shell/storage` (`{ keys }`), `GET|PUT|DELETE
/v1/shell/storage/<key>` (`{ value }`); for installed shells only (403
otherwise). Code: `helper/src/shellNative.ts`, `nativeHost.ts`; tests
`helper/test/shellNative.test.ts`, and checked against a scratch helper (a
call, storage, CORS, another origin refused).

## The services

Each section: its state, its actions, what it uses on the host, and how it was
tested. (Filled in as each lands; see the backlog, "Desktop services for
shells".)

### notifications

The helper is the session's notification server (`org.freedesktop.Notifications`
on the session bus: `notify-send`, GTK, Qt, Electron and Chromium-based apps).
It takes the name only if nothing else has it (a notification daemon you run
keeps it), and serves from the helper's start, so apps' notifications are kept
while no shell shows them.

- **State:** `{ notifications: [{ id, app, icon, summary, body, actions: [{ key,
  label }], urgency: "low" | "normal" | "critical", desktopEntry?, transient,
  time }], doNotDisturb }`, newest first, up to 100. A notification stays until
  it's dismissed, its app closes it, or its own timeout (if it set one) ends.
- **Actions:** `dismiss {id}`, `invoke {id, action}` (the app gets
  `ActionInvoked`; `"default"` is a click on it), `clear`,
  `set-do-not-disturb {on}`.
- **Popups:** the library pops up new ones in the visible shell (top right; a
  few seconds, critical ones until closed; not in do not disturb unless
  critical). `connect({ notificationPopups: false })` turns them off, for a
  shell that draws its own; a function draws each one itself. The shipped
  shells use it (`"uses": ["notifications"]`).
- **Tested:** `helper/test/notifications.test.ts`: parsing, the list
  (replace, dismiss, invoke, clear, expiry, do not disturb), and a real
  `notify-send` and `gdbus` against the service on a private `dbus-daemon`.
  The popups: in a session (with the other services' check).
- Not yet: tabs' web notifications (Chromium's own, see the backlog), images
  sent as data (`image-data`), sounds.

