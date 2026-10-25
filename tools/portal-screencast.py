#!/usr/bin/env python3
"""A screen-capture client of the desktop portal, as OBS or Firefox are one.

tools/portal-screencast.py [--restore TOKEN] [--types 3] [--cursor 2] [--frames 5] OUT.png
tools/portal-screencast.py --screenshot [--interactive] OUT.png

Goes through org.freedesktop.portal.ScreenCast on $DBUS_SESSION_BUS_ADDRESS
(tools/portal-bus.sh's bus, for testing): CreateSession, SelectSources (with
persist_mode 2, or the restore token), Start, OpenPipeWireRemote, then records
the first stream's frames with GStreamer's pipewiresrc through the portal's
PipeWire fd and writes the last one to OUT.png. Prints the streams and the
restore token. Needs PyGObject (Gio) and gst-launch-1.0 with pipewiresrc.
"""
import argparse
import os
import random
import subprocess
import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

PORTAL = "org.freedesktop.portal.Desktop"
PATH = "/org/freedesktop/portal/desktop"
SCREENCAST = "org.freedesktop.portal.ScreenCast"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("out")
    parser.add_argument("--restore")
    parser.add_argument("--types", type=int, default=3)
    parser.add_argument("--cursor", type=int, default=2)
    parser.add_argument("--frames", type=int, default=5)
    parser.add_argument("--hold", type=float, default=0, help="seconds to keep the session open after")
    parser.add_argument("--screenshot", action="store_true", help="the Screenshot portal instead; copies the file to OUT")
    parser.add_argument("--interactive", action="store_true")
    args = parser.parse_args()

    bus = Gio.bus_get_sync(Gio.BusType.SESSION)
    sender = bus.get_unique_name()[1:].replace(".", "_")
    loop = GLib.MainLoop()

    def call(method, params, signature, iface=SCREENCAST):
        """Calls a portal method that answers through a Request's Response."""
        token = f"t{random.randrange(1 << 30)}"
        handle = f"{PATH}/request/{sender}/{token}"
        answer = {}

        def on_response(_bus, _sender, _path, _iface, _signal, values):
            answer["code"], answer["results"] = values.unpack()
            loop.quit()

        # Subscribed before the call, so the Response can't come first.
        sub = bus.signal_subscribe(None, "org.freedesktop.portal.Request", "Response", handle, None,
                                   Gio.DBusSignalFlags.NONE, on_response)
        params[-1]["handle_token"] = GLib.Variant("s", token)
        bus.call_sync(PORTAL, PATH, iface, method, GLib.Variant(signature, tuple(params)),
                      None, Gio.DBusCallFlags.NONE, -1, None)
        loop.run()
        bus.signal_unsubscribe(sub)
        print(f"{method}: response {answer['code']}")
        if answer["code"] != 0:
            sys.exit(1)
        return answer["results"]

    if args.screenshot:
        options = {"interactive": GLib.Variant("b", args.interactive)}
        uri = call("Screenshot", ["", options], "(sa{sv})", "org.freedesktop.portal.Screenshot")["uri"]
        print("uri:", uri)
        with open(Gio.File.new_for_uri(uri).get_path(), "rb") as source, open(args.out, "wb") as out:
            out.write(source.read())
        return

    session = call("CreateSession", [{"session_handle_token": GLib.Variant("s", "s1")}], "(a{sv})")["session_handle"]
    options = {
        "types": GLib.Variant("u", args.types),
        "cursor_mode": GLib.Variant("u", args.cursor),
        "persist_mode": GLib.Variant("u", 2),
    }
    if args.restore:
        options["restore_token"] = GLib.Variant("s", args.restore)
    call("SelectSources", [session, options], "(oa{sv})")
    results = call("Start", [session, "", {}], "(osa{sv})")
    streams = results.get("streams", [])
    print("streams:", streams)
    print("restore_token:", results.get("restore_token"))

    reply, fds = bus.call_with_unix_fd_list_sync(
        PORTAL, PATH, SCREENCAST, "OpenPipeWireRemote", GLib.Variant("(oa{sv})", (session, {})),
        GLib.VariantType("(h)"), Gio.DBusCallFlags.NONE, -1, None, None)
    fd = fds.get(reply.unpack()[0])
    node = streams[0][0]
    pipeline = (f"pipewiresrc fd={fd} path={node} num-buffers={args.frames} always-copy=true ! videoconvert ! "
                f"pngenc snapshot=false ! multifilesink location={args.out}")
    print("gst:", pipeline)
    result = subprocess.run(["gst-launch-1.0", "-q", *pipeline.split()], pass_fds=[fd], timeout=60)
    print("gst-launch exit", result.returncode)
    if args.hold:
        GLib.timeout_add(int(args.hold * 1000), loop.quit)
        loop.run()
    bus.call_sync(PORTAL, session, "org.freedesktop.portal.Session", "Close", None, None,
                  Gio.DBusCallFlags.NONE, -1, None)
    os.close(fd)


if __name__ == "__main__":
    main()
