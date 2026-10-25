"""The Print portal's backend on D-Bus, for the helper (printPortal.ts).

python3 printportal.py <bus address> <bus name>

org.freedesktop.impl.portal.Print hands the backend the document as a Unix
fd, which Node can't receive (no SCM_RIGHTS on its sockets), so this process
serves that interface under its own name and leaves the rest to the helper:
each call goes to stdout as a JSON line, and the helper's answer comes back
on stdin, as {"id", "response", "results"} (results' values as [signature,
value], a{sv} values as objects of the same). Print's document is copied to a
file of its own under $XDG_RUNTIME_DIR first, whose path the helper gets (and
removes). Request.Close goes over as a "Close" call that isn't answered.

A small D-Bus client: EXTERNAL authentication with fds negotiated,
little-endian messages; only what the interface needs.
"""

import json
import os
import select
import socket
import struct
import sys
import tempfile

PRINT = "org.freedesktop.impl.portal.Print"
REQUEST = "org.freedesktop.impl.portal.Request"
INTROSPECTABLE = "org.freedesktop.DBus.Introspectable"
PORTAL_PATH = "/org/freedesktop/portal/desktop"

INTROSPECTION = f"""<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">
<node>
  <interface name="{PRINT}">
    <method name="Print"><arg type="o" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="h" direction="in"/><arg type="a{{sv}}" direction="in"/><arg type="u" direction="out"/><arg type="a{{sv}}" direction="out"/></method>
    <method name="PreparePrint"><arg type="o" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="a{{sv}}" direction="in"/><arg type="a{{sv}}" direction="in"/><arg type="a{{sv}}" direction="in"/><arg type="u" direction="out"/><arg type="a{{sv}}" direction="out"/></method>
  </interface>
</node>"""

ALIGN = {"y": 1, "b": 4, "n": 2, "q": 2, "i": 4, "u": 4, "h": 4, "x": 8, "t": 8, "d": 8,
         "s": 4, "o": 4, "g": 1, "v": 1, "a": 4, "(": 8, "{": 8}
FIXED = {"y": "B", "b": "I", "n": "h", "q": "H", "i": "i", "u": "I", "h": "I", "x": "q", "t": "Q", "d": "d"}


def split_signature(signature):
    """'sa{sv}(ii)' → ['s', 'a{sv}', '(ii)']."""
    types, i = [], 0
    while i < len(signature):
        start = i
        while signature[i] == "a":
            i += 1
        if signature[i] in "({":
            depth = 0
            while True:
                if signature[i] in "({":
                    depth += 1
                elif signature[i] in ")}":
                    depth -= 1
                i += 1
                if depth == 0:
                    break
        else:
            i += 1
        types.append(signature[start:i])
    return types


class Writer:
    def __init__(self):
        self.data = bytearray()

    def align(self, n):
        self.data += b"\0" * (-len(self.data) % n)

    def write(self, t, value):
        c = t[0]
        if c in FIXED:
            self.align(ALIGN[c])
            self.data += struct.pack("<" + FIXED[c], int(value) if c != "d" else float(value))
        elif c in "so":
            raw = value.encode()
            self.write("u", len(raw))
            self.data += raw + b"\0"
        elif c == "g":
            raw = value.encode()
            self.data += bytes([len(raw)]) + raw + b"\0"
        elif c == "v":
            signature, inner = value
            self.write("g", signature)
            self.write(signature, inner)
        elif c == "(":
            self.align(8)
            for field, item in zip(split_signature(t[1:-1]), value):
                self.write(field, item)
        elif c == "a":
            element = t[1:]
            self.align(4)
            at = len(self.data)
            self.data += b"\0\0\0\0"
            self.align(ALIGN[element[0]])
            start = len(self.data)
            if element[0] == "{":
                key, val = split_signature(element[1:-1])
                for k, v in (value.items() if isinstance(value, dict) else value):
                    self.align(8)
                    self.write(key, k)
                    self.write(val, v)
            else:
                for item in value:
                    self.write(element, item)
            struct.pack_into("<I", self.data, at, len(self.data) - start)
        else:
            raise ValueError(f"can't write {t}")


class Reader:
    def __init__(self, data, offset=0):
        self.data = data
        self.offset = offset

    def align(self, n):
        self.offset += -self.offset % n

    def read(self, t):
        c = t[0]
        if c in FIXED:
            self.align(ALIGN[c])
            fmt = "<" + FIXED[c]
            (value,) = struct.unpack_from(fmt, self.data, self.offset)
            self.offset += struct.calcsize(fmt)
            return bool(value) if c == "b" else value
        if c in "so":
            length = self.read("u")
            value = self.data[self.offset:self.offset + length].decode()
            self.offset += length + 1
            return value
        if c == "g":
            length = self.data[self.offset]
            value = self.data[self.offset + 1:self.offset + 1 + length].decode()
            self.offset += length + 2
            return value
        if c == "v":
            signature = self.read("g")
            return self.read(signature)
        if c == "(":
            self.align(8)
            return [self.read(field) for field in split_signature(t[1:-1])]
        if c == "a":
            element = t[1:]
            length = self.read("u")
            self.align(ALIGN[element[0]])
            end = self.offset + length
            if element[0] == "{":
                key, val = split_signature(element[1:-1])
                result = {}
                while self.offset < end:
                    self.align(8)
                    k = self.read(key)
                    result[k] = self.read(val)
                return result
            items = []
            while self.offset < end:
                items.append(self.read(element))
            if element == "y":
                return bytes(items)
            return items
        raise ValueError(f"can't read {t}")


def plain(value):
    """D-Bus values as JSON can carry them (bytes as text)."""
    if isinstance(value, dict):
        return {str(k): plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [plain(v) for v in value]
    if isinstance(value, bytes):
        return value.rstrip(b"\0").decode(errors="replace")
    return value


def typed(results):
    """The helper's {key: [signature, value]} as a{sv} (a{sv} values nested the same)."""
    out = {}
    for key, (signature, value) in results.items():
        out[key] = (signature, typed(value) if signature == "a{sv}" else value)
    return out


class Bus:
    def __init__(self, address):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        for part in address.split(";"):
            params = dict(item.split("=", 1) for item in part.split(":", 1)[1].split(",") if "=" in item)
            if "path" in params:
                self.sock.connect(params["path"])
                break
            if "abstract" in params:
                self.sock.connect("\0" + params["abstract"])
                break
        else:
            raise SystemExit(f"printportal: can't connect to {address}")
        self.serial = 0
        self.buffer = b""
        self.fds = []
        self._auth()
        self.name = self.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "Hello", "", [])[0]

    def _line(self):
        while b"\r\n" not in self.buffer:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise SystemExit("printportal: the bus hung up")
            self.buffer += chunk
        line, self.buffer = self.buffer.split(b"\r\n", 1)
        return line.decode()

    def _auth(self):
        self.sock.sendall(b"\0AUTH EXTERNAL " + str(os.getuid()).encode().hex().encode() + b"\r\n")
        if not self._line().startswith("OK"):
            raise SystemExit("printportal: the bus refused us")
        self.sock.sendall(b"NEGOTIATE_UNIX_FD\r\n")
        if not self._line().startswith("AGREE_UNIX_FD"):
            raise SystemExit("printportal: the bus won't pass fds")
        self.sock.sendall(b"BEGIN\r\n")

    def send(self, kind, fields, signature="", body=(), flags=0):
        self.serial += 1
        payload = Writer()
        for t, value in zip(split_signature(signature), body):
            payload.write(t, value)
        if signature:
            fields = fields + [(8, ("g", signature))]
        header = Writer()
        header.data += struct.pack("<cBBBII", b"l", kind, flags, 1, len(payload.data), self.serial)
        header.write("a(yv)", fields)
        header.align(8)
        self.sock.sendall(bytes(header.data) + bytes(payload.data))
        return self.serial

    def call(self, destination, path, interface, member, signature, body):
        serial = self.send(1, [(1, ("o", path)), (2, ("s", interface)), (3, ("s", member)), (6, ("s", destination))],
                           signature, body)
        while True:
            message = self.receive()
            if message["fields"].get(5) == serial:
                if message["type"] == 3:
                    raise SystemExit(f"printportal: {member}: {message['body']}")
                return message["body"]

    def reply(self, message, signature="", body=()):
        self.send(2, [(5, ("u", message["serial"])), (6, ("s", message["fields"][7]))], signature, body, flags=1)

    def error(self, message, name, text):
        self.send(3, [(4, ("s", name)), (5, ("u", message["serial"])), (6, ("s", message["fields"][7]))],
                  "s", [text], flags=1)

    def receive(self):
        """The next whole message (blocking)."""
        while True:
            message = self._parse()
            if message:
                return message
            data, ancillary, _flags, _address = self.sock.recvmsg(65536, socket.CMSG_SPACE(64 * 4))
            for level, kind, payload in ancillary:
                if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                    self.fds += list(struct.unpack(f"<{len(payload) // 4}i", payload[:len(payload) - len(payload) % 4]))
            if not data:
                raise SystemExit("printportal: the bus hung up")
            self.buffer += data

    def _parse(self):
        if len(self.buffer) < 16:
            return None
        if self.buffer[0:1] != b"l":
            raise SystemExit("printportal: big-endian messages aren't handled")
        kind, flags, _version, body_length, serial, fields_length = struct.unpack_from("<BBBIII", self.buffer, 1)
        header_end = 16 + fields_length
        header_end += -header_end % 8
        total = header_end + body_length
        if len(self.buffer) < total:
            return None
        data, self.buffer = self.buffer[:total], self.buffer[total:]
        reader = Reader(data, 12)
        fields = {code: value for code, value in reader.read("a(yv)")}
        count = fields.get(9, 0)
        fds, self.fds = self.fds[:count], self.fds[count:]
        signature = fields.get(8, "")
        body_reader = Reader(data, header_end)
        body = [body_reader.read(t) for t in split_signature(signature)]
        return {"type": kind, "flags": flags, "serial": serial, "fields": fields, "body": body, "fds": fds}


def save_document(fd):
    """The document behind `fd` in a file of its own; its path."""
    runtime = os.path.join(os.environ.get("XDG_RUNTIME_DIR") or tempfile.gettempdir(), "plutonium")
    os.makedirs(runtime, exist_ok=True)
    out, path = tempfile.mkstemp(prefix="print-", dir=runtime)
    try:
        try:
            os.lseek(fd, 0, os.SEEK_SET)
        except OSError:
            pass  # A pipe.
        while True:
            chunk = os.read(fd, 1 << 16)
            if not chunk:
                break
            os.write(out, chunk)
    finally:
        os.close(out)
    return path


def main():
    address, name = sys.argv[1], sys.argv[2]
    bus = Bus(address)
    # 4: don't queue; another session's helper has it.
    (result,) = bus.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName",
                         "su", [name, 4])
    print(json.dumps({"ready": result == 1, "name": name}), flush=True)
    pending = {}
    next_id = 0
    stdin = sys.stdin.buffer
    lines = b""
    while True:
        readable, _, _ = select.select([bus.sock, stdin] if not bus.buffer else [], [], [], 0)
        if not bus.buffer and not readable:
            readable, _, _ = select.select([bus.sock, stdin], [], [])
        if stdin in readable:
            chunk = os.read(stdin.fileno(), 65536)
            if not chunk:
                return
            lines += chunk
            while b"\n" in lines:
                line, lines = lines.split(b"\n", 1)
                answer = json.loads(line)
                message = pending.pop(answer["id"], None)
                if message:
                    bus.reply(message, "ua{sv}", [answer["response"], typed(answer.get("results") or {})])
        if bus.buffer or bus.sock in readable:
            message = bus.receive()
            if message["type"] != 1:
                for fd in message["fds"]:
                    os.close(fd)
                continue
            interface, member, path = message["fields"].get(2), message["fields"].get(3), message["fields"].get(1)
            body = message["body"]
            try:
                if interface == INTROSPECTABLE and member == "Introspect":
                    bus.reply(message, "s", [INTROSPECTION])
                elif interface == REQUEST and member == "Close":
                    print(json.dumps({"method": "Close", "handle": path}), flush=True)
                    bus.reply(message)
                elif interface == PRINT and member in ("PreparePrint", "Print"):
                    next_id += 1
                    call = {"id": next_id, "method": member, "handle": body[0], "appId": body[1],
                            "parent": body[2], "title": body[3]}
                    if member == "PreparePrint":
                        call.update(settings=plain(body[4]), pageSetup=plain(body[5]), options=plain(body[6]))
                    else:
                        index = body[4]
                        if index >= len(message["fds"]):
                            raise ValueError("no document")
                        call.update(document=save_document(message["fds"][index]), options=plain(body[5]))
                    pending[next_id] = message
                    print(json.dumps(call), flush=True)
                else:
                    bus.error(message, "org.freedesktop.DBus.Error.UnknownMethod", f"No such method {interface}.{member}")
            except Exception as error:  # noqa: BLE001 — the app gets the error, we carry on
                bus.error(message, "org.freedesktop.DBus.Error.Failed", str(error))
            finally:
                for fd in message["fds"]:
                    os.close(fd)


if __name__ == "__main__":
    main()
