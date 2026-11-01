# Shared settings for the scripts in bin/ and lib/. Source it; it sets ROOT and
# reads the settings (plutonium.env, see plutonium.env.example) for overrides.
#
# This is what a session needs anywhere. A release install (dev/bundle's
# tarball, which dev/bundle/install.sh puts in /opt/plutonium) is this with
# chrome/ and node/ beside it, and runs everything on the host. A checkout of
# the source also has dev/: Chromium builds, the container a session can run
# Ash in, worktrees' slots, and the commands for them (dev/env.sh, sourced
# below, and dev/commands.sh).

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DEV=
[[ -f $ROOT/dev/env.sh ]] && DEV=1
# A checkout's settings are its own; a release install's directory is
# read-only, so its are the user's.
if [[ -n $DEV ]]; then PLUTONIUM_ENV=$ROOT/plutonium.env
else PLUTONIUM_ENV=${XDG_CONFIG_HOME:-$HOME/.config}/plutonium/plutonium.env; fi
[ -f "$PLUTONIUM_ENV" ] && . "$PLUTONIUM_ENV"
# A worktree's own overrides, on top of a plutonium.env it shares with the
# main checkout (plutonium worktree add links it).
[[ -n $DEV && -f $ROOT/plutonium.local.env ]] && . "$ROOT/plutonium.local.env"

# Parallel checkouts (docs/DEVELOPING.md): each has a slot, and slot N moves
# its sessions' sockets, ports, X display and profiles out of the others' way.
# Slot 0, the main checkout's and a release install's, keeps the plain names.
SLOT=${PLUTONIUM_SLOT:-0}
[[ -n $DEV && -z ${PLUTONIUM_SLOT:-} && -f $ROOT/.plutonium-slot ]] && SLOT=$(cat "$ROOT/.plutonium-slot")
SLOT_SUFFIX=
(( SLOT )) && SLOT_SUFFIX=-s$SLOT
slot_port() { echo $(( $1 + 100 * SLOT )); }

# Where things live.
DATA_DIR=${DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/plutonium}   # browser profiles
RUN_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
# The installed shells, shells.json and their logs (docs/features/SHELL_PACKAGES.md).
# A worktree's slot has its own, so testing never touches yours.
if (( SLOT )); then PLUTO_HOME=${PLUTO_HOME:-$DATA_DIR/pluto-s$SLOT}; else PLUTO_HOME=${PLUTO_HOME:-$HOME/.pluto}; fi
# The helper serves static shells at http://<name>.localhost:<this port>/.
SHELLS_PORT=${SHELLS_PORT:-$(slot_port 8770)}

die() { echo "plutonium: $*" >&2; exit 1; }

# Where Ash runs: here, on the host. A checkout can run it in its container
# instead (dev/env.sh replaces these).
#   on_ash [-e VAR=value]... <command>   run a command there
#   on_ash_setsid ...                    the same, in a session of its own
#   on_ash_daemon <command>              start a daemon there, detached
on_ash() {
  local env=()
  while [[ $1 == -e ]]; do env+=("$2"); shift 2; done
  env "${env[@]}" "$@"
}
on_ash_setsid() {
  local env=()
  while [[ $1 == -e ]]; do env+=("$2"); shift 2; done
  setsid env "${env[@]}" "$@"
}
on_ash_daemon() { setsid "$@" < /dev/null > /dev/null 2>&1 & }
chrome_built() { [[ -x $CHROME_BIN ]]; }
# What a session needs before it starts Ash.
need_ash_runtime() { :; }
# What fixes a missing chrome, or the system D-Bus missing where Ash runs.
CHROME_FIX="install Plutonium again"
ASH_RUNTIME_FIX=
# Before Ash starts (lib/session.sh): more of its environment, in ASH_ENV.
ash_prepare() { :; }
# The shell library the helper serves (/v1/shell.js), in SHELL_LIBRARY.
shell_library() { SHELL_LIBRARY=$ROOT/helper/web; }

# A session's Wayland socket, DevTools and helper ports, and profile, for a
# mode (drm or x11) in this checkout's slot. PRIVATE_XDISP is the Xvfb an X11
# session starts when it's given no display.
session_vars() {
  if [[ $1 == drm ]]; then
    SOCKET=wayland-plutonium$SLOT_SUFFIX CDP_PORT=$(slot_port 9224) HELPER_PORT=$(slot_port 3782)
  else
    SOCKET=wayland-plutonium-x11$SLOT_SUFFIX CDP_PORT=$(slot_port 9223) HELPER_PORT=$(slot_port 3781)
  fi
  PROFILE=$DATA_DIR/profile-$1$SLOT_SUFFIX
}
PRIVATE_XDISP=:$(( 99 + SLOT ))

[[ -n $DEV ]] && . "$ROOT/dev/env.sh"

LOGS=${LOGS:-$DATA_DIR/logs}
CHROME_BIN=${CHROME_BIN:-$ROOT/chrome/chrome}
# A release install's own node, kept off PATH, where the apps a session starts
# would find it; else the host's.
NODE=node
[[ -x $ROOT/node/bin/node ]] && NODE=$ROOT/node/bin/node
# How Ash's command line starts, for pgrep and pkill: any chrome. Which build a
# checkout runs can change while a session is up, and the profile tells
# sessions apart.
ASH_BIN=${ASH_BIN:-'[^ ]*/chrome'}

# Every Ash a Plutonium launcher starts has this on its command line; the kill
# switch and the launchers find Ash by it.
ASH_MARK=--plutonium-shell-origin=

# The helper reads this when it starts a thread's X server.
[[ -n ${PLUTONIUM_XWAYLAND_SATELLITE:-} ]] && export PLUTONIUM_XWAYLAND_SATELLITE

mkdir -p "$LOGS"
