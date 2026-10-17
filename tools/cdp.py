#!/usr/bin/env python3
"""DevTools (CDP) for a running session: pages, shells and browser tabs.

Runs where python3-websockets is installed: `plutonium cdp ...` runs it where Ash
runs (the container, or the host tools with HOST=1).
CDP=host:port picks the session (DRM 9224, X11 9223).

  cdp.py list                              targets: type, url
  cdp.py browser <method> [json-params]    a browser-level command
  cdp.py eval <url-part> <js> [--gesture]  evaluate in a page or tab (awaits promises)
  cdp.py shot <url-part> <out.png>         screenshot a page or tab, even while hidden
  cdp.py click <url-part> <x> <y>          click at CSS pixels (renderer input, not Ash's)
  cdp.py console <url-part> <seconds>      print console messages and exceptions
"""
import asyncio
import base64
import json
import os
import sys
import urllib.request

import websockets

HOST = os.environ.get("CDP", "localhost:9224")


def targets():
    return json.load(urllib.request.urlopen(f"http://{HOST}/json/list"))


def target(part):
    for t in targets():
        if part in t["url"]:
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
    async with websockets.connect(target(part)["webSocketDebuggerUrl"], max_size=None) as ws:
        return await body(Session(ws))


async def main(args):
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return
    cmd, rest = args[0], args[1:]
    if cmd == "list":
        for t in targets():
            print(t["type"], t["url"])
    elif cmd == "browser":
        url = json.load(urllib.request.urlopen(f"http://{HOST}/json/version"))["webSocketDebuggerUrl"]
        async with websockets.connect(url, max_size=None) as ws:
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
