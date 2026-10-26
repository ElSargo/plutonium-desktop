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

### audio

PipeWire's outputs (sinks) and inputs (sources), their volume and mute, and the
default ones.

- **State:** `{ available, volume, muted, output, input, outputs, inputs }`.
  `volume` and `muted` are the default output's (up front, for a bar);
  `output` and `input` are the default devices, `outputs`/`inputs` all of them,
  each `{ id, node, name, default, volume, muted }`. `volume` is 0–1 as
  pavucontrol and `wpctl` show it (cubic), above 1 when boosted. `id` is
  PipeWire's object id, which the actions take; `node` (its node name) is the
  one that survives a PipeWire restart. `{ available: false, … }` without
  PipeWire.
- **Actions** (each returns the new state): `set-volume {device?, volume}` (up
  to 1.5), `set-mute {device?, muted?}` (no `muted`: toggle), `set-default
  {device}`, `step {device?, by}` (±, stops at 1; up unmutes: the keys').
  `device` is an id, or `"output"`/`"input"` for the defaults (the default:
  the default output).
- **Host:** `pw-dump` for the state, read again whenever `pw-dump --monitor`
  reports a node, device or metadata change (not the clients that come and go,
  `pw-dump` itself among them), so a change in pavucontrol or `wpctl` arrives
  as a change; `wpctl` for the actions, which sets a device's route volume as
  pavucontrol does.
- **Tested:** `helper/test/audio.test.ts` against a fake `wpctl` and `pw-dump`
  on `PATH` (`test/fixtures/fake-pipewire.ts`): the state, every action, a
  change made elsewhere, no PipeWire. On this computer's PipeWire: the state, a
  step, a change by `wpctl` arriving as a change, the volume put back.

### power

The battery and AC, the backlight, and suspend, restart, power off and log out.

- **State:** `{ battery, ac, brightness, can }`. `battery` is `{ percent,
  charging, state, timeLeft }` (UPower's state: `"charging"`,
  `"discharging"`, `"full"`, …; `timeLeft` in seconds, to empty or to full, or
  null), or null without one (a desktop). `ac` is whether it's on mains power.
  `brightness` is `{ available, value }`, 0–1 (not available on a desktop
  monitor). `can` is `{ suspend, reboot, powerOff, logOut }`: logind's answer
  (`"yes"`, `"challenge"`: it would ask for a password, `"no"`, `"na"`), so a
  menu shows what works.
- **Actions:** `set-brightness {brightness}`, `step {by}` (both return the new
  state; never quite 0: a black screen looks broken), `suspend`, `reboot`,
  `power-off`, `log-out`. **Log out** ends this Plutonium session (as
  `plutonium stop --drm`, or `--x11` for an X11 one), not the user's login:
  that's the text console the session was started from, which comes back.
- **Host:** the system bus. UPower's `DisplayDevice` and `OnBattery`, watched
  through `PropertiesChanged`; logind's `Session.SetBrightness` on the user's
  session with a seat (the helper's `XDG_SESSION_ID`, else the user's
  `Display` session), which needs no root; logind's `Suspend`, `Reboot` and
  `PowerOff`, not interactive (there's no polkit agent to ask for a password).
  The backlight is the first of `/sys/class/backlight` (firmware, then
  platform, then raw), read again every 3 s for changes made elsewhere (sysfs
  has no change events).
- **Tested:** `helper/test/power.test.ts` against fake logind and UPower on
  the fake bus (`test/fixtures/fakeBus.ts`, which serves other services'
  objects and sends signals now): the state, UPower's signals, brightness
  through `SetBrightness`, a change made elsewhere, every action (suspend,
  reboot, power off refused for want of a password, log out) and a desktop
  without a battery or backlight. On this laptop: the battery and AC read, the
  brightness set through logind and put back. Suspend, restart and power off
  were only ever called on the fake bus.

### media

What's playing, and play/pause, next and previous.

- **State:** `{ available, players, active }`. `players`, most recently active
  first (the one that last started playing, or was last told to), each `{ id,
  name, status: "playing" | "paused" | "stopped", title, artist, album, artUrl,
  length, canPlay, canPause, canGoNext, canGoPrevious, tab? }`; `active` is the
  first one's id, the one the media keys control.
- **Actions** (each returns the new state): `play-pause`, `play`, `pause`,
  `stop`, `next`, `previous`, each `{player?}` (default: the active one).
- **Host:** MPRIS on the session bus (mpv with its mpris script, Spotify,
  Firefox, VLC, …), watched through `NameOwnerChanged` and
  `PropertiesChanged`; `playerctld` is left out (it mirrors another player).
  **The browser's tabs:** Plutonium's Chromium is a ChromeOS build, which has
  no MPRIS. Its active media session (a tab or a shell page playing) comes
  through the Plutonium DevTools domain instead (`getMediaSession`,
  `mediaSessionAction`, the `mediaSessionChanged` event; patch "the hardware
  keys go to the helper…"), as the player `"browser"`, named after the site,
  with `tab` the shells' tab playing. No artwork for it yet.
- **Tested:** `helper/test/media.test.ts` against fake players on the fake
  bus: the order, the actions, a player coming and going, the browser's
  session. On this computer: a real `mpv` (with `mpvScripts.mpris`) listed and
  paused through the service.

### The hardware keys

The volume, mic mute, brightness and media keys work in every shell, whichever
app or tab has the keyboard. In shell mode Ash keeps only these hardware keys
(and power) for itself, but its own handlers (CRAS for sound, powerd for the
backlight) do nothing on Linux, so the patch sends them to the helper instead:
Ash's accelerator controller calls a handler chrome sets, which posts the key
to the helper's `POST /v1/system/key` (`{ key }` → `{ handled }`, on its Unix
socket). The helper runs the service's action (`volume-up` is audio's `step
{by: 0.05}`, `volume-mute` toggles, `mic-mute` toggles the default input,
`brightness-up` is power's `step`, `play-pause`/`next`/`previous`/… go to the
active player), and the shells that use the service get the new state and a
`systemkey` event on the shell (`{ key, service, state }`), for an on-screen
level. When the helper did nothing with a key (no player), Ash's own action
runs, which for the media keys is Chromium's media session controller.

Tested in an X11 session (slot 8, keys sent to Xvfb with `xdotool`): volume
up and down (wpctl showed each step, niri's OSD the level), mute on and off,
brightness up and down through logind, play/pause on a real `mpv`, and a
shell page's own media session (silent audio with `navigator.mediaSession`)
listed as the `"browser"` player, its `nexttrack` handler run by the Next
key and paused by Play. Everything was put back. A real keyboard on DRM goes
through the same accelerators.

### In the shipped shells

niri has a bar now (`bar.js`, as waybar is for niri: now playing, a clock, the
indicators), and plain a tray at the bottom of its sidebar. Each indicator is
its own module in the shell's folder, `export default (shell, container)`,
over the shared `tray.js` (icons, a popover, a confirm, `--tray-*` colours):
`audio.js` (scroll to change, middle-click to mute, a slider, the outputs and
the microphone), `brightness.js`, `battery.js` (time left in its tooltip),
`power.js` (suspend, restart, power off, log out, each after a confirm),
`media.js` (now playing and its controls) and `osd.js` (the keys' level).
Indicators hide when their service has nothing (no battery, no backlight, no
player).
Tested in the same session: both shells show the real volume, brightness and
battery, in order. From niri's bar: the volume slider, wheel, mute button and
middle-click, the brightness slider and wheel (all put back after); the power
menu's four entries, and Restart's confirm cancelled (none was run); a real
`mpv` as now playing, paused from the bar's icon and played from the
popover's controls.

### notifications

The helper is the session's notification server (`org.freedesktop.Notifications`
on the session bus: `notify-send`, GTK, Qt, Electron and Chromium-based apps).
Only the session in slot 0 (your desktop) serves it by default, taking it over
from a helper that has it (a notification daemon you run that doesn't allow
that keeps it); a test session in another slot doesn't, unless
`PLUTONIUM_NOTIFICATIONS=1`. It serves from the helper's start, so apps'
notifications are kept while no shell shows them.

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

