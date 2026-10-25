#!/usr/bin/env python3
"""A file chooser client of the desktop portal, as a GTK or Qt app is one.

tools/portal-filechooser.py open [--multiple] [--directory] [--folder DIR]
tools/portal-filechooser.py save [--name NAME] [--folder DIR]
tools/portal-filechooser.py save-files NAME... [--folder DIR]

Goes through org.freedesktop.portal.FileChooser on $DBUS_SESSION_BUS_ADDRESS
(tools/portal-bus.sh's bus, for testing), with filters (a glob and a MIME
type), an accept label and two choices (a select and a checkbox), and prints
the response: the URIs, the choices and the filter. Needs PyGObject (Gio).
"""

import argparse
import random
import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

PORTAL = "org.freedesktop.portal.Desktop"
PATH = "/org/freedesktop/portal/desktop"
FILE_CHOOSER = "org.freedesktop.portal.FileChooser"


def path_bytes(path):
    return GLib.Variant("ay", path.encode() + b"\0")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("method", choices=["open", "save", "save-files"])
    parser.add_argument("files", nargs="*")
    parser.add_argument("--multiple", action="store_true")
    parser.add_argument("--directory", action="store_true")
    parser.add_argument("--folder")
    parser.add_argument("--name", default="Untitled.txt")
    args = parser.parse_args()

    bus = Gio.bus_get_sync(Gio.BusType.SESSION)
    sender = bus.get_unique_name()[1:].replace(".", "_")
    loop = GLib.MainLoop()
    token = f"t{random.randrange(1 << 30)}"
    handle = f"{PATH}/request/{sender}/{token}"
    answer = {}

    def on_response(_bus, _sender, _path, _iface, _signal, values):
        answer["code"], answer["results"] = values.unpack()
        loop.quit()

    bus.signal_subscribe(None, "org.freedesktop.portal.Request", "Response", handle, None,
                         Gio.DBusSignalFlags.NONE, on_response)
    text = ("Text", [(0, "*.txt"), (1, "text/markdown")])
    everything = ("All files", [(0, "*")])
    options = {
        "handle_token": GLib.Variant("s", token),
        "accept_label": GLib.Variant("s", "_Choose"),
        "choices": GLib.Variant("a(ssa(ss)s)", [
            ("encoding", "Encoding", [("utf8", "UTF-8"), ("latin1", "Latin-1")], "utf8"),
            ("readonly", "Read only", [], "false"),
        ]),
    }
    if args.method != "save-files":
        options["filters"] = GLib.Variant("a(sa(us))", [text, everything])
        options["current_filter"] = GLib.Variant("(sa(us))", everything)
    if args.folder:
        options["current_folder"] = path_bytes(args.folder)
    if args.method == "open":
        method = "OpenFile"
        options["multiple"] = GLib.Variant("b", args.multiple)
        options["directory"] = GLib.Variant("b", args.directory)
    elif args.method == "save":
        method = "SaveFile"
        options["current_name"] = GLib.Variant("s", args.name)
    else:
        method = "SaveFiles"
        options["files"] = GLib.Variant("aay", [name.encode() + b"\0" for name in args.files])
    bus.call_sync(PORTAL, PATH, FILE_CHOOSER, method, GLib.Variant("(ssa{sv})", ("", "A test", options)),
                  None, Gio.DBusCallFlags.NONE, -1, None)
    loop.run()
    print(f"{method}: response {answer['code']}")
    for key, value in answer["results"].items():
        print(f"{key}: {value}")
    sys.exit(answer["code"])


if __name__ == "__main__":
    main()
