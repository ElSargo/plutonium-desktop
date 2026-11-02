#!/usr/bin/env bash
# Runs one agent tool test (docs/agent-tests/README.md): a new, standalone T3
# Code thread gets the scenario's prompt and nothing else, and this records what
# it did and what the user would have seen, for the review.
#
#   run.sh [options] <scenario.md>
#     --checkout DIR   the checkout whose session to test. Default: this one.
#                      The main checkout is the live desktop; the test session
#                      is .worktrees/agent-tests (session.sh up).
#     --model M        the tester's model (default: the scenario's, else claude-opus-5-5)
#     --instance I     the provider instance it runs on (default: claudeAgent); another
#                      Claude account's, e.g. claudeAgent_claude_2, when one is at its limit
#     --timeout MIN    interrupt the thread after this long (default: the scenario's, else 20)
#     --show           open the thread in the session's T3 page, as a user watching it would
#                      (the test session only; never the live desktop)
#     --capture | --no-capture
#                      record the screen from KMS (default: on for the test session,
#                      off for the live desktop, where it would record the user's screen)
#     --x11            the checkout's X11 session (plutonium run --x11, its slot's Xvfb):
#                      no VT switch and no screen lock; the screen is a frame of the Xvfb
#                      every 2 s (screen/<epoch>.jpg) instead of a KMS recording
#
# Writes logs/agent-tests/<run>/ in the main checkout and prints its path:
#   meta.json        scenario, session, thread, times, outcome
#   prompt.txt       what the tester was sent
#   thread.json      the thread's state; thread.jsonl its timeline as T3 Code shows it
#   transcript.jsonl the tester's Claude transcript: every tool call and result
#   timeline.txt     the transcript as a readable timeline (timeline.ts), tools.json, seen/
#   screen.mkv       the screen while it ran (frame.sh <run> <time> takes a frame)
#   logs/            what the helper, Ash and T3's server logged meanwhile
#   coredumps.txt    processes that crashed meanwhile
set -eo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
checkout=$(cd "$HERE/../.." && pwd) model= instance=claudeAgent timeout_min= show= capture= x11= scenario=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --checkout) checkout=$(cd "$2" && pwd); shift ;;
    --model) model=$2; shift ;;
    --instance) instance=$2; shift ;;
    --timeout) timeout_min=$2; shift ;;
    --show) show=1 ;;
    --capture) capture=1 ;;
    --no-capture) capture=0 ;;
    --x11) x11=1 ;;
    -h|--help) sed -n '2,/^set -eo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) scenario=$(realpath "$1") ;;
  esac
  shift
done
[[ -f $scenario ]] || { echo "usage: run.sh [options] <scenario.md>" >&2; exit 2; }

# The session's settings: its T3 Code server, data and logs.
# shellcheck source=../../lib/common.sh
. "$checkout/lib/common.sh"
. "$checkout/shells/hydra/lib/env.sh"   # T3CODE_DIR, T3_HOME, T3_PORT
live=; (( SLOT )) || live=1
[[ -n $show && -n $live ]] && die "--show drives the shell's page; not on the live desktop"
capture=${capture:-$([[ -n $live ]] && echo 0 || echo 1)}

# The scenario: front matter (model:, timeout:) and the first fenced block
# under "## Prompt".
front() { awk -v k="$1" 'NR==1&&/^---$/{f=1;next} f&&/^---$/{exit} f&&$1==k":"{sub(/^[^:]*:[ \t]*/,"");print;exit}' "$scenario"; }
name=$(front name); name=${name:-$(basename "$scenario" .md)}
model=${model:-$(front model)}; model=${model:-claude-opus-5-5}
timeout_min=${timeout_min:-$(front timeout)}; timeout_min=${timeout_min:-20}
prompt=$(awk '/^## Prompt/{p=1;next} p&&/^```/{if(f)exit; f=1;next} f' "$scenario")
[[ -n $prompt ]] || die "no prompt in $scenario (a fenced block under '## Prompt')"

# The machine, before blaming the tools: a Flatpak can't start without the
# document portal's mount (bwrap: "Can't find source path /run/user/…/doc/…").
if ! mountpoint -q "/run/user/$(id -u)/doc"; then
  die "the document portal isn't mounted (/run/user/$(id -u)/doc), so no Flatpak can start: systemctl --user restart xdg-document-portal"
fi

run=$(date +%Y%m%d-%H%M%S)-$name
out=$MAIN_ROOT/logs/agent-tests/$run
mkdir -p "$out/logs"
printf '%s\n' "$prompt" > "$out/prompt.txt"
mcp() { node "$HERE/t3mcp.ts" "$T3_PORT" "$out/.token" "$@"; }
field() { node -e 'let v=JSON.parse(require("fs").readFileSync(0,"utf8")); for (const k of process.argv[1].split(".")) v=v?.[k]; console.log(v ?? "")' "$1"; }
echo "run $run: $name on $([[ -n $live ]] && echo "the live desktop" || echo "slot $SLOT") (T3 Code on $T3_PORT), $model, ${timeout_min} min"

# A test session needs the screen (only the VT on screen has the display and
# input, and the recording is of the screen), so runs on test sessions take
# turns, and each brings its own to the front (session.sh front).
if [[ -z $live && -z $x11 ]]; then
  exec 9> "$DATA_DIR/agent-tests-screen.lock"
  flock -n 9 || { echo "waiting for the screen (another test session's run)"; flock 9; }
  "$HERE/session.sh" --name "$(basename "$checkout")" front > /dev/null
  sleep 2
fi

# An MCP client session on that server, allowed to launch full-access threads.
(cd "$T3CODE_DIR" && T3CODE_HOME="$T3_HOME" node apps/server/src/bin.ts auth session issue \
  --scope=orchestration:read --scope=orchestration:operate --subject mcp-client \
  --runtime-mode-ceiling full-access --label "agent-tests $run" --ttl "$((timeout_min + 30))m" --token-only 2>&1) |
  grep -o 'eyJ[A-Za-z0-9_.-]*' | head -1 > "$out/.token"
[[ -s $out/.token ]] || die "couldn't issue a T3 Code token (is $T3CODE_DIR's T3 Code new enough: auth session issue --runtime-mode-ceiling?)"
chmod 600 "$out/.token"
mcp --list > /dev/null || die "T3 Code's MCP endpoint on $T3_PORT didn't take the token (is the session's T3 Code server running?)"

# Where the logs are now, so only what's logged during the run is kept.
declare -A offsets
logfiles=("$LOGS/t3-server.log")
for mode in drm x11; do session_vars "$mode"; logfiles+=("$LOGS/helper-$SOCKET.log" "$LOGS/ash-$SOCKET.log"); done
for f in "${logfiles[@]}"; do offsets[$f]=$(stat -c %s "$f" 2>/dev/null || echo 0); done

started=$(date +%s)
if [[ $capture == 1 && -n $x11 ]]; then
  [[ -z $live ]] || die "--x11 records the slot's Xvfb; not on the live desktop"
  mkdir -p "$out/screen"
  # Xvfb runs in the container; its socket is in the shared /tmp/.X11-unix.
  (while :; do
    in_container env DISPLAY="$PRIVATE_XDISP" import -silent -window root -quality 60 "$out/screen/$(date +%s).jpg" 2>/dev/null
    sleep 2
  done) &
  ffpid=$!
elif [[ $capture == 1 ]]; then
  FF=${FF:-$(command -v ffmpeg || echo "$(nix build --no-link --print-out-paths 'nixpkgs#ffmpeg-headless.bin' 2>/dev/null)/bin/ffmpeg")}
  date +%s.%N > "$out/.screen-start"
  sudo -n "$FF" -loglevel error -y -device /dev/dri/card1 -f kmsgrab -framerate 4 -i - \
    -vf 'hwmap=derive_device=vaapi,scale_vaapi=format=nv12' -c:v h264_vaapi -qp 28 "$out/screen.mkv" \
    2> "$out/logs/ffmpeg.log" &
  ffpid=$!
fi
stop_capture() {
  [[ -n ${ffpid:-} ]] || return 0
  if [[ -n $x11 ]]; then kill "$ffpid" 2>/dev/null || true; wait "$ffpid" 2>/dev/null || true; ffpid=; return 0; fi
  sudo -n pkill -INT -P "$ffpid" 2>/dev/null || sudo -n kill -INT "$ffpid" 2>/dev/null || true
  wait "$ffpid" 2>/dev/null || true
  sudo -n chown "$(id -u):$(id -g)" "$out/screen.mkv" 2>/dev/null || true
  ffpid=
}
trap stop_capture EXIT

# LibreOffice's recovery list is the user's too: note what's in it now, so
# what the tester leaves can be dropped afterwards (lo-recovery.py).
python3 -I "$HERE/lo-recovery.py" list > "$out/lo-recovery-before.txt" 2>/dev/null || true

launch=$(node -e 'const [t,i,m,p]=process.argv.slice(1); console.log(JSON.stringify({scratch:true,title:t,runtimeMode:"full-access",modelSelection:{instanceId:i,model:m},message:p}))' \
    "agent test: $name" "$instance" "$model" "$prompt")
thread=$(mcp t3_thread_launch "$launch" | field threadId)
[[ -n $thread ]] || die "the thread didn't launch"
echo "thread $thread"

if [[ -n $show ]]; then
  env_id=$(cat "$T3_HOME/userdata/environment-id")
  "$checkout/bin/plutonium" cdp ${x11:+--x11} eval "127.0.0.1:$T3_PORT" \
    "history.pushState({}, '', '/$env_id/${thread}'); dispatchEvent(new PopStateEvent('popstate')); location.pathname" ||
    echo "warning: couldn't open the thread in the shell" >&2
fi

# Wait for it to finish, or interrupt it at the deadline.
deadline=$((started + timeout_min * 60)) status=running
while (( $(date +%s) < deadline )); do
  left=$(( (deadline - $(date +%s)) * 1000 )); (( left > 300000 )) && left=300000
  result=$(mcp t3_thread_wait "{\"threadId\":\"$thread\",\"timeoutMs\":$left}" || true)
  [[ $(field timedOut <<< "$result") == true ]] && continue
  status=$(field status <<< "$result"); status=${status:-unknown}
  [[ $status == running || $status == preparing ]] || break
done
if (( $(date +%s) >= deadline )); then
  status=timed-out
  mcp t3_thread_interrupt "{\"threadId\":\"$thread\"}" > /dev/null || true
fi
ended=$(date +%s)
sleep 2
stop_capture

# The apps the tester left running: they would get in the next run's way (one
# LibreOffice instance per user, for one). Its windows' processes carry its
# thread's tag.
leftover=()
for e in /proc/[0-9]*/environ; do
  { tr '\0' '\n' < "$e"; } 2>/dev/null | grep -qx "PLUTONIUM_THREAD_ID=t3:thread/$thread" || continue
  p=${e#/proc/}; leftover+=("${p%/environ}")
done
if (( ${#leftover[@]} )); then
  ps -o pid,args -p "$(IFS=,; echo "${leftover[*]}")" > "$out/leftover.txt" 2>/dev/null || true
  # Their sandbox parents (bwrap) carry no tag; a stuck app ignores TERM.
  for p in "${leftover[@]}"; do
    pp=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
    [[ $(ps -o comm= -p "$pp" 2>/dev/null) == bwrap ]] && leftover+=("$pp")
  done
  kill "${leftover[@]}" 2>/dev/null || true
  sleep 3
  kill -9 "${leftover[@]}" 2>/dev/null || true
  echo "stopped ${#leftover[@]} processes the tester left (leftover.txt)"
fi
# The documents it had open would come back as crash recovery in the next run.
python3 -I "$HERE/lo-recovery.py" drop-new "$out/lo-recovery-before.txt" || true
echo "finished: $status after $((ended - started)) s"

# The thread as T3 shows it, page by page, and its state.
: > "$out/thread.jsonl"
after=
while :; do
  page=$(mcp t3_thread_read "{\"threadId\":\"$thread\",\"view\":\"activity\",\"limit\":100,\"maxCharsPerItem\":20000${after:+,\"afterPosition\":$after}}") || break
  node -e 'const p=JSON.parse(require("fs").readFileSync(0,"utf8")); for (const i of p.items) console.log(JSON.stringify(i))' <<< "$page" >> "$out/thread.jsonl"
  [[ $(field hasMore <<< "$page") == true ]] || break
  after=$(field nextPosition <<< "$page")
done
node -e 'const p=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(JSON.stringify(p.thread, null, 2))' \
  <<< "$(mcp t3_thread_read "{\"threadId\":\"$thread\",\"limit\":1}")" > "$out/thread.json" || true

# The tester's Claude transcript: Claude Code keeps it under its project
# directory, named after the thread's working directory, in the instance's
# home (~/.claude, or ~/.claude_2 and so on for other accounts).
cwd=$(field worktreePath < "$out/thread.json") tdir=
for home in "$HOME"/.claude "$HOME"/.claude_*; do
  d=$home/projects/$(sed 's/[^a-zA-Z0-9]/-/g' <<< "$cwd")
  [[ -n $cwd && -d $d ]] && tdir=$d && break
done
if [[ -n $tdir ]]; then
  # shellcheck disable=SC2046 # one path per transcript, oldest first
  cat $(ls -tr "$tdir"/*.jsonl) > "$out/transcript.jsonl"
  node "$HERE/timeline.ts" "$out/transcript.jsonl" "$out"
else
  echo "warning: no Claude transcript for $cwd" >&2
fi

for f in "${logfiles[@]}"; do
  [[ -f $f ]] || continue
  size=$(stat -c %s "$f") off=${offsets[$f]}
  (( size < off )) && off=0   # started again since
  (( size > off )) && tail -c +"$((off + 1))" "$f" > "$out/logs/$(basename "$f")"
done
# KDE's crash handler crashing over and over is noise here.
coredumpctl list --since="@$started" --no-pager 2>/dev/null | grep -v drkonqi > "$out/coredumps.txt" || true
[[ $(wc -l < "$out/coredumps.txt") -gt 1 ]] || echo "none" > "$out/coredumps.txt"

node -e 'const [scenario,name,checkout,slot,port,instance,model,thread,status,started,ended,capture]=process.argv.slice(1);
  console.log(JSON.stringify({scenario,name,checkout,slot:+slot,t3Port:+port,instance,model,thread,status,
    started:new Date(started*1000).toISOString(),ended:new Date(ended*1000).toISOString(),screen:capture==="1"},null,2))' \
  "$scenario" "$name" "$checkout" "$SLOT" "$T3_PORT" "$instance" "$model" "$thread" "$status" "$started" "$ended" "$capture" > "$out/meta.json"
rm -f "$out/.token"
echo "$out"
