#!/usr/bin/env bash
# The agent tool tests' own sessions (docs/agent-tests/README.md): a DRM session
# on a spare VT, from a worktree .worktrees/<name> (its own slot), running a
# dev build of that worktree's Chromium patches, its helper, and a T3 Code
# server of its own (own data, own checkout), so nothing the live desktop runs
# or serves changes.
#
# Several can be up at once, one per VT, each with its own name (--name, before
# the command; default agent-tests). Only the VT on screen has the display and
# input, so test runs take turns: `front` brings one to the screen.
#
#   session.sh [--name N] up [--ref REF] [--t3-ref REF | --t3 DIR] [--vt N]
#       --ref REF     what the session runs: a commit, branch or a fixer's
#                     branch of this repository (default: main)
#       --t3-ref REF  the T3 Code commit to build and serve (default: the T3
#                     checkout's plutonium branch); built in its own worktree
#       --t3 DIR      serve this T3 Code checkout as it is instead (a fixer's
#                     worktree, already built: plutonium hydra build)
#       --vt N        the spare VT (default 5; not 6, logind's reserved VT, unless the
#                     user is logged in there: its getty would replace ours). If the user is logged in on it,
#                     the session runs in that login; otherwise in one of its own.
#   session.sh [--name N] front     switch the screen to it
#   session.sh [--name N] down      stop it, give the VT back, switch back
#   session.sh [--name N] status
#
# `up` takes over the screen: it switches to the spare VT. Ask first
# (.claude/skills/agent-tool-testing). Building Chromium can take a while;
# run `up` in the background.
set -eo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
MAIN=$(dirname "$(git -C "$HERE" rev-parse --path-format=absolute --git-common-dir)")
# shellcheck source=../../lib/common.sh
. "$MAIN/lib/common.sh"
. "$MAIN/shells/hydra/lib/env.sh"   # T3CODE_DIR, T3_HOME
name=agent-tests
[[ ${1:-} == --name ]] && { name=$2; shift 2; }
WT=$MAIN/.worktrees/$name
STATE=$DATA_DIR/$name
T3WT=$STATE/t3code
UNIT=plutonium-$name
mkdir -p "$STATE"
vt=$(cat "$STATE/vt" 2>/dev/null || echo 5)
say() { echo "agent-tests: $*"; }

up() {
  local ref=main t3ref= t3dir=
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --ref) ref=$2; shift ;;
      --t3-ref) t3ref=$2; shift ;;
      --t3) t3dir=$(cd "$2" && pwd); shift ;;
      --vt) vt=$2; shift ;;
      *) die "unknown option $1" ;;
    esac
    shift
  done
  echo "$vt" > "$STATE/vt"

  # The worktree, at what's to be tested.
  if [[ ! -d $WT ]]; then
    "$MAIN/bin/plutonium" worktree add "$name" "$ref" > /dev/null
  fi
  [[ -z $(git -C "$WT" status --porcelain --untracked-files=no) ]] || die "$WT has uncommitted changes"
  git -C "$MAIN" rev-parse -q --verify "$ref^{commit}" > /dev/null || die "no commit $ref"
  git -C "$WT" checkout -q --detach "$ref"
  say "session from $ref ($(git -C "$WT" log --oneline -1))"

  # T3 Code: a checkout of its own, built, unless one is given.
  if [[ -z $t3dir ]]; then
    t3ref=${t3ref:-$(git -C "$T3CODE_DIR" rev-parse plutonium)}
    if [[ ! -d $T3WT ]]; then
      git -C "$T3CODE_DIR" worktree add -q --detach "$T3WT" "$t3ref"
      [[ -f $T3CODE_DIR/.env ]] && cp "$T3CODE_DIR/.env" "$T3WT/.env"
    fi
    git -C "$T3WT" checkout -q --detach "$t3ref"
    t3dir=$T3WT
  fi
  cat > "$WT/plutonium.local.env" <<EOF
# The agent tool tests' session (tools/agent-tests/session.sh writes this).
PREBUILT=
CONTAINER=plutonium
T3_HOME=$STATE/t3-home
T3CODE_DIR=$t3dir
T3_TAILSCALE=
EOF
  if [[ $t3dir == "$T3WT" && $(cat "$STATE/t3-built" 2>/dev/null) != "$(git -C "$T3WT" rev-parse HEAD)" ]]; then
    say "building T3 Code $(git -C "$T3WT" log --oneline -1)"
    "$WT/bin/plutonium" hydra build > "$STATE/t3-build.log" 2>&1 || die "T3 Code didn't build ($STATE/t3-build.log)"
    git -C "$T3WT" rev-parse HEAD > "$STATE/t3-built"
  fi
  # A fixer's checkout: rebuild its web app if it's older than the last commit.
  if [[ $t3dir != "$T3WT" ]] && { [[ ! -f $t3dir/apps/web/dist/index.html ]] ||
       (( $(stat -c %Y "$t3dir/apps/web/dist/index.html") < $(git -C "$t3dir" log -1 --format=%ct) )); }; then
    say "building T3 Code in $t3dir (its build is older than its last commit)"
    "$WT/bin/plutonium" hydra build > "$STATE/t3-build.log" 2>&1 || die "T3 Code didn't build ($STATE/t3-build.log)"
  fi
  [[ -f $t3dir/apps/web/dist/index.html ]] || die "$t3dir isn't built (plutonium hydra build)"

  # The same provider accounts as the user's T3 Code (only those settings), so
  # testers can run on whichever isn't at its limit (run.sh --instance).
  mkdir -p "$STATE/t3-home/userdata"
  local settings=$STATE/t3-home/userdata/settings.json
  if [[ -f $HOME/.t3/userdata/settings.json ]]; then
    jq -s '(.[1] // {}) + (.[0] | {providerInstances, defaultModelSelection})' \
      "$HOME/.t3/userdata/settings.json" <(cat "$settings" 2>/dev/null || echo '{}') > "$settings.new" &&
      mv "$settings.new" "$settings"
  fi

  # A dev build of the worktree's Chromium patches: kept already, or built.
  say "Chromium for its patches (plutonium chromium ensure)"
  # One build at a time: there's one Chromium checkout (~/chromium-wt/BRIEF.md).
  ( flock 8; "$WT/bin/plutonium" chromium ensure ) 8> "$DATA_DIR/chromium-ensure.lock"

  # Starting takes the screen (Ash needs the VT on screen), so wait for any
  # run on another test session to finish (run.sh holds the same lock).
  exec 9> "$DATA_DIR/agent-tests-screen.lock"
  flock -n 9 || { say "waiting for the screen (another test session's run)"; flock 9; }

  # Start fresh: no session or T3 server of this slot left from before, and a
  # new browser profile, so no site has what an earlier run stored (test slots
  # only; slot 0's is the user's).
  down_session
  local slot; slot=$(cat "$WT/.plutonium-slot")
  (( slot > 0 )) && rm -rf "$DATA_DIR/profile-drm-s$slot"
  # A logind session on the spare VT, so Ash can take it: the user's login
  # there, or one of our own.
  # Return to the VT on screen now, unless that's this one (a failed start
  # leaves it there). Off it while the login starts: logind keeps a getty on
  # the VT on screen, and that getty would replace ours.
  local fg; fg=$(sudo -n fgconsole 2>/dev/null || echo 4)
  if [[ $fg == "$vt" ]]; then fg=4; sudo -n chvt 4; fi
  echo "$fg" > "$STATE/return-vt"
  # Ours from before (another session's, maybe): a new one. Reused, it can
  # still be under an earlier Ash's control, and the next can't take it
  # (2026-10-24: TakeControl EBUSY on a login 7 h old, Ash aborted).
  sudo -n systemctl stop "plutonium-test-tty$vt" 2>/dev/null || true
  if logged_in; then
    rm -f "$STATE/own-login"
  else
    touch "$STATE/own-login"
    sudo -n systemctl stop "getty@tty$vt" 2>/dev/null || true
    sudo -n systemd-run --unit="plutonium-test-tty$vt" -p PAMName=login -p User="$(id -un)" -p TTYPath="/dev/tty$vt" \
    -p StandardInput=tty -p StandardOutput=tty -p TTYReset=yes -p UtmpIdentifier="tty$vt" -p UtmpMode=user \
    -p Conflicts="getty@tty$vt.service" /run/current-system/sw/bin/sh -c "exec /run/current-system/sw/bin/sleep infinity" > /dev/null
  fi
  # Testers get no claude.ai connectors (Docs tools and their instructions
  # turned up mid-run and asked them to write docs).
  systemd-run --user --unit="$UNIT" --collect -p WorkingDirectory="$WT" --setenv=PATH="$PATH" \
    --setenv=ENABLE_CLAUDEAI_MCP_SERVERS=false \
    "$WT/bin/plutonium" run --vt "tty$vt" hydra > /dev/null
  sleep 3
  sudo -n chvt "$vt"

  # Ready: T3 Code's server answers and the shell's page is open.
  local cdp=$(( 9224 + 100 * $(cat "$WT/.plutonium-slot") )) t3=$(( 3773 + 100 * $(cat "$WT/.plutonium-slot") ))
  for _ in $(seq 1 120); do
    curl -s -m 2 "http://127.0.0.1:$cdp/json/list" 2>/dev/null | grep -q "127.0.0.1:$t3" && break
    systemctl --user -q is-active "$UNIT" || die "the session stopped (journalctl --user -u $UNIT; $WT/logs/)"
    sleep 1
  done
  curl -s -m 2 "http://127.0.0.1:$cdp/json/list" | grep -q "127.0.0.1:$t3" || die "the shell didn't come up ($WT/logs/)"
  sleep 5   # the page pairs and loads its threads
  say "up on tty$vt: T3 Code on $t3, DevTools $cdp. Test with: tools/agent-tests/run.sh --checkout $WT <scenario>"
}

# Whether the user has a logind session on the VT (not one of ours).
logged_in() {
  local sid
  for sid in $(loginctl list-sessions --no-legend | awk -v u="$(id -u)" '$2==u {print $1}'); do
    [[ $(loginctl show-session "$sid" -p TTY --value) == "tty$vt" ]] || continue
    [[ $(loginctl show-session "$sid" -p Service --value) == login ]] || continue
    systemctl -q is-active "plutonium-test-tty$vt" 2>/dev/null && continue
    return 0
  done
  return 1
}

down_session() {
  [[ -d $WT ]] || return 0
  "$WT/bin/plutonium" stop --drm > /dev/null 2>&1 || true
  "$WT/bin/plutonium" shells stop hydra > /dev/null 2>&1 || true
  systemctl --user stop "$UNIT" 2>/dev/null || true
}

down() {
  down_session
  if [[ -f $STATE/own-login ]]; then
    sudo -n systemctl stop "plutonium-test-tty$vt" 2>/dev/null || true
    sudo -n systemctl start "getty@tty$vt" 2>/dev/null || true
    rm -f "$STATE/own-login"
  fi
  sudo -n chvt "$(cat "$STATE/return-vt" 2>/dev/null || echo 4)"
  say "down; back on tty$(cat "$STATE/return-vt" 2>/dev/null || echo 4)"
}

status() {
  [[ -d $WT ]] || { say "no worktree yet (session.sh up)"; return; }
  say "worktree $WT at $(git -C "$WT" log --oneline -1)"
  say "T3 Code: $(sed -n 's/^T3CODE_DIR=//p' "$WT/plutonium.local.env" 2>/dev/null)"
  systemctl --user -q is-active "$UNIT" && say "session: running on tty$vt" || say "session: not running"
  "$WT/bin/plutonium" status 2>/dev/null | sed 's/^/  /'
}

front() { sudo -n chvt "$vt"; say "tty$vt on screen"; }

case "${1:-}" in
  up) shift; up "$@" ;;
  front) front ;;
  down) down ;;
  status) status ;;
  *) sed -n '2,/^set -eo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 2 ;;
esac
