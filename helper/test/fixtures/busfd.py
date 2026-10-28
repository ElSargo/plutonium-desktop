# For threadBus.test.ts: `busfd.py serve ADDRESS NAME` owns NAME and prints
# "ready", then the text read from the fd of the first call it gets;
# `busfd.py send ADDRESS NAME TEXT` calls NAME with a pipe's read end that has TEXT.
import array, os, socket, struct, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src"))
from threadbus import Header, encode_body, message_length

def connect(address):
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(address.split("path=", 1)[1].split(",")[0])
    sock.sendall(b"\0AUTH EXTERNAL %s\r\n" % str(os.getuid()).encode().hex().encode())
    assert sock.recv(4096).startswith(b"OK")
    sock.sendall(b"NEGOTIATE_UNIX_FD\r\n")
    assert sock.recv(4096).startswith(b"AGREE_UNIX_FD")
    sock.sendall(b"BEGIN\r\n")
    return sock

serial = 0
def call(sock, destination, member, sig="", values=(), interface="org.freedesktop.DBus", path="/org/freedesktop/DBus", fds=()):
    global serial
    serial += 1
    fields = [[1, "o", path], [2, "s", interface], [3, "s", member], [6, "s", destination]]
    if sig: fields.append([8, "g", sig])
    if fds: fields.append([9, "u", len(fds)])
    header = Header.__new__(Header)
    header.end, header.type, header.flags, header.version, header.serial, header.fields = "<", 1, 0, 1, serial, fields
    body = encode_body("<", sig, list(values)) if sig != "h" else struct.pack("<I", 0)
    data = header.encode(len(body)) + body
    sock.sendmsg([data], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", fds))] if fds else [])

def messages(sock):
    buffer, fds = b"", []
    while True:
        length = message_length(buffer)
        if length is not None and len(buffer) >= length:
            data, buffer = buffer[:length], buffer[length:]
            yield Header(data), data, fds
            continue
        data, ancillary, _, _ = sock.recvmsg(65536, socket.CMSG_SPACE(64))
        if not data: return
        buffer += data
        for _, _, payload in ancillary:
            fds += list(array.array("i", payload))

mode, address, name = sys.argv[1:4]
sock = connect(address)
call(sock, "org.freedesktop.DBus", "Hello")
# dbus-daemon drops a connection whose fds come in the same read as Hello.
incoming = messages(sock)
for header, data, fds in incoming:
    if header.get(5) == 1:
        break
if mode == "serve":
    call(sock, "org.freedesktop.DBus", "RequestName", "su", (name, 4))
    for header, data, fds in incoming:
        if header.get(5) == 2:
            print("ready", flush=True)
        if header.type == 1 and header.get(3) == "Take":
            print(os.read(fds[-1], 100).decode(), flush=True)
            break
else:
    read, write = os.pipe()
    os.write(write, sys.argv[4].encode())
    os.close(write)
    call(sock, name, "Take", "h", interface="org.example.Desk", path="/", fds=[read])
    for header, data, fds in incoming:
        if header.get(5) == 2:
            break
