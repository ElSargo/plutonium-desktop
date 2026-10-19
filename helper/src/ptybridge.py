#!/usr/bin/env python3
# The backup terminal's pseudo-terminal (terminal.ts). Node has no pty of its
# own, and the helper takes no dependencies; Python's pty module is enough.
#
#   python3 ptybridge.py <rows> <cols> <program> [args...]
#
# Runs the program on a new pty, copies stdin to it and its output to stdout.
# File descriptor 3 takes "<rows> <cols>\n" lines, which resize it (the kernel
# then sends the program SIGWINCH). Exits with the program's status once the
# pty hangs up.
import errno
import fcntl
import os
import pty
import select
import struct
import sys
import termios


def resize(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def write_all(fd, data):
    while data:
        data = data[os.write(fd, data):]


def main():
    rows, cols, argv = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
    pid, master = pty.fork()
    if pid == 0:
        try:
            os.execvp(argv[0], argv)
        except OSError as error:
            sys.stderr.write(f"{argv[0]}: {error.strerror}\r\n")
        os._exit(127)
    resize(master, rows, cols)
    inputs = [0, master, 3]
    control = b""
    while True:
        try:
            ready, _, _ = select.select(inputs, [], [])
        except InterruptedError:
            continue
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                # EIO: the program and everything it started closed the pty.
                if error.errno != errno.EIO:
                    raise
                data = b""
            if not data:
                break
            write_all(1, data)
        if 0 in ready:
            data = os.read(0, 65536)
            if data:
                write_all(master, data)
            else:
                inputs.remove(0)
        if 3 in ready:
            data = os.read(3, 4096)
            if not data:
                inputs.remove(3)
                continue
            control += data
            while b"\n" in control:
                line, control = control.split(b"\n", 1)
                try:
                    new_rows, new_cols = (int(part) for part in line.split())
                    resize(master, max(1, new_rows), max(1, new_cols))
                except ValueError:
                    pass
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status))


if __name__ == "__main__":
    main()
