#!/usr/bin/env bash
# One Plutonium session: the helper (plutoniumd, on the host) and Ash (on the
# host, or in a checkout's container: on_ash, lib/common.sh) with the given shells. `plutonium run`
# sets the variables below and execs this; see `plutonium run --help`.
#
#   MODE         drm (Ash owns the display and input on a VT) or x11 (Ash in an
#                X11 window, or on a private Xvfb)
#   SHELL_URL    the first shell's page, opened as the desktop
#   SHELLS       more shells, "<name>=<url>|<name>=<url>" (Super+Tab switches)
#   ORIGINS      every shell's origin, comma-separated (for the helper)
#   PERSIST_SHELLS  the shells are shells.json's: the switcher's changes go back to it
#   SAFE_MODE    the shipped plain shell only (plutonium run --safe)
#   SOCKET       Exo's Wayland socket name; CDP_PORT, HELPER_PORT, PROFILE
#   drm:  VT (run in the session logged in on ttyN), HOLD_S (stop after N
#         seconds)
#   x11:  XDISP (PRIVATE_XDISP, :99 in slot 0, starts a private Xvfb), BOUNDS
#         (--ash-host-window-bounds: several, comma-separated, for several
#         displays), XVFB_SIZE (the private Xvfb's screen, default 1600x1000)
#   EXTRA_FLAGS  more Chromium flags, VMODULE
# The whole script is one compound command: bash reads it all before running
# any, so changing this file under a running session can't break it (it did:
# an edit while Ash ran made its exit path a syntax error, 2026-10-26).
{
set -u
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

TAG=$SOCKET
LOG=$LOGS/session-$TAG.log
ASH_LOG=$LOGS/ash-$TAG.log
HELPER_LOG=$LOGS/helper-$TAG.log
VMODULE=${VMODULE:-embedded_windows=1}
log() { echo "$(date +%T) $*" | tee -a "$LOG"; }

# Ash's browser process for this profile. Anchored on the binary and its first
# flag, so it matches neither Ash's children (zygote, renderers: killing them
# along with the browser makes its shutdown abort) nor the pkill/pgrep (or
# podman) command line that carries the pattern.
ash_pattern="^$ASH_BIN --enable-wayland-server .*--user-data-dir=$PROFILE( |\$)"
ash_running() { pgrep -f "$ash_pattern" > /dev/null; }
stop_ash() { on_ash pkill "-${1:-TERM}" -f "$ash_pattern" 2>/dev/null; }

# The helper's one dependency (playwright-core, for agents' page automation),
# installed into helper/node_modules the first time, and again when the lock
# file changes.
ensure_helper_deps() {
  local lock=$ROOT/helper/package-lock.json stamp=$ROOT/helper/node_modules/.plutonium-lock
  [[ -f $stamp ]] && cmp -s "$lock" "$stamp" && return
  log "installing the helper's dependencies (npm ci in helper/)"
  if (cd "$ROOT/helper" && npm ci --omit=dev --no-audit --no-fund --loglevel=error) >> "$HELPER_LOG" 2>&1; then
    cp "$lock" "$stamp"
  else
    log "WARNING: npm ci failed in helper/ ($HELPER_LOG): agents can't drive pages"
  fi
}

# EXO-CAPTURE: the desktop portal's ScreenCast and Screenshot backend is the
# helper (docs/features/CAPTURE.md, "The portal backend"). DRM sessions
# install its files, and point the user's xdg-desktop-portal at it: they set
# XDG_CURRENT_DESKTOP=Plutonium for D-Bus activation and systemd and restart
# the portal, and put back what was there when the session ends (Ash exits,
# plutonium stop, Ctrl+Alt+Backspace, a crash), so a desktop on another VT
# gets its own backends again. PORTAL_SESSION=0 leaves the portal alone. X11
# test sessions use tools/portal-bus.sh instead.
setup_portal() {
  [[ $MODE == drm ]] || return 0
  local data=${XDG_DATA_HOME:-$HOME/.local/share} config=${XDG_CONFIG_HOME:-$HOME/.config}
  install -Dm644 "$ROOT/helper/portal/plutonium.portal" "$data/xdg-desktop-portal/portals/plutonium.portal"
  install -Dm644 "$ROOT/helper/portal/plutonium-print.portal" "$data/xdg-desktop-portal/portals/plutonium-print.portal"
  install -Dm644 "$ROOT/helper/portal/plutonium-portals.conf" "$config/xdg-desktop-portal/plutonium-portals.conf"
  [[ ${PORTAL_SESSION:-1} == 1 ]] || return 0
  # What to put back. A session that ended without its teardown (killed)
  # left Plutonium there: that isn't the user's.
  PORTAL_PREVIOUS=$(systemctl --user show-environment 2>/dev/null | sed -n 's/^XDG_CURRENT_DESKTOP=//p')
  [[ $PORTAL_PREVIOUS == Plutonium ]] && PORTAL_PREVIOUS=
  trap restore_portal EXIT
  export XDG_CURRENT_DESKTOP=Plutonium
  dbus-update-activation-environment --systemd XDG_CURRENT_DESKTOP=Plutonium 2>/dev/null ||
    log "WARNING: couldn't pass XDG_CURRENT_DESKTOP to D-Bus activation: apps' screen capture may not reach the helper"
  start_graphical_session
  systemctl --user try-restart xdg-desktop-portal.service 2>/dev/null || true
  log "portal: xdg-desktop-portal uses the helper for screen capture (XDG_CURRENT_DESKTOP=Plutonium; PORTAL_SESSION=0 to leave it)"
}

# xdg-desktop-portal.service is Requisite= on graphical-session.target, so
# with no desktop's session up (Plutonium the only one since boot) every
# activation fails ("Dependency failed") and apps get no file picker, screen
# capture or print dialog. That target refuses a manual start; a desktop
# brings it up with its own target bound to it, as niri and sway do. Ours
# lives in the runtime dir and is stopped with the session. If another
# desktop already has it up, it's left alone.
GRAPHICAL_SESSION_STARTED=0
start_graphical_session() {
  systemctl --user is-active --quiet graphical-session.target 2>/dev/null && return 0
  local dir=$RUN_DIR/systemd/user
  mkdir -p "$dir"
  cat >"$dir/plutonium-session.target" <<'UNIT'
[Unit]
Description=Plutonium session
BindsTo=graphical-session.target
Wants=graphical-session-pre.target
After=graphical-session-pre.target
UNIT
  systemctl --user daemon-reload 2>/dev/null
  if systemctl --user start plutonium-session.target 2>/dev/null; then
    GRAPHICAL_SESSION_STARTED=1
    log "portal: started graphical-session.target (plutonium-session.target), which xdg-desktop-portal needs"
  else
    log "WARNING: couldn't start graphical-session.target: xdg-desktop-portal won't run (no file pickers, capture or printing for apps)"
  fi
}

stop_graphical_session() {
  [[ $GRAPHICAL_SESSION_STARTED == 1 ]] || return 0
  systemctl --user stop plutonium-session.target 2>/dev/null || true
  GRAPHICAL_SESSION_STARTED=0
}

restore_portal() {
  if [[ -n $PORTAL_PREVIOUS ]]; then
    dbus-update-activation-environment --systemd XDG_CURRENT_DESKTOP="$PORTAL_PREVIOUS" 2>/dev/null
  else
    # D-Bus activation can't unset a variable: empty is as good.
    dbus-update-activation-environment XDG_CURRENT_DESKTOP= 2>/dev/null
    systemctl --user unset-environment XDG_CURRENT_DESKTOP 2>/dev/null
  fi
  stop_graphical_session
  systemctl --user try-restart xdg-desktop-portal.service 2>/dev/null || true
  log "portal: XDG_CURRENT_DESKTOP back to ${PORTAL_PREVIOUS:-unset}"
}

start_helper() {
  shell_library
  local pidfile=$RUN_DIR/plutonium/helper-$TAG.pid
  mkdir -p "$RUN_DIR/plutonium"
  ensure_helper_deps
  setup_portal
  [[ -f $pidfile ]] && kill "$(cat "$pidfile")" 2>/dev/null && sleep 1
  # On DRM, the logind session Ash runs in, not the one this was started from
  # (`run --vt tty5` from tty4): the helper follows its Lock signal, sets its
  # backlight, and apps it launches are in it.
  local logind=()
  [[ -n ${SID:-} ]] && logind=(XDG_SESSION_ID="$SID" PLUTONIUM_LOGIND_SESSION="$SID" PLUTONIUM_LOGIND_TTY="$(session_prop TTY)")
  # Apps the helper launches inherit its environment: leave out an agent
  # session's own variables when this runs from one (Claude Code).
  setsid env $(env | sed -n 's/^\(CLAUDE[A-Z_]*\)=.*/-u \1/p') "${logind[@]}" \
    PLUTONIUM_SHELL_LIBRARY="$SHELL_LIBRARY/plutonium-shell.js" \
    "$NODE" "$ROOT/helper/plutonium.ts" daemon --wayland-display "$SOCKET" --socket "$RUN_DIR/plutonium/$SOCKET.sock" \
    --shell-origin "$ORIGINS" --port "$HELPER_PORT" --cdp-port "$CDP_PORT" \
    --shells-port "$SHELLS_PORT" --slot "$SLOT" --pluto-home "$PLUTO_HOME" ${PERSIST_SHELLS:+--persist-shells} \
    > "$HELPER_LOG" 2>&1 < /dev/null &
  echo $! > "$pidfile"
}

# The servers of the session's installed shells (Hydra's) start with the
# helper: wait for them before the browser opens their pages.
wait_shell_servers() {
  local sock=$RUN_DIR/plutonium/$SOCKET.sock
  for _ in $(seq 1 50); do [[ -S $sock ]] && break; sleep 0.1; done
  curl -s -m 120 --unix-socket "$sock" http://helper/v1/shells/wait | grep -o '"detail":"[^"]*"' | cut -d'"' -f4 |
    grep -v '^Stopped' | sed 's/^/shell server: /' | while read -r line; do log "$line"; done
}

# A Vulkan driver (an ICD manifest, where the loader looks for one) where Ash runs.
vulkan_driver() {
  on_ash sh -c '[ -n "${VK_ICD_FILENAMES:-}${VK_DRIVER_FILES:-}" ] ||
    ls /usr/share/vulkan/icd.d/*.json /etc/vulkan/icd.d/*.json /run/opengl-driver/share/vulkan/icd.d/*.json \
      "${XDG_DATA_HOME:-$HOME/.local/share}"/vulkan/icd.d/*.json 2> /dev/null | grep -q .'
}

report_gpu() {
  case "$(curl -s --unix-socket "$RUN_DIR/plutonium/$SOCKET.sock" http://helper/v1/status)" in
    *'"accelerated":true'*) log "GPU: apps on $SOCKET render on the GPU" ;;
    *'"accelerated":false'*) log "WARNING: apps on $SOCKET can't find the GPU and render in software ($HELPER_LOG)" ;;
  esac
}

# Web APIs ChromeOS has and desktop Linux Chromium doesn't, so pages can't
# tell them apart (LINUX_COMPAT.md): Blink's HandwritingRecognition and
# BarcodeDetector follow these features (Web Share and Web Bluetooth are off
# in the UA patch). Not --disable-blink-features, which shows Chrome's
# "unsupported command-line flag" infobar.
FLAGS=(--enable-wayland-server "--wayland-server-socket=$SOCKET"
       "--remote-debugging-port=$CDP_PORT" "--user-data-dir=$PROFILE"
       --disable-features=Forest,HandwritingRecognition,BarcodeDetector
       --disable-sync --exo-viability-no-signin-error
       "--plutonium-shell-origin=${ORIGINS%%,*}" "--plutonium-shell-url=$SHELL_URL"
       --plutonium-hide-windows
       "--plutonium-helper-url=http://127.0.0.1:$HELPER_PORT"
       "--plutonium-helper-socket=$RUN_DIR/plutonium/$SOCKET.sock"
       --enable-logging=stderr --v=0 "--vmodule=$VMODULE")
# The whole list, in order ("!" before shells that are off): the browser's
# list becomes it.
[[ -n ${SHELLS:-} ]] && FLAGS+=("--plutonium-shells=$SHELLS" --plutonium-shells-exact)
# speechSynthesis through the host's speech-dispatcher, when it has one
# (LINUX_COMPAT.md, "Speech synthesis"): Chromium dlopen()s libspeechd and
# talks to its socket in $XDG_RUNTIME_DIR, which the container shares. Usually
# a socket-activated user unit; else one started here (-t 0: it stays, as a
# container can't autospawn one).
SPEECHD_SOCKET=$RUN_DIR/speech-dispatcher/speechd.sock
if [[ ! -S $SPEECHD_SOCKET ]] && command -v speech-dispatcher > /dev/null; then
  speech-dispatcher --spawn -t 0 > /dev/null 2>&1 || true
fi
[[ -S $SPEECHD_SOCKET ]] && FLAGS+=(--enable-speech-dispatcher)
# Pages see the host's timezone and language, which a container doesn't have
# (it says UTC): a zone name the container's tzdata knows.
HOST_TZ=$(timedatectl show -p Timezone --value 2>/dev/null)
[[ -n $HOST_TZ ]] || HOST_TZ=$(readlink -f /etc/localtime 2>/dev/null | sed -n 's|.*/zoneinfo/||p')
ASH_ENV=(-e "TZ=${HOST_TZ:-UTC}" -e "LANG=${LANG:-C.UTF-8}")
# The desktop session's bus, for MPRIS (LINUX_COMPAT.md, "Media sessions").
[[ -n ${DBUS_SESSION_BUS_ADDRESS:-} ]] && ASH_ENV+=(-e "DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS")

: > "$LOG"
need_ash_runtime
ash_prepare
chrome_built || { log "ABORT: no Chromium at $CHROME_BIN ($CHROME_FIX)"; exit 1; }
ash_running && { log "ABORT: an Ash with profile $PROFILE is already running (plutonium stop)"; exit 1; }
mkdir -p "$PROFILE"
log "$MODE session: $SHELL_URL${SHELLS:+ + $SHELLS}; socket $SOCKET, DevTools $CDP_PORT, helper $HELPER_PORT"
rm -f "$RUN_DIR/$SOCKET" "$RUN_DIR/$SOCKET.lock"
[[ -f $ASH_LOG ]] && mv "$ASH_LOG" "${ASH_LOG%.log}.prev.log"

if [[ $MODE == x11 ]]; then
  XDISP=${XDISP:-$PRIVATE_XDISP}
  # GPU path (docs/features/GPU_X11.md): Skia and ANGLE on Vulkan sharing one
  # device, native GPU memory buffers, so Exo offers dmabufs with the render node.
  # It needs a Vulkan driver where Ash runs (the host's, for a release install):
  # without one, the GPU process can't start, and Ash has no software fallback.
  FLAGS+=(--use-system-clipboard "--ash-host-window-bounds=${BOUNDS:-0+0-1600x1000}")
  # NixOS keeps its drivers in /run/opengl-driver, where only its own Vulkan
  # loader looks; chrome's (a release's) looks in XDG_DATA_DIRS.
  if on_ash test -d /run/opengl-driver/share/vulkan/icd.d; then
    ASH_ENV+=(-e "XDG_DATA_DIRS=${XDG_DATA_DIRS:-/usr/local/share:/usr/share}:/run/opengl-driver/share")
  fi
  if vulkan_driver; then
    FLAGS+=(--enable-native-gpu-memory-buffers --use-angle=vulkan
            --enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan)
  else
    log "WARNING: no Vulkan driver where Ash runs: it draws with GL, and apps can't share its GPU buffers (plutonium doctor)"
  fi
  # shellcheck disable=SC2206
  FLAGS+=(${EXTRA_FLAGS:-})
  # A crashed Xvfb leaves its socket (in /tmp/.X11-unix, shared with the host
  # and the other container) and its lock (this container's /tmp); the socket
  # would make us skip starting one (Ash: "Missing X server").
  if [[ $XDISP == "$PRIVATE_XDISP" ]] &&
     on_ash sh -c 'p=$(tr -d " " 2>/dev/null < "/tmp/.X$1-lock") && [ -n "$p" ] && [ ! -d "/proc/$p" ]' sh "${XDISP#:}"; then
    on_ash rm -f "/tmp/.X11-unix/X${XDISP#:}" "/tmp/.X${XDISP#:}-lock"
  fi
  if [[ $XDISP == "$PRIVATE_XDISP" ]] && ! on_ash test -S "/tmp/.X11-unix/X${XDISP#:}"; then
    on_ash_daemon Xvfb "$XDISP" -screen 0 "${XVFB_SIZE:-1600x1000}x24" +extension XInputExtension
    for _ in $(seq 1 20); do on_ash test -S "/tmp/.X11-unix/X${XDISP#:}" && break; sleep 0.5; done
  fi
  start_helper
  wait_shell_servers
  on_ash_setsid -e DISPLAY="$XDISP" ${XAUTHORITY:+-e XAUTHORITY="$XAUTHORITY"} "${ASH_ENV[@]}" \
    "$CHROME_BIN" "${FLAGS[@]}" > "$ASH_LOG" 2>&1 < /dev/null &
  # Until it answers, or it has exited (after 5 s: a container's exec takes a
  # moment to start it).
  up=
  for i in $(seq 1 40); do
    sleep 1
    [[ -S $RUN_DIR/$SOCKET ]] && curl -s "localhost:$CDP_PORT/json/version" > /dev/null && { up=1; break; }
    (( i < 5 )) || ash_running || break
  done
  if [[ -z $up ]]; then
    log "ABORT: Ash didn't come up. The end of its log ($ASH_LOG):"
    grep -E 'FATAL|ERROR' "$ASH_LOG" | tail -n 5 | cut -c1-300 | tee -a "$LOG"
    stop_ash KILL
    kill "$(cat "$RUN_DIR/plutonium/helper-$TAG.pid" 2>/dev/null)" 2>/dev/null
    exit 1
  fi
  sleep 2
  report_gpu
  log "Ash is up (log $ASH_LOG, helper log $HELPER_LOG). Stop it with: plutonium stop"
  exit 0
fi

# --- DRM ---------------------------------------------------------------------
# Ash is the controller of a logind session on a VT (docs/features/SEAT.md):
# it opens the display and input devices through logind, which switches VTs
# for it (Ctrl+Alt+Fn), takes the devices away while another VT is in front
# and gives them back, and puts the VT back in text mode when Ash exits, even
# if it crashes or is killed.

# The logind session to run in: the one logged in on $VT, or this shell's own.
session_id() {
  [[ -z ${VT:-} ]] && { echo "${XDG_SESSION_ID:-}"; return; }
  local sid
  for sid in $(loginctl list-sessions --no-legend | awk -v u="$(id -u)" '$2==u {print $1}'); do
    [[ $(loginctl show-session "$sid" -p TTY --value) == "$VT" ]] && { echo "$sid"; return; }
  done
}
session_prop() { loginctl show-session "$SID" -p "$1" --value 2>/dev/null; }

SID=$(session_id)
if [[ -z $SID ]]; then
  if [[ -n ${VT:-} ]]; then log "ABORT: nobody of yours is logged in on $VT"
  else log "ABORT: this shell is in no logind session; log in on a text console (Ctrl+Alt+F2), or pass --vt ttyN"; fi
  exit 1
fi
if [[ -z $(session_prop Seat) || $(session_prop VTNr) == 0 ]]; then
  log "ABORT: session $SID ($(session_prop Type), $(session_prop TTY)) is not on a seat's VT; run this from a text console (Ctrl+Alt+F2), or pass --vt ttyN"
  exit 1
fi
on_ash test -S /run/dbus/system_bus_socket ||
  { log "ABORT: no system D-Bus where Ash runs (/run/dbus/system_bus_socket)${ASH_RUNTIME_FIX:+; $ASH_RUNTIME_FIX}"; exit 1; }
[[ -n ${HOLD_S:-} ]] && log "Ash stops by itself after $HOLD_S s"
# A session that isn't in front starts too: Ash waits for it with the
# displays and input devices untouched.
[[ $(session_prop Active) == yes ]] ||
  log "session $SID ($(session_prop TTY)) is not in front; Ash comes up when it is (Ctrl+Alt+F$(session_prop VTNr))"

start_helper
wait_shell_servers
echo "Starting Ash on DRM in session $SID ($(session_prop TTY)). Ctrl+Alt+F1…F12 switch VTs, Ctrl+Alt+Backspace ends it."
FLAGS+=(--ozone-platform=drm --use-angle=gles-egl --exo-viability-real-displays
        "--plutonium-logind-session=$SID"
        # No ChromeOS gestures library in this build: touchpads go through
        # libinput (use_libinput=true in args.gn) or they don't move the cursor.
        --enable-features=LibinputHandleTouchpad)
# shellcheck disable=SC2206
FLAGS+=(${EXTRA_FLAGS:-})
log "starting Ash (log $ASH_LOG)"
on_ash "${ASH_ENV[@]}" "$CHROME_BIN" "${FLAGS[@]}" > "$ASH_LOG" 2>&1 < /dev/null &
ash=$!
( for _ in $(seq 1 40); do [[ -S $RUN_DIR/$SOCKET ]] && break; sleep 1; done; sleep 3; report_gpu ) &
if [[ -n ${HOLD_S:-} ]]; then
  ( sleep "$HOLD_S"; log "hold time reached, stopping Ash"; stop_ash ) &
  stopper=$!
fi
wait $ash
rc=$?
log "Ash exited ($rc)"
[[ -n ${stopper:-} ]] && kill "$stopper" 2>/dev/null
# Its children too, before anyone else takes the display.
stop_ash KILL
# Ash's status, for plutonium session start: SIGTERM (Ctrl+Alt+Backspace,
# plutonium stop) is a clean 0.
exit "$rc"
}
