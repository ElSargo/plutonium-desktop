#!/usr/bin/env python3
# A thread's session bus (threadBus.ts): a proxy in front of the user's
# session bus that passes everything through, fds too, except the names its
# clients own. A single-instance app (Flatpak LibreOffice's
# org.libreoffice.LibreOfficeIpc0, a GApplication's app id) owns a name and a
# second start hands its arguments to whoever owns it; here a name a client of
# this thread requests becomes NAME._pl<tag> on the bus, in every message of
# the thread's clients, so each thread gets its own instance while portals,
# notifications, MPRIS, secrets and accessibility stay the desktop's.
#
# Usage: threadbus.py TAG, with the listening socket as fd 3 (socket
# activation) and the bus in DBUS_SESSION_BUS_ADDRESS.
import array
import os
import socket
import struct
import sys
import threading

# Names of desktop services, which stay as they are.
PUBLIC = (
    "org.freedesktop.",
    "org.mpris.",
    "org.kde.StatusNotifierItem",
    "org.kde.StatusNotifierWatcher",
    "org.a11y.",
    "org.gtk.vfs.",
    "org.gtk.Notifications",
    "ca.desrt.dconf",
    "com.canonical.",
)
# org.freedesktop.DBus methods whose first argument is a bus name.
NAME_ARG = {
    "RequestName", "ReleaseName", "GetNameOwner", "NameHasOwner", "StartServiceByName",
    "ListQueuedOwners", "GetConnectionUnixUser", "GetConnectionUnixProcessID",
    "GetConnectionCredentials", "GetAdtAuditSessionData", "GetConnectionSELinuxSecurityContext",
}
LISTS = {"ListNames", "ListActivatableNames"}
BUS = "org.freedesktop.DBus"
MAX_FDS = 253


def public(name):
    return name.startswith(":") or name == BUS or name.startswith(PUBLIC)


class Names:
    """The names the thread's clients own, and their names on the bus."""

    def __init__(self, tag):
        self.suffix = "._pl" + tag
        self.owned = set()
        self.lock = threading.Lock()

    def claim(self, name):
        if public(name) or name.endswith(self.suffix):
            return name
        with self.lock:
            self.owned.add(name)
        return name + self.suffix

    def out(self, name):
        with self.lock:
            return name + self.suffix if name in self.owned else name

    def back(self, name):
        return name[: -len(self.suffix)] if name.endswith(self.suffix) else name

    def rule(self, rule):
        # sender='x',arg0='y': the keys that name a bus name.
        parts = []
        for part in split_rule(rule):
            key, _, value = part.partition("=")
            if key.strip() in ("sender", "destination", "arg0") and len(value) >= 2 and value[0] == value[-1] == "'":
                part = f"{key}='{self.out(value[1:-1])}'"
            parts.append(part)
        return ",".join(parts)


def split_rule(rule):
    parts, current, quoted = [], "", False
    for char in rule:
        if char == "'":
            quoted = not quoted
        if char == "," and not quoted:
            parts.append(current)
            current = ""
        else:
            current += char
    parts.append(current)
    return parts


# --- Marshalling: the header, and bodies of strings, uint32s and string arrays.

def pad(offset, alignment):
    return (alignment - offset % alignment) % alignment


class Header:
    def __init__(self, data):
        self.end = "<" if data[0:1] == b"l" else ">"
        self.type = data[1]
        self.flags = data[2]
        self.version = data[3]
        self.body_length, self.serial, fields_length = struct.unpack(self.end + "III", data[4:16])
        self.fields = []
        offset = 16
        limit = 16 + fields_length
        while offset < limit:
            offset += pad(offset, 8)
            code = data[offset]
            sig_length = data[offset + 1]
            sig = data[offset + 2 : offset + 2 + sig_length].decode()
            offset += 3 + sig_length
            if sig in ("s", "o"):
                offset += pad(offset, 4)
                (length,) = struct.unpack(self.end + "I", data[offset : offset + 4])
                value = data[offset + 4 : offset + 4 + length].decode()
                offset += 5 + length
            elif sig == "g":
                length = data[offset]
                value = data[offset + 1 : offset + 1 + length].decode()
                offset += 2 + length
            elif sig == "u":
                offset += pad(offset, 4)
                (value,) = struct.unpack(self.end + "I", data[offset : offset + 4])
                offset += 4
            else:
                raise ValueError(f"header field type {sig}")
            self.fields.append([code, sig, value])
        self.body_start = limit + pad(limit, 8)

    def get(self, code):
        for field in self.fields:
            if field[0] == code:
                return field[2]
        return None

    def set(self, code, value):
        for field in self.fields:
            if field[0] == code:
                field[2] = value

    def encode(self, body_length):
        out = bytearray()
        for code, sig, value in self.fields:
            out += b"\0" * pad(16 + len(out), 8)
            out += bytes([code, len(sig)]) + sig.encode() + b"\0"
            if sig in ("s", "o"):
                out += b"\0" * pad(16 + len(out), 4)
                raw = value.encode()
                out += struct.pack(self.end + "I", len(raw)) + raw + b"\0"
            elif sig == "g":
                raw = value.encode()
                out += bytes([len(raw)]) + raw + b"\0"
            else:
                out += b"\0" * pad(16 + len(out), 4)
                out += struct.pack(self.end + "I", value)
        fixed = struct.pack(self.end + "III", body_length, self.serial, len(out))
        endian = b"l" if self.end == "<" else b"B"
        head = endian + bytes([self.type, self.flags, self.version]) + fixed + bytes(out)
        return head + b"\0" * pad(len(head), 8)


def decode_body(end, sig, body):
    """The arguments if `sig` is only s, u and as; else None."""
    values, offset = [], 0
    i = 0
    while i < len(sig):
        if sig[i] == "s":
            offset += pad(offset, 4)
            (length,) = struct.unpack(end + "I", body[offset : offset + 4])
            values.append(body[offset + 4 : offset + 4 + length].decode())
            offset += 5 + length
        elif sig[i] == "u":
            offset += pad(offset, 4)
            values.append(struct.unpack(end + "I", body[offset : offset + 4])[0])
            offset += 4
        elif sig[i : i + 2] == "as":
            offset += pad(offset, 4)
            (size,) = struct.unpack(end + "I", body[offset : offset + 4])
            offset += 4
            stop = offset + size
            items = []
            while offset < stop:
                offset += pad(offset, 4)
                (length,) = struct.unpack(end + "I", body[offset : offset + 4])
                items.append(body[offset + 4 : offset + 4 + length].decode())
                offset += 5 + length
            values.append(items)
            i += 1
        else:
            return None
        i += 1
    return values


def encode_body(end, sig, values):
    out = bytearray()
    i = 0
    for value in values:
        out += b"\0" * pad(len(out), 4)
        if sig[i] == "s":
            raw = value.encode()
            out += struct.pack(end + "I", len(raw)) + raw + b"\0"
        elif sig[i] == "u":
            out += struct.pack(end + "I", value)
        else:
            items = bytearray()
            for item in value:
                items += b"\0" * pad(len(items), 4)
                raw = item.encode()
                items += struct.pack(end + "I", len(raw)) + raw + b"\0"
            out += struct.pack(end + "I", len(items)) + items
            i += 1
        i += 1
    return bytes(out)


def message_length(data):
    if len(data) < 16:
        return None
    end = "<" if data[0:1] == b"l" else ">"
    body_length, _, fields_length = struct.unpack(end + "III", data[4:16])
    return 16 + fields_length + pad(fields_length, 8) + body_length


METHOD_CALL, METHOD_RETURN, SIGNAL = 1, 2, 4
DESTINATION, MEMBER, REPLY_SERIAL, SENDER, SIGNATURE, UNIX_FDS = 6, 3, 5, 7, 8, 9


def rewrite_out(names, lists, data):
    """A client's message, as it goes to the bus."""
    header = Header(data)
    body = data[header.body_start :]
    changed = False
    destination = header.get(DESTINATION)
    if destination and destination != BUS:
        renamed = names.out(destination)
        if renamed != destination:
            header.set(DESTINATION, renamed)
            changed = True
    member = header.get(MEMBER)
    if header.type == METHOD_CALL and destination == BUS:
        sig = header.get(SIGNATURE) or ""
        if member in LISTS:
            lists.add(header.serial)
        elif (member in NAME_ARG or member in ("AddMatch", "RemoveMatch")) and sig[:1] == "s":
            values = decode_body(header.end, sig, body)
            if values:
                old = values[0]
                if member in ("AddMatch", "RemoveMatch"):
                    values[0] = names.rule(old)
                elif member == "RequestName":
                    values[0] = names.claim(old)
                else:
                    values[0] = names.out(old)
                if values[0] != old:
                    body = encode_body(header.end, sig, values)
                    changed = True
    return header.encode(len(body)) + body if changed else data


def rewrite_in(names, lists, data):
    """The bus's message, as it goes to the client."""
    header = Header(data)
    if header.get(SENDER) != BUS:
        return data
    sig = header.get(SIGNATURE) or ""
    reply = header.get(REPLY_SERIAL)
    if header.type == SIGNAL and header.get(MEMBER) in ("NameOwnerChanged", "NameAcquired", "NameLost"):
        pass
    elif header.type == METHOD_RETURN and reply in lists:
        lists.discard(reply)
    else:
        return data
    body = data[header.body_start :]
    values = decode_body(header.end, sig, body)
    if not values:
        return data
    if isinstance(values[0], list):
        values[0] = [names.back(name) for name in values[0]]
    else:
        values[0] = names.back(values[0])
    new = encode_body(header.end, sig, values)
    return data if new == body else header.encode(len(new)) + new


# --- The connections.

def unix_fds(data):
    try:
        return Header(data).get(UNIX_FDS) or 0
    except Exception:
        return 0


class Pipe:
    """One direction of a connection: reads, rewrites and forwards messages."""

    def __init__(self, source, sink, rewrite, client_side):
        self.source, self.sink, self.rewrite = source, sink, rewrite
        self.client_side = client_side
        self.buffer = b""
        self.fds = []

    def read(self):
        space = socket.CMSG_SPACE(MAX_FDS * 4)
        data, ancillary, _, _ = self.source.recvmsg(65536, space)
        for level, kind, payload in ancillary:
            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                fds = array.array("i")
                fds.frombytes(payload[: len(payload) - len(payload) % fds.itemsize])
                self.fds += list(fds)
        if not data:
            raise EOFError
        self.buffer += data

    def send(self, data, fds=()):
        ancillary = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", fds))] if fds else []
        sent = self.sink.sendmsg([data], ancillary)
        if sent < len(data):
            self.sink.sendall(data[sent:])
        for fd in fds:
            os.close(fd)

    def auth(self):
        """The authentication lines, until the client's BEGIN or the bus's first message."""
        while True:
            if self.buffer[:1] == b"\0" and self.client_side:
                self.send(b"\0")
                self.buffer = self.buffer[1:]
            if not self.client_side and self.buffer[:1] in (b"l", b"B"):
                return
            line_end = self.buffer.find(b"\r\n")
            if line_end < 0:
                self.read()
                continue
            line = self.buffer[: line_end + 2]
            self.buffer = self.buffer[line_end + 2 :]
            self.send(line)
            if self.client_side and line.startswith(b"BEGIN"):
                return

    def run(self):
        try:
            self.auth()
            while True:
                length = message_length(self.buffer)
                if length is None or len(self.buffer) < length:
                    self.read()
                    continue
                data, self.buffer = self.buffer[:length], self.buffer[length:]
                count = unix_fds(data)
                fds, self.fds = self.fds[:count], self.fds[count:]
                self.send(self.rewrite(data), fds)
        except (EOFError, OSError, ValueError, struct.error, UnicodeDecodeError):
            pass
        finally:
            for sock in (self.source, self.sink):
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass


def upstream_address():
    for entry in os.environ.get("DBUS_SESSION_BUS_ADDRESS", "").split(";"):
        kind, _, rest = entry.partition(":")
        if kind != "unix":
            continue
        keys = dict(part.split("=", 1) for part in rest.split(",") if "=" in part)
        if "path" in keys:
            return keys["path"]
        if "abstract" in keys:
            return "\0" + keys["abstract"]
    raise SystemExit("threadbus: no unix session bus in DBUS_SESSION_BUS_ADDRESS")


def serve(client, address, names):
    try:
        bus = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        bus.connect(address)
    except OSError:
        client.close()
        return
    lists = set()
    out = Pipe(client, bus, lambda data: rewrite_out(names, lists, data), True)
    back = Pipe(bus, client, lambda data: rewrite_in(names, lists, data), False)
    threads = [threading.Thread(target=pipe.run, daemon=True) for pipe in (out, back)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    client.close()
    bus.close()


def main():
    tag = sys.argv[1]
    address = upstream_address()
    names = Names(tag)
    listener = socket.socket(fileno=3)
    while True:
        client, _ = listener.accept()
        threading.Thread(target=serve, args=(client, address, names), daemon=True).start()


if __name__ == "__main__":
    main()
