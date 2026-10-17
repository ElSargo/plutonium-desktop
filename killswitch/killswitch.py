#!/usr/bin/env python3
"""Hardware kill switch for Plutonium sessions on DRM.

On DRM, Ash owns the display and every input device, and the VT's keyboard is
off, so a hung or misbehaving session can't be left with Ctrl+Alt+Fn. This
watches one button (any evdev key: a laptop's spare hotkey, a keyboard key you
never use) and, on a press:
  1. SIGKILLs every process of this user that is a Plutonium Ash (its command
     line carries --plutonium-shell-origin=), read straight from /proc;
  2. switches back to the user's graphical session (Plasma, GNOME, ...), if
     there is one, through logind.
The launcher sees Ash exit and gives the VT its keyboard back.

It only reads the device (no grab), so the button keeps working elsewhere.

  KILLSWITCH_DEVICE="<device name>" KILLSWITCH_KEY=<code> killswitch.py
  killswitch.py --find [seconds]   print key presses with device names and codes
  killswitch.py --fire [--dry-run] act once now (or only log what it would do)

`plutonium killswitch install` runs it as the user service plutonium-killswitch.
The user must be able to read /dev/input/event* (the 'input' group).
"""
import glob
import os
import select
import signal
import struct
import subprocess
import sys
import time

DEVICE_NAME = os.environ.get("KILLSWITCH_DEVICE", "")
KEY_CODE = int(os.environ.get("KILLSWITCH_KEY", "0"))
KILL_PATTERNS = ("--plutonium-shell-origin=",)
DEBOUNCE_S = 2.0

EV_KEY = 0x01
EVENT_FMT = "llHHi"  # struct input_event on 64-bit
EVENT_SIZE = struct.calcsize(EVENT_FMT)


def log(msg):
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}", flush=True)


def device_name(node):
    try:
        with open(f"/sys/class/input/{os.path.basename(node)}/device/name") as f:
            return f.read().strip()
    except OSError:
        return "?"


def find_device():
    for node in sorted(glob.glob("/dev/input/event*")):
        if device_name(node) == DEVICE_NAME:
            return node
    return None


def ancestors():
    """PIDs of this process and its parents, which must never be killed."""
    pids, pid = set(), os.getpid()
    while pid > 1:
        pids.add(pid)
        try:
            with open(f"/proc/{pid}/stat") as f:
                pid = int(f.read().rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            break
    return pids


def matching_pids():
    skip, uid = ancestors(), os.getuid()
    pids = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit() or int(entry) in skip:
            continue
        try:
            if os.stat(f"/proc/{entry}").st_uid != uid:
                continue
            with open(f"/proc/{entry}/cmdline", "rb") as f:
                cmd = f.read().replace(b"\0", b" ").decode(errors="replace")
        except OSError:
            continue
        # Ash itself, not a shell or podman command that mentions the flag.
        if any(p in cmd for p in KILL_PATTERNS) and cmd.split(" ", 1)[0].endswith("/chrome"):
            pids.append((int(entry), cmd[:120]))
    return pids


def graphical_session():
    """The logind session id of this user's Wayland or X11 session, if any."""
    try:
        out = subprocess.run(["loginctl", "list-sessions", "--no-legend"],
                             capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    for line in out.splitlines():
        fields = line.split()
        if len(fields) < 3 or fields[1] != str(os.getuid()):
            continue
        try:
            kind = subprocess.run(["loginctl", "show-session", fields[0], "-p", "Type", "--value"],
                                  capture_output=True, text=True, timeout=5).stdout.strip()
        except (OSError, subprocess.TimeoutExpired):
            continue
        if kind in ("wayland", "x11"):
            return fields[0]
    return None


def fire(dry_run=False):
    log(f"FIRE (dry_run={dry_run})")
    for _ in range(5):  # again, in case something respawns
        pids = matching_pids()
        if not pids:
            break
        for pid, cmd in pids:
            log(f"  {'would kill' if dry_run else 'SIGKILL'} {pid}: {cmd}")
            if not dry_run:
                try:
                    os.kill(pid, signal.SIGKILL)
                except OSError as e:
                    log(f"    kill {pid} failed: {e}")
        if dry_run:
            break
        time.sleep(0.3)
    sid = graphical_session()
    if sid is None:
        log("  no graphical session; staying on this VT")
        return
    log(f"  {'would activate' if dry_run else 'activate'} session {sid}")
    if not dry_run:
        try:
            r = subprocess.run(["loginctl", "activate", sid], capture_output=True, text=True, timeout=10)
            log(f"  loginctl activate rc={r.returncode} {r.stderr.strip()}")
        except (OSError, subprocess.TimeoutExpired) as e:
            log(f"  loginctl activate failed: {e}")


def run(dry_run):
    if not DEVICE_NAME or not KEY_CODE:
        sys.exit("set KILLSWITCH_DEVICE and KILLSWITCH_KEY (killswitch.py --find shows them)")
    log(f"killswitch starting (pid {os.getpid()}, dry_run={dry_run}); watching '{DEVICE_NAME}' code {KEY_CODE}")
    last_fire = 0.0
    while True:
        node = find_device()
        if node is None:
            log("device not found; retrying in 2 s")
            time.sleep(2)
            continue
        try:
            fd = os.open(node, os.O_RDONLY)
        except OSError as e:
            log(f"open {node} failed: {e}; retrying in 2 s")
            time.sleep(2)
            continue
        log(f"listening on {node}")
        try:
            while True:
                select.select([fd], [], [])
                data = os.read(fd, EVENT_SIZE * 64)
                if not data:
                    raise OSError("device closed")
                for off in range(0, len(data) - EVENT_SIZE + 1, EVENT_SIZE):
                    _, _, etype, code, value = struct.unpack_from(EVENT_FMT, data, off)
                    if etype == EV_KEY and code == KEY_CODE and value == 1:
                        now = time.monotonic()
                        if now - last_fire >= DEBOUNCE_S:
                            last_fire = now
                            fire(dry_run)
        except OSError as e:
            log(f"lost {node}: {e}; rescanning")
            os.close(fd)
            time.sleep(1)


def find(seconds):
    """Print key presses from every readable device, to pick the button."""
    fds = {}
    for node in sorted(glob.glob("/dev/input/event*")):
        try:
            fds[os.open(node, os.O_RDONLY | os.O_NONBLOCK)] = (node, device_name(node))
        except OSError:
            pass
    if not fds:
        sys.exit("can't read any /dev/input/event* (add yourself to the 'input' group and log in again)")
    print(f"Press the button you want as the kill switch ({seconds} s; {len(fds)} devices)...", flush=True)
    deadline = time.time() + seconds
    while time.time() < deadline:
        ready, _, _ = select.select(list(fds), [], [], 0.5)
        for fd in ready:
            try:
                data = os.read(fd, EVENT_SIZE * 64)
            except BlockingIOError:
                continue
            for off in range(0, len(data) - EVENT_SIZE + 1, EVENT_SIZE):
                _, _, etype, code, value = struct.unpack_from(EVENT_FMT, data, off)
                if etype == EV_KEY and value == 1:
                    node, name = fds[fd]
                    print(f'KILLSWITCH_DEVICE="{name}" KILLSWITCH_KEY={code}   ({node})', flush=True)


if __name__ == "__main__":
    if "--find" in sys.argv:
        rest = sys.argv[sys.argv.index("--find") + 1:]
        find(float(rest[0]) if rest else 30)
    elif "--fire" in sys.argv:
        fire(dry_run="--dry-run" in sys.argv)
    else:
        run(dry_run="--dry-run" in sys.argv)
