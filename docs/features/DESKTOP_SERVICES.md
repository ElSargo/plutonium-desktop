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

## The services

Each section: its state, its actions, what it uses on the host, and how it was
tested. (Filled in as each lands; see the backlog, "Desktop services for
shells".)
