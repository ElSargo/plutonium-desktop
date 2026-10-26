#!/usr/bin/env bash
# tools/portal-bus.sh start|stop|env [name]: a private D-Bus session bus with
# its own xdg-desktop-portal that uses Plutonium's portal backend (helper/
# portal/), for testing apps' screen capture without touching the session's
# own bus or portal (docs/features/CAPTURE.md, "Testing").
#
#   eval "$(tools/portal-bus.sh start)"     # DBUS_SESSION_BUS_ADDRESS, PLUTONIUM_PORTAL_BUS
#   PLUTONIUM_PORTAL_BUS=$PLUTONIUM_PORTAL_BUS plutonium run --x11   # the helper serves on it
#   tools/portal-bus.sh stop
#
# Apps started with DBUS_SESSION_BUS_ADDRESS set to it reach this portal.
set -euo pipefail
cmd=${1:-env} name=${2:-test}
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
dir=${XDG_RUNTIME_DIR:-/tmp}/plutonium/portal-bus-$name
address=unix:path=$dir/bus
portal=$(command -v xdg-desktop-portal || true)
for candidate in /run/current-system/sw/libexec/xdg-desktop-portal /usr/libexec/xdg-desktop-portal /usr/lib/xdg-desktop-portal; do
  [[ -z $portal && -x $candidate ]] && portal=$candidate
done

case $cmd in
  start)
    [[ -n $portal ]] || { echo "no xdg-desktop-portal" >&2; exit 1; }
    mkdir -p "$dir/share/xdg-desktop-portal/portals" "$dir/config/xdg-desktop-portal"
    cp "$root/helper/portal/"*.portal "$dir/share/xdg-desktop-portal/portals/"
    cp "$root/helper/portal/plutonium-portals.conf" "$dir/config/xdg-desktop-portal/"
    if ! [[ -S $dir/bus ]]; then
      setsid dbus-daemon --session --nofork "--address=$address" > "$dir/dbus.log" 2>&1 < /dev/null &
      echo $! > "$dir/dbus.pid"
      for _ in $(seq 1 20); do [[ -S $dir/bus ]] && break; sleep 0.1; done
    fi
    setsid env DBUS_SESSION_BUS_ADDRESS="$address" XDG_CURRENT_DESKTOP=Plutonium \
      XDG_DATA_HOME="$dir/share" XDG_DATA_DIRS="$dir/share:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}" XDG_CONFIG_HOME="$dir/config" \
      "$portal" -r -v > "$dir/portal.log" 2>&1 < /dev/null &
    echo $! > "$dir/portal.pid"
    echo "export DBUS_SESSION_BUS_ADDRESS=$address PLUTONIUM_PORTAL_BUS=$address"
    echo "# xdg-desktop-portal's log: $dir/portal.log" ;;
  stop)
    for pidfile in "$dir/portal.pid" "$dir/dbus.pid"; do
      [[ -f $pidfile ]] && kill "$(cat "$pidfile")" 2>/dev/null || true
      rm -f "$pidfile"
    done
    rm -f "$dir/bus" ;;
  env)
    echo "export DBUS_SESSION_BUS_ADDRESS=$address PLUTONIUM_PORTAL_BUS=$address" ;;
  *)
    echo "usage: $0 start|stop|env [name]" >&2; exit 2 ;;
esac
