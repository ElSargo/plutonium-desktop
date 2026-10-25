#!/usr/bin/env python3
"""A global-shortcuts client of the desktop portal, as Discord or OBS are one.

tools/portal-shortcuts.py [--app-id ID] [--listen SECONDS]

Goes through org.freedesktop.portal.GlobalShortcuts on $DBUS_SESSION_BUS_ADDRESS
(tools/portal-bus.sh's bus, for testing): registers as ID (the host registry,
xdg-desktop-portal 1.19+), CreateSession, BindShortcuts ("ptt", preferring
CTRL+grave, and "mute", with no preference), prints what was bound, then prints
each Activated and Deactivated for SECONDS. Needs PyGObject (Gio).
"""
import argparse
import random
import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

PORTAL = "org.freedesktop.portal.Desktop"
PATH = "/org/freedesktop/portal/desktop"
SHORTCUTS = "org.freedesktop.portal.GlobalShortcuts"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--app-id", default="com.discordapp.Discord")
    parser.add_argument("--listen", type=float, default=30)
    args = parser.parse_args()

    bus = Gio.bus_get_sync(Gio.BusType.SESSION)
    sender = bus.get_unique_name()[1:].replace(".", "_")
    loop = GLib.MainLoop()

    if args.app_id:
        try:
            bus.call_sync(PORTAL, PATH, "org.freedesktop.host.portal.Registry", "Register",
                          GLib.Variant("(sa{sv})", (args.app_id, {})), None, Gio.DBusCallFlags.NONE, -1, None)
        except GLib.Error as error:
            print("Register:", error.message)

    def call(method, params, signature):
        """Calls a portal method that answers through a Request's Response."""
        token = f"t{random.randrange(1 << 30)}"
        handle = f"{PATH}/request/{sender}/{token}"
        answer = {}

        def on_response(_bus, _sender, _path, _iface, _signal, values):
            answer["code"], answer["results"] = values.unpack()
            loop.quit()

        sub = bus.signal_subscribe(None, "org.freedesktop.portal.Request", "Response", handle, None,
                                   Gio.DBusSignalFlags.NONE, on_response)
        params[-1]["handle_token"] = GLib.Variant("s", token)
        bus.call_sync(PORTAL, PATH, SHORTCUTS, method, GLib.Variant(signature, tuple(params)),
                      None, Gio.DBusCallFlags.NONE, -1, None)
        loop.run()
        bus.signal_unsubscribe(sub)
        print(f"{method}: response {answer['code']}", flush=True)
        if answer["code"] != 0:
            sys.exit(1)
        return answer["results"]

    session = call("CreateSession", [{"session_handle_token": GLib.Variant("s", "s1")}], "(a{sv})")["session_handle"]
    shortcuts = [
        ("ptt", {"description": GLib.Variant("s", "Push to talk"), "preferred_trigger": GLib.Variant("s", "CTRL+grave")}),
        ("mute", {"description": GLib.Variant("s", "Mute")}),
    ]
    bound = call("BindShortcuts", [session, shortcuts, "", {}], "(oa(sa{sv})sa{sv})")
    for shortcut_id, options in bound.get("shortcuts", []):
        print(f"bound {shortcut_id}: {options.get('trigger_description')}", flush=True)

    def on_signal(_bus, _sender, _path, _iface, signal, values):
        _session, shortcut_id, timestamp, _options = values.unpack()
        print(f"{signal} {shortcut_id} at {timestamp}", flush=True)

    bus.signal_subscribe(None, SHORTCUTS, None, PATH, None, Gio.DBusSignalFlags.NONE, on_signal)
    GLib.timeout_add(int(args.listen * 1000), loop.quit)
    loop.run()


if __name__ == "__main__":
    main()
