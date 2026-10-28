#!/usr/bin/env bash
# Pauses an X11 session's display while a tester's tool call runs, for the
# scenario stuck-drag-paused: the slot's Xvfb is stopped, so Ash can't present
# and its tabs draw no frames, as when logind pauses a DRM session.
#
#   pause-x11.sh [--checkout DIR] [--tool NAME] [--after S] [--for S]
#     --checkout DIR  the checkout whose X11 session to pause (default: this one)
#     --tool NAME     wait for the first call of this tool in a tester transcript
#                     written after this starts (default: preview_drag)
#     --after S       then wait this long before pausing (default: 1)
#     --for S         keep it paused this long (default: 40)
#
# Start it before run.sh --x11, in the background. It matches the call itself
# (a tool_use's name and input), not the tool's name in a tool listing. It
# prints when it paused and resumed (UTC, as timeline.txt prints times).
set -eo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
checkout=$(cd "$HERE/../.." && pwd) tool=preview_drag after=1 for=40
while [[ $# -gt 0 ]]; do
  case "$1" in
    --checkout) checkout=$(cd "$2" && pwd); shift ;;
    --tool) tool=$2; shift ;;
    --after) after=$2; shift ;;
    --for) for=$2; shift ;;
    *) sed -n '2,/^set -eo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 2 ;;
  esac
  shift
done
# shellcheck source=../../lib/common.sh
. "$checkout/lib/common.sh"
(( SLOT )) || die "not on slot 0: that's the user's desktop"
pid=$(pgrep -f "^Xvfb $PRIVATE_XDISP " | head -1)
[[ -n $pid ]] || die "no Xvfb on $PRIVATE_XDISP"

mark=$(mktemp); trap 'rm -f "$mark"; kill -CONT "$pid" 2>/dev/null || true' EXIT
echo "waiting for a $tool call (Xvfb $PRIVATE_XDISP, pid $pid)"
until find "$HOME"/.claude/projects "$HOME"/.claude_*/projects -name '*.jsonl' -newer "$mark" \
    -exec grep -l "\"name\":\"mcp__t3-code__$tool\",\"input\"" {} + 2>/dev/null | grep -q .; do
  sleep 0.5
done
sleep "$after"
kill -STOP "$pid"
echo "paused at $(date -u +%T.%N | cut -c1-10)"
sleep "$for"
kill -CONT "$pid"
echo "resumed at $(date -u +%T.%N | cut -c1-10)"
