# Seat management: starting, stopping and switching VTs

On DRM, Ash is the controller of a logind session on a VT, like any Wayland compositor started from a text console (KWin, mutter, or wlroots through libseat). logind gives it the display and input devices, and takes them back while another VT is in front. `chromium/patches/0021-*.patch`.

| | What happens |
|---|---|
| **Start** | `plutonium run` from a text console you logged in on runs Ash in that console's session. `--vt ttyN` runs it in the session on ttyN, from any other shell. |
| **Switch away** | Ctrl+Alt+F1…F12. logind takes DRM master and the input devices away from Ash, then switches. The other VT's desktop or console gets the display and keyboard. Ash keeps running and stops drawing. |
| **Switch back** | Ctrl+Alt+F*n* to Ash's VT, from wherever you are. Ash gets the devices back, sets the display up again, and opens the input devices again. The page and apps are as they were. |
| **Stop** | Ctrl+Alt+Backspace, `plutonium stop --drm`, or the kill switch. However Ash ends, crashes and SIGKILL included, logind puts the VT back in text mode with the keyboard on, so the console works again. |

## How it works

Before this, Ash opened `/dev/dri/card*` and `/dev/input/event*` itself and held them for as long as it ran. A VT switch then left the other session without DRM master (a black screen), and Ash went on reading keys typed on the other VT. The launcher set the VT's keyboard off itself (`lib/tty_vt.py`, gone now). Ash couldn't put it back after a crash, which left a dead console.

**The launcher** (`lib/session.sh`) finds the session: `$XDG_SESSION_ID`, or with `--vt ttyN` the session logged in on ttyN. It checks that the session is on a seat's VT and in front, then passes `--plutonium-logind-session=<id>`. The container mounts `/run/dbus`, for the system bus.

**Ash** (`ui/events/ozone/device/logind_session.cc`) talks to logind over the system D-Bus, on a thread of its own:
- At startup, before Ozone opens a device, it calls `TakeControl` on the session. logind puts the VT in graphics mode with the kernel keyboard off, and handles VT switch requests from now on. Without this, a session that was asked for is fatal; running on, the VT would take every key typed.
- Every DRM and input device is opened with `TakeDevice` rather than `open()`: the primary card (`DrmDisplayHostManager`), hotplugged cards, evdev devices (`InputDeviceOpenerEvdev`) and the ones libinput opens for touchpads. logind keeps its own copy of each and hands out duplicates.
- **`PauseDevice`.** By the time it arrives, logind has dropped DRM master on its copy of the card, which is the same open file as the GPU process's, and revoked the input devices. Ash answers a `pause` with `PauseDeviceComplete`, gives the input devices back (`ReleaseDevice`), and tells its observers the session is paused.
  - `DisplayConfigurator::OnDisplayControlRevoked()` relinquishes display control without turning the displays off, which takes master. The GPU process forgets which window drives which CRTC, so frames are acknowledged and not flipped. Configurations wait until the session is back.
  - `EventFactoryEvdev` closes every input device, which releases the keys that were down, Ctrl and Alt among them.
- **`ResumeDevice`** for the card means master is back. Once every card has it:
  - `DisplayConfigurator::OnDisplayControlRestored()` takes control and forces a full configuration, which probes the displays again (one may have been plugged in meanwhile) and does a modeset over whatever the other session left on screen.
  - `EventFactoryEvdev` scans the input devices again and opens them through logind.
- **Keys.** With the kernel keyboard off, VT switching is up to the compositor. `EventFactoryEvdev` catches Ctrl+Alt+F1…F12 before anything else sees them and calls `SwitchTo` on the seat. It catches Ctrl+Alt+Backspace too, and sends Ash SIGTERM: the same clean shutdown as `plutonium stop`. Neither key reaches Ash, the page or apps, and neither does its release.
- **Exit.** When Ash's bus connection closes, logind releases the session, restores the VT's mode, and lets go of every device.

**In the GPU process** (`drm_wrapper.cc`, `drm_gpu_display_manager.cc`), `SetMaster()` and `DropMaster()` count what is true rather than whether their own ioctl worked. Only the process that opened a DRM file, or root, may change its master state, and under logind that is logind. Relinquishing display control without master doesn't try to detach planes first, which would need a commit.

Without the switch (X11 sessions, or Chromium started by hand), nothing changes: devices are opened directly, as before.

## Verified

On the panel (tty2, the plain shell, the dev build), 2026-10-19, with `plutonium run --vt tty2 --hold …`, keys and mouse from virtual uinput devices (`tools/uinput.py`), and the screen read from KMS (`tools/kmsshot.sh`, `/sys/kernel/debug/dri/1/state`):

| Step | Result |
|---|---|
| Start | `logind: controlling session 4 … active`. tty2 in `KD_GRAPHICS` with the keyboard off (`K_OFF`), set by logind. The shell on screen; keys reach the page |
| Ctrl+Alt+F3 | tty3 in front within 2 s, its console on the primary plane (framebuffer allocated by fbcon). `logind: session paused`. Keys typed on tty3 don't reach the page. The page saw Ctrl and Alt go down, never F3 |
| Ctrl+Alt+F2 (handled by tty3's console) | `logind: session resumed`, then test modeset and modeset succeeded. The page back on screen (framebuffer allocated by DrmThread). Keys and mouse reach it again |
| The same with foot running | foot still there and drawn after coming back |
| Ctrl+Alt+Backspace | Ash exits with 0. tty2 back in `KD_TEXT` with `K_UNICODE` |
| SIGKILL of Ash | Exit 137. tty2 back in `KD_TEXT` with `K_UNICODE` |

Not tried: a real keyboard by hand, a graphical desktop on the other VT (it was a text console), several displays, and Ash started on a VT that isn't in front.

## Limits

- **Ash must start in front.** Starting while another VT is in front isn't supported: the first display configuration would fail. With `--vt` and `--hold`, the launcher waits up to 120 s for the VT to come to the front.
- **A hung Ash can't switch VTs.** The keys go through Ash's UI thread. Use the kill switch, or `loginctl activate <session>` over ssh. logind switches anyway, and the other session gets the devices: logind takes master and revokes input devices even from a controller that doesn't answer.
- **Hotplugged input devices** are still ignored in the container (`BACKLOG.md`), but a device that was there before a switch is opened again after it.
