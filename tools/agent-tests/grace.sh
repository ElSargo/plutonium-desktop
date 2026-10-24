#!/usr/bin/env bash
# The user's chance to say no to something that takes over the screen (a test
# session on another VT): waits, and fails open.
#
#   grace.sh [seconds]     default 150
#
# Exits 0 when the time is up with no veto, 1 if logs/agent-tests/veto
# appeared meanwhile (it's removed). Run it in the background after asking, and
# end the turn: a reply from the user arrives first; silence means go ahead.
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
veto=$(git -C "$HERE" rev-parse --path-format=absolute --git-common-dir | xargs dirname)/logs/agent-tests/veto
mkdir -p "$(dirname "$veto")"
end=$(( $(date +%s) + ${1:-150} ))
while (( $(date +%s) < end )); do
  [[ -e $veto ]] && { rm -f "$veto"; echo "vetoed"; exit 1; }
  sleep 1
done
echo "no answer: going ahead"
