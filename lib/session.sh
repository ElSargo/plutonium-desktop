#!/usr/bin/env bash
# One Plutonium session: the helper (plutoniumd, on the host) and Ash (in the
# container, or on the host with HOST=1) with the given shells. `plutonium run`
# sets the variables below and execs this; see `plutonium run --help`.
#
#   MODE         drm (Ash owns the display and input on a VT) or x11 (Ash in an
#                X11 window, or on a private Xvfb)
#   SHELL_URL    the first shell's page, opened as the desktop
#   SHELLS       more shells, "<name>=<url>|<name>=<url>" (Super+Tab switches)
#   ORIGINS      every shell's origin, comma-separated (for the helper)
#   SOCKET       Exo's Wayland socket name; CDP_PORT, HELPER_PORT, PROFILE
#   drm:  VT (run against ttyN through sudo), HOLD_S (stop after N seconds),
#         NO_KILLSWITCH, WAIT_S (with HOLD_S: wait for the graphical session to
#         go inactive first)
#   x11:  XDISP (:99 starts a private Xvfb), BOUNDS
#   EXTRA_FLAGS  more Chromium flags, VMODULE
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

start_helper() {
  local pidfile=$RUN_DIR/plutonium/helper-$TAG.pid
  mkdir -p "$RUN_DIR/plutonium"
  [[ -f $pidfile ]] && kill "$(cat "$pidfile")" 2>/dev/null && sleep 1
  # Apps the helper launches inherit its environment: leave out an agent
  # session's own variables when this runs from one (Claude Code).
  setsid env $(env | sed -n 's/^\(CLAUDE[A-Z_]*\)=.*/-u \1/p') \
    node "$ROOT/helper/plutonium.ts" daemon --wayland-display "$SOCKET" \
    --shell-origin "$ORIGINS" --port "$HELPER_PORT" --cdp-port "$CDP_PORT" > "$HELPER_LOG" 2>&1 < /dev/null &
  echo $! > "$pidfile"
}

report_gpu() {
  case "$(curl -s --unix-socket "$RUN_DIR/plutonium/$SOCKET.sock" http://helper/v1/status)" in
    *'"accelerated":true'*) log "GPU: apps on $SOCKET render on the GPU" ;;
    *'"accelerated":false'*) log "WARNING: apps on $SOCKET can't find the GPU and render in software ($HELPER_LOG)" ;;
  esac
}

FLAGS=(--enable-wayland-server "--wayland-server-socket=$SOCKET"
       "--remote-debugging-port=$CDP_PORT" "--user-data-dir=$PROFILE"
       --disable-features=Forest --disable-sync --exo-viability-no-signin-error
       "--plutonium-shell-origin=${ORIGINS%%,*}" "--plutonium-shell-url=$SHELL_URL"
       --plutonium-hide-windows
       --enable-logging=stderr --v=0 "--vmodule=$VMODULE")
[[ -n ${SHELLS:-} ]] && FLAGS+=("--plutonium-shells=$SHELLS")

: > "$LOG"
need_ash_runtime
chrome_built || { log "ABORT: no Chromium at $CHROME_BIN (plutonium chromium build, or PREBUILT=1 and plutonium image pull)"; exit 1; }
ash_running && { log "ABORT: an Ash with profile $PROFILE is already running (plutonium stop)"; exit 1; }
mkdir -p "$PROFILE"
log "$MODE session: $SHELL_URL${SHELLS:+ + $SHELLS}; socket $SOCKET, DevTools $CDP_PORT, helper $HELPER_PORT"
rm -f "$RUN_DIR/$SOCKET" "$RUN_DIR/$SOCKET.lock"
[[ -f $ASH_LOG ]] && mv "$ASH_LOG" "${ASH_LOG%.log}.prev.log"

if [[ $MODE == x11 ]]; then
  XDISP=${XDISP:-:99}
  # GPU path (docs/features/GPU_X11.md): Skia and ANGLE on Vulkan sharing one
  # device, native GPU memory buffers, so Exo offers dmabufs with the render node.
  FLAGS+=(--enable-native-gpu-memory-buffers --use-angle=vulkan
          --enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan
          --use-system-clipboard "--ash-host-window-bounds=${BOUNDS:-0+0-1600x1000}")
  # shellcheck disable=SC2206
  FLAGS+=(${EXTRA_FLAGS:-})
  if [[ $XDISP == :99 ]] && ! on_ash test -S /tmp/.X11-unix/X99; then
    # Detached: a background process of an attached exec keeps its session
    # (and pm's systemd-run --wait) from ever ending.
    xvfb=(Xvfb :99 -screen 0 1600x1000x24 +extension XInputExtension)
    if [[ -n ${HOST:-} ]]; then setsid "${xvfb[@]}" </dev/null >/dev/null 2>&1 &
    else pm exec -d "$CONTAINER" "${xvfb[@]}" > /dev/null; fi
    for _ in $(seq 1 20); do on_ash test -S /tmp/.X11-unix/X99 && break; sleep 0.5; done
  fi
  # The container sees the runtime dir, not the rest of $HOME.
  if [[ -z ${HOST:-} && -n ${XAUTHORITY:-} && $XAUTHORITY != "$RUN_DIR"/* && -f $XAUTHORITY ]]; then
    mkdir -p "$RUN_DIR/plutonium"
    cp "$XAUTHORITY" "$RUN_DIR/plutonium/xauthority"
    XAUTHORITY=$RUN_DIR/plutonium/xauthority
  fi
  start_helper
  if [[ -n ${HOST:-} ]]; then
    setsid env DISPLAY="$XDISP" "$CHROME_BIN" "${FLAGS[@]}" > "$ASH_LOG" 2>&1 < /dev/null &
  else
    setsid $PODMAN exec -e DISPLAY="$XDISP" ${XAUTHORITY:+-e XAUTHORITY="$XAUTHORITY"} "$CONTAINER" \
      "$CHROME_BIN" "${FLAGS[@]}" > "$ASH_LOG" 2>&1 < /dev/null &
  fi
  for _ in $(seq 1 40); do
    [[ -S $RUN_DIR/$SOCKET ]] && curl -s "localhost:$CDP_PORT/json/version" > /dev/null && break
    sleep 1
  done
  sleep 2
  report_gpu
  log "Ash is up (log $ASH_LOG, helper log $HELPER_LOG). Stop it with: plutonium stop"
  exit 0
fi

# --- DRM ---------------------------------------------------------------------
# A graphical session of this user (Plasma, GNOME, …), which must not hold the
# display while Ash takes it.
graphical_session() {
  local sid
  for sid in $(loginctl list-sessions --no-legend | awk -v u="$(id -u)" '$2==u {print $1}'); do
    loginctl show-session "$sid" -p Type --value | grep -qE '^(wayland|x11)$' && { echo "$sid"; return; }
  done
}
graphical_active() { [[ -n $GUI && $(loginctl show-session "$GUI" -p Active --value) == yes ]]; }
killswitch_ok() {
  [[ $(systemctl --user is-active plutonium-killswitch 2>/dev/null) == active ]] &&
    journalctl --user -u plutonium-killswitch -o cat --no-pager -n 50 |
      grep -E 'killswitch starting|listening on|lost |device not found' | tail -1 | grep -q 'listening on'
}
# lib/tty_vt.py on this shell's VT, or as root on $VT.
tty_vt() {
  if [[ -n ${VT:-} ]]; then sudo -n "$(command -v python3)" "$ROOT/lib/tty_vt.py" "$@" < "/dev/$VT"
  else python3 "$ROOT/lib/tty_vt.py" "$@"; fi
}

GUI=$(graphical_session)
if ! killswitch_ok; then
  if [[ -n ${HOLD_S:-} ]]; then log "no kill switch; Ash stops by itself after $HOLD_S s"
  elif [[ -n ${NO_KILLSWITCH:-} ]]; then log "WARNING: no kill switch; only stopping Ash from elsewhere (ssh: plutonium stop --drm) gets the VT back"
  else log "ABORT: the kill switch is not listening (plutonium killswitch install), and no --hold or --no-killswitch"; exit 1
  fi
fi
if [[ -n ${HOLD_S:-} && -n ${WAIT_S:-} ]]; then
  for _ in $(seq 1 "$WAIT_S"); do graphical_active || break; sleep 1; done
fi
graphical_active && { log "ABORT: the graphical session $GUI is active; run this from a text VT (Ctrl+Alt+F2 and log in) or with --vt"; exit 1; }
tty_vt check >> "$LOG" 2>&1 || { log "ABORT: ${VT:-stdin} is not the active VT"; exit 1; }

start_helper
echo "Starting Ash on DRM. This VT's keyboard is off until it exits."
tty_vt graphics >> "$LOG" 2>&1 || { log "ABORT: could not set KD_GRAPHICS/K_OFF"; exit 1; }
trap 'tty_vt restore >> "$LOG" 2>&1' EXIT

FLAGS+=(--ozone-platform=drm --use-angle=gles-egl --exo-viability-real-displays
        # No ChromeOS gestures library in this build: touchpads go through
        # libinput (use_libinput=true in args.gn) or they don't move the cursor.
        --enable-features=LibinputHandleTouchpad)
# shellcheck disable=SC2206
FLAGS+=(${EXTRA_FLAGS:-})
log "starting Ash (log $ASH_LOG)"
on_ash "$CHROME_BIN" "${FLAGS[@]}" > "$ASH_LOG" 2>&1 < /dev/null &
ash=$!
( for _ in $(seq 1 40); do [[ -S $RUN_DIR/$SOCKET ]] && break; sleep 1; done; sleep 3; report_gpu ) &
if [[ -n ${HOLD_S:-} ]]; then
  ( sleep "$HOLD_S"; log "hold time reached, stopping Ash"; stop_ash ) &
  stopper=$!
fi
wait $ash
log "Ash exited ($?)"
[[ -n ${stopper:-} ]] && kill "$stopper" 2>/dev/null
# Let DRM master go before anyone else takes the display.
stop_ash KILL
exit 0
