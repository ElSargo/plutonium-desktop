#!/usr/bin/env bash
# Live checks of who gets the shell's window broker (EXO-BROKER): an X11
# session in this checkout's slot whose only shell is index.html here, two
# foot windows, and checks.js run in the shell page over DevTools.
#
#   tools/shell-checks/run.sh            the shell API as shipped
#   tools/shell-checks/run.sh --forced   every page sees the API
#                                        (--enable-blink-features=PlutoniumShell),
#                                        so only the browser's checks count
#
# Stops this slot's X11 session first, and when done (--keep leaves it up).
# Exits non-zero if a check fails. Needs foot on the host.
set -euo pipefail
. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../lib/common.sh"

forced= keep=
for arg in "$@"; do
  case $arg in
    --forced) forced=1 ;;
    --keep) keep=1 ;;
    *) echo "usage: $0 [--forced] [--keep]" >&2; exit 2 ;;
  esac
done

session_vars x11
PORT=$(slot_port 8790)
SHELL_URL=http://127.0.0.1:$PORT/index.html
export CDP=$CDP_ADDR
plutonium() { "$ROOT/bin/plutonium" "$@"; }
cdp_eval() { plutonium cdp eval "$@"; }

# Serves this directory: 127.0.0.1 is the shell's origin, localhost (the same
# server) another site.
pidfile=$RUN_DIR/plutonium/serve-$PORT.pid
mkdir -p "$RUN_DIR/plutonium"
[[ -f $pidfile ]] && kill "$(cat "$pidfile")" 2> /dev/null && sleep 0.5
setsid python3 "$ROOT/tools/shell-checks/serve.py" "$PORT" > /dev/null 2>&1 < /dev/null &
echo $! > "$pidfile"
for _ in $(seq 1 20); do curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.2; done

plutonium stop --x11 > /dev/null || true
flags="--vmodule=embedded_windows=1,exo_window_broker=1,exo_embedder=1,plutonium_shell=1"
[[ -n $forced ]] && flags+=" --enable-blink-features=PlutoniumShell"
plutonium run --x11 --flags "$flags" "checks=$SHELL_URL" > /dev/null
cleanup() {
  [[ -n ${foot_pids:-} ]] && kill $foot_pids 2> /dev/null || true
  [[ -n $keep ]] && return
  plutonium stop --x11 > /dev/null || true
  kill "$(cat "$pidfile")" 2> /dev/null || true
}
trap cleanup EXIT

foot_pids=
for title in checks-one checks-two; do
  WAYLAND_DISPLAY=$SOCKET setsid foot -T "$title" sh -c 'exec sleep 600' > /dev/null 2>&1 < /dev/null &
  foot_pids+=" $!"
done
for _ in $(seq 1 30); do
  [[ $(cdp_eval "$SHELL_URL" "navigator.windowBroker.getWindows().then(w => w.length)" 2> /dev/null) == 2 ]] && break
  sleep 1
done

forced_js=false
[[ -n $forced ]] && forced_js=true
echo "== checks ($([[ -n $forced ]] && echo "API forced on every page" || echo "API as shipped"))"
checks() {   # <function> [--gesture]: its results, as JSON
  cdp_eval "$SHELL_URL" "import('/checks.js').then(m => m.$1({ forced: $forced_js })).then(r => JSON.stringify(r))" ${2:-}
}
results=("$(checks run)" "$(checks openPopup --gesture)" "$(checks openBlank --gesture)")
# DevTools attached to the page turns prerendering off: start it, let go,
# and come back.
cdp_eval "$SHELL_URL" "import('/checks.js').then(m => m.startPrerender())" > /dev/null
sleep 6
results+=("$(checks prerenderResults)")
# The javascript: URL document is checked last: it replaces the shell page.
cdp_eval "$SHELL_URL" "import('/checks.js').then(m => m.navigateToJavascriptUrl())" > /dev/null || true
javascript_url=null
for _ in $(seq 1 10); do
  sleep 1
  javascript_url=$(cdp_eval "$SHELL_URL" "sessionStorage.getItem('javascript-url')" 2> /dev/null || echo null)
  [[ $javascript_url != null && -n $javascript_url ]] && break
done
python3 "$ROOT/tools/shell-checks/report.py" "$javascript_url" "${results[@]}"
