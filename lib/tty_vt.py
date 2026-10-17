#!/usr/bin/env python3
"""Prepare the controlling VT for a DRM master that reads evdev directly.

Chrome's Ozone DRM backend never touches VT modes, so without this every
keystroke typed into Ash would also reach the shell on the VT. Unprivileged
processes may change their own controlling tty, so this must run from a shell
logged in on that VT, or as root with stdin redirected from it
(sudo tty_vt.py graphics < /dev/tty2).

  tty_vt.py check     exit 0 if stdin is a VT and is the active VT
  tty_vt.py graphics  save modes, then set KD_GRAPHICS + K_OFF (keyboard off)
  tty_vt.py restore   restore the saved modes
"""
import fcntl
import json
import os
import struct
import sys

KDGETMODE, KDSETMODE = 0x4B3B, 0x4B3A
KDGKBMODE, KDSKBMODE = 0x4B44, 0x4B45
KD_GRAPHICS, K_OFF = 0x01, 0x04
KD_TEXT, K_UNICODE = 0x00, 0x03
# Saved modes, per VT, in the (sudo) user's runtime dir.
UID = int(os.environ.get("SUDO_UID", os.getuid()))
STATE_DIR = f"/run/user/{UID}/plutonium"


def vt_name():
    try:
        name = os.path.basename(os.ttyname(0))
    except OSError:
        return None
    return name if name.startswith("tty") and name[3:].isdigit() else None


def state_file(name):
    return os.path.join(STATE_DIR, f"{name}.json")


def active_vt():
    with open("/sys/class/tty/tty0/active") as f:
        return f.read().strip()


def get(req):
    return struct.unpack("i", fcntl.ioctl(0, req, struct.pack("i", 0)))[0]


def main(cmd):
    name = vt_name()
    if name is None:
        print("stdin is not a VT (/dev/ttyN)", file=sys.stderr)
        return 1
    if cmd == "check":
        active = active_vt()
        print(f"stdin={name} active={active}")
        return 0 if active == name else 1
    if cmd == "graphics":
        state = {"tty": name, "mode": get(KDGETMODE), "kbmode": get(KDGKBMODE)}
        # Left in graphics mode by an earlier run that didn't restore: what
        # it should go back to is text with the keyboard on.
        if state["mode"] == KD_GRAPHICS or state["kbmode"] == K_OFF:
            state.update(mode=KD_TEXT, kbmode=K_UNICODE)
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(state_file(name), "w") as f:
            json.dump(state, f)
        os.chown(state_file(name), UID, -1)
        fcntl.ioctl(0, KDSKBMODE, K_OFF)
        fcntl.ioctl(0, KDSETMODE, KD_GRAPHICS)
        print(f"{name}: KD_GRAPHICS + K_OFF (saved {state})")
        return 0
    if cmd == "restore":
        try:
            with open(state_file(name)) as f:
                state = json.load(f)
        except OSError:
            state = {"mode": KD_TEXT, "kbmode": K_UNICODE}
        fcntl.ioctl(0, KDSETMODE, state["mode"])
        fcntl.ioctl(0, KDSKBMODE, state["kbmode"])
        print(f"{name}: restored {state}")
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else ""))
