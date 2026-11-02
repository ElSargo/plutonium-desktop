#!/usr/bin/env python3
"""DevTools (CDP) for a running session: pages, shells and browser tabs.

Runs where python3-websockets is installed: `plutonium cdp ...` runs it where Ash
runs (the container, or the host tools with HOST=1).
CDP picks the session: its DevTools socket (a path, which `plutonium cdp` sets),
or host:port for a session with DEVTOOLS=port (DRM 9224, X11 9223).

  cdp.py list                              targets: type, url
  cdp.py browser <method> [json-params]    a browser-level command
  cdp.py eval <url-part> <js> [--gesture]  evaluate in a page or tab (awaits promises)
  (<url-part> can also be a target id, from /json/list)
  cdp.py shot <url-part> <out.png>         screenshot a page or tab, even while hidden
  cdp.py click <url-part> <x> <y>          click at CSS pixels (renderer input, not Ash's)
  cdp.py console <url-part> <seconds>      print console messages and exceptions
  cdp.py reload <url-prefix>               reload every page whose URL starts with it
  cdp.py shots <url-part> <js> <n> <out>   run js, then take n screenshots back to back
                                           (<out>0.png, ...), to film an animation
"""
import asyncio
import base64
import http.client
import json
import os
import socket
import sys
from urllib.parse import urlsplit

import websockets

CDP = os.environ.get("CDP", "localhost:9224")
# A path is the browser's --plutonium-remote-debugging-socket.
SOCKET = CDP if "/" in CDP else None


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("localhost")
        self.unix_path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(self.unix_path)


def get(path):
    conn = UnixConnection(SOCKET) if SOCKET else http.client.HTTPConnection(CDP)
    try:
        conn.request("GET", path)
        return json.load(conn.getresponse())
    finally:
        conn.close()


def connect(ws_url):
    """A WebSocket to a target, over the socket or the port."""
    if SOCKET:
        return websockets.unix_connect(SOCKET, f"ws://localhost{urlsplit(ws_url).path}", max_size=None)
    return websockets.connect(ws_url, max_size=None)


def targets():
    return get("/json/list")


def target(part):
    for t in targets():
        if part in t["url"] or part == t["id"]:
            return t
    sys.exit(f"no target whose URL contains {part!r}")


class Session:
    def __init__(self, ws):
        self.ws, self.next_id, self.events = ws, 0, []

    async def call(self, method, params=None):
        self.next_id += 1
        await self.ws.send(json.dumps({"id": self.next_id, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(await self.ws.recv())
            if msg.get("id") == self.next_id:
                if "error" in msg:
                    sys.exit(f"{method}: {msg['error'].get('message')}")
                return msg.get("result", {})
            self.events.append(msg)


async def with_target(part, body):
    async with connect(target(part)["webSocketDebuggerUrl"]) as ws:
        return await body(Session(ws))


async def main(args):
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return
    cmd, rest = args[0], args[1:]
    if cmd == "list":
        for t in targets():
            print(t["type"], t["url"])
    elif cmd == "reload":
        pages = [t for t in targets() if t["type"] == "page" and t["url"].startswith(rest[0])]
        for t in pages:
            async with connect(t["webSocketDebuggerUrl"]) as ws:
                # Bypassing the cache: the files can be older than the cached ones.
                await Session(ws).call("Page.reload", {"ignoreCache": True})
        print(f"reloaded {len(pages)} page{'' if len(pages) == 1 else 's'} at {rest[0]}")
    elif cmd == "browser":
        url = get("/json/version")["webSocketDebuggerUrl"]
        async with connect(url) as ws:
            params = json.loads(rest[1]) if len(rest) > 1 else {}
            print(json.dumps(await Session(ws).call(rest[0], params), indent=1))
    elif cmd == "eval":
        async def body(s):
            r = await s.call("Runtime.evaluate", {"expression": rest[1], "returnByValue": True,
                                                  "awaitPromise": True, "userGesture": "--gesture" in rest})
            if "exceptionDetails" in r:
                sys.exit(r["exceptionDetails"].get("exception", {}).get("description", "exception"))
            print(json.dumps(r.get("result", {}).get("value")))
        await with_target(rest[0], body)
    elif cmd == "shot":
        async def body(s):
            r = await s.call("Page.captureScreenshot")
            with open(rest[1], "wb") as f:
                f.write(base64.b64decode(r["data"]))
            print(rest[1])
        await with_target(rest[0], body)
    elif cmd == "click":
        async def body(s):
            x, y = float(rest[1]), float(rest[2])
            for kind in ("mouseMoved", "mousePressed", "mouseReleased"):
                await s.call("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "clickCount": 1,
                                                          "button": "none" if kind == "mouseMoved" else "left"})
        await with_target(rest[0], body)
    elif cmd == "shots":
        async def body(s):
            await s.call("Runtime.evaluate", {"expression": rest[1]})
            start = asyncio.get_running_loop().time()
            for i in range(int(rest[2])):
                r = await s.call("Page.captureScreenshot")
                print(f"shot {i} at {(asyncio.get_running_loop().time() - start) * 1000:.0f} ms")
                with open(f"{rest[3]}{i}.png", "wb") as f:
                    f.write(base64.b64decode(r["data"]))
        await with_target(rest[0], body)
    elif cmd == "console":
        async def body(s):
            await s.call("Runtime.enable")
            loop = asyncio.get_event_loop()
            end = loop.time() + float(rest[1])
            while loop.time() < end:
                if s.events:
                    msg = s.events.pop(0)
                else:
                    try:
                        msg = json.loads(await asyncio.wait_for(s.ws.recv(), end - loop.time()))
                    except asyncio.TimeoutError:
                        break
                method = msg.get("method")
                if method == "Runtime.consoleAPICalled":
                    values = [a.get("value", a.get("description", "")) for a in msg["params"]["args"]]
                    print(msg["params"]["type"], *values, flush=True)
                elif method == "Runtime.exceptionThrown":
                    d = msg["params"]["exceptionDetails"]
                    print("exception", d.get("exception", {}).get("description", d.get("text")), flush=True)
        await with_target(rest[0], body)
    else:
        sys.exit(__doc__)


asyncio.run(main(sys.argv[1:]))
