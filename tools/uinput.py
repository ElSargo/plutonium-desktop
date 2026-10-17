#!/usr/bin/env python3
"""Virtual evdev keyboard and mouse (uinput), for testing input on DRM.

Ash's Ozone evdev backend picks these up like real devices (udev hotplug), so
this exercises the same path as a physical keyboard and mouse. Needs root.

  sudo tools/uinput.py <fifo>

Creates the two devices, then reads commands from <fifo> (one per line):
  type <text>        type ASCII text (US layout)
  key <KEY>[+KEY..]  press a chord, e.g. key ENTER, key LEFTCTRL+A
  move <dx> <dy>     relative mouse motion (sent in steps of at most 8)
  home               move far up-left, to the screen's top-left corner
  click [left|right|middle]
  down|up [left|right|middle]  press or release a button (drags)
  scroll <n>         wheel clicks (positive = up)
  sleep <seconds>
  quit
"""
import fcntl
import os
import struct
import sys
import time

UI_SET_EVBIT, UI_SET_KEYBIT, UI_SET_RELBIT = 0x40045564, 0x40045565, 0x40045566
UI_DEV_CREATE, UI_DEV_DESTROY = 0x5501, 0x5502
EV_SYN, EV_KEY, EV_REL = 0, 1, 2
REL_X, REL_Y, REL_WHEEL = 0, 1, 8
BTN = {"left": 0x110, "right": 0x111, "middle": 0x112}

KEYS = {
    "ESC": 1, "MINUS": 12, "EQUAL": 13, "BACKSPACE": 14, "TAB": 15, "ENTER": 28,
    "LEFTCTRL": 29, "SEMICOLON": 39, "APOSTROPHE": 40, "GRAVE": 41,
    "LEFTSHIFT": 42, "BACKSLASH": 43, "COMMA": 51, "DOT": 52, "SLASH": 53,
    "LEFTALT": 56, "SPACE": 57, "F11": 87, "LEFTBRACE": 26, "RIGHTBRACE": 27,
    "UP": 103, "LEFT": 105, "RIGHT": 106, "DOWN": 108, "LEFTMETA": 125,
    "F1": 59, "F2": 60, "F3": 61, "F4": 62, "F5": 63,
    "HOME": 102, "PAGEUP": 104, "END": 107, "PAGEDOWN": 109,
}
for i, c in enumerate("1234567890"):
    KEYS[c] = 2 + i
for row, start in (("qwertyuiop", 16), ("asdfghjkl", 30), ("zxcvbnm", 44)):
    for i, c in enumerate(row):
        KEYS[c.upper()] = start + i

PLAIN = {" ": "SPACE", "-": "MINUS", "=": "EQUAL", "[": "LEFTBRACE",
         "]": "RIGHTBRACE", ";": "SEMICOLON", "'": "APOSTROPHE", "`": "GRAVE",
         "\\": "BACKSLASH", ",": "COMMA", ".": "DOT", "/": "SLASH", "\n": "ENTER"}
SHIFTED = {"!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7",
           "*": "8", "(": "9", ")": "0", "_": "MINUS", "+": "EQUAL",
           "{": "LEFTBRACE", "}": "RIGHTBRACE", ":": "SEMICOLON", '"': "APOSTROPHE",
           "~": "GRAVE", "|": "BACKSLASH", "<": "COMMA", ">": "DOT", "?": "SLASH"}


def make_device(name, keys, rels):
    fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
    fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
    for k in keys:
        fcntl.ioctl(fd, UI_SET_KEYBIT, k)
    if rels:
        fcntl.ioctl(fd, UI_SET_EVBIT, EV_REL)
        for r in rels:
            fcntl.ioctl(fd, UI_SET_RELBIT, r)
    # struct uinput_user_dev: name[80], id (bustype, vendor, product, version),
    # ff_effects_max, absmax/absmin/absfuzz/absflat[64] each.
    dev = struct.pack("80sHHHHi", name.encode(), 0x03, 0x1234, 0x5678 + len(rels), 1, 0)
    dev += b"\0" * (4 * 64 * 4)
    os.write(fd, dev)
    fcntl.ioctl(fd, UI_DEV_CREATE)
    return fd


def emit(fd, typ, code, val):
    t = time.time()
    os.write(fd, struct.pack("llHHi", int(t), int((t % 1) * 1e6), typ, code, val))


def syn(fd):
    emit(fd, EV_SYN, 0, 0)


def chord(kbd, names, gap=0.02):
    codes = [KEYS[n] for n in names]
    for c in codes:
        emit(kbd, EV_KEY, c, 1); syn(kbd); time.sleep(gap)
    for c in reversed(codes):
        emit(kbd, EV_KEY, c, 0); syn(kbd); time.sleep(gap)


def type_text(kbd, text):
    for ch in text:
        if ch in PLAIN:
            chord(kbd, [PLAIN[ch]])
        elif ch in SHIFTED:
            chord(kbd, ["LEFTSHIFT", SHIFTED[ch]])
        elif ch.isupper():
            chord(kbd, ["LEFTSHIFT", ch])
        elif ch.upper() in KEYS:
            chord(kbd, [ch.upper()])
        time.sleep(0.01)


def move(mouse, dx, dy, step=8):
    while dx or dy:
        sx = max(-step, min(step, dx)); sy = max(-step, min(step, dy))
        emit(mouse, EV_REL, REL_X, sx); emit(mouse, EV_REL, REL_Y, sy); syn(mouse)
        dx -= sx; dy -= sy
        time.sleep(0.004)


def main(fifo):
    kbd = make_device("plutonium-test-keyboard", list(KEYS.values()), [])
    mouse = make_device("plutonium-test-mouse", list(BTN.values()), [REL_X, REL_Y, REL_WHEEL])
    print("devices created", flush=True)
    try:
        while True:
            with open(fifo) as f:
                for line in f:
                    cmd, _, arg = line.rstrip("\n").partition(" ")
                    print(">", cmd, arg, flush=True)
                    if cmd == "type":
                        type_text(kbd, arg.replace("\\n", "\n"))
                    elif cmd == "key":
                        chord(kbd, arg.split("+"))
                    elif cmd == "move":
                        dx, dy = map(int, arg.split())
                        move(mouse, dx, dy)
                    elif cmd == "home":
                        move(mouse, -6000, -6000, step=100)
                    elif cmd == "click":
                        b = BTN[arg or "left"]
                        emit(mouse, EV_KEY, b, 1); syn(mouse); time.sleep(0.05)
                        emit(mouse, EV_KEY, b, 0); syn(mouse)
                    elif cmd in ("down", "up"):
                        emit(mouse, EV_KEY, BTN[arg or "left"], cmd == "down"); syn(mouse)
                    elif cmd == "scroll":
                        emit(mouse, EV_REL, REL_WHEEL, int(arg)); syn(mouse)
                    elif cmd == "sleep":
                        time.sleep(float(arg))
                    elif cmd == "quit":
                        return
    finally:
        for fd in (kbd, mouse):
            fcntl.ioctl(fd, UI_DEV_DESTROY)


if __name__ == "__main__":
    main(sys.argv[1])
