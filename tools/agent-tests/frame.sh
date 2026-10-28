#!/usr/bin/env bash
# A frame of a run's screen recording, at a time from its timeline.
#
#   frame.sh <run-dir> <HH:MM:SS[.s]> [out.png] [width]
#
# The time is UTC, as timeline.txt prints it. Prints the PNG's path (default
# <run-dir>/frames/<time>.png, 1280 wide). For an X11 run, the path of its
# nearest earlier frame in screen/.
set -eo pipefail
run=${1:?usage: frame.sh <run-dir> <HH:MM:SS[.s]> [out.png] [width]} at=${2:?time}
if [[ ! -f $run/screen.mkv && -d $run/screen ]]; then
  # An X11 run (run.sh --x11): the frame taken last at or before that time.
  day=$(date -u -d "@$(ls "$run/screen" | head -1 | cut -d. -f1)" +%F)
  t=$(date -u -d "$day $at" +%s)
  f=$(ls "$run/screen" | sort -n | awk -F. -v t="$t" '$1 <= t { f = $0 } END { print f }')
  [[ -n $f ]] || { echo "no frame at or before $at" >&2; exit 1; }
  echo "$run/screen/$f"; exit 0
fi
[[ -f $run/screen.mkv ]] || { echo "no screen recording in $run" >&2; exit 1; }
FF=${FF:-$(command -v ffmpeg || echo "$(nix build --no-link --print-out-paths 'nixpkgs#ffmpeg-headless.bin' 2>/dev/null)/bin/ffmpeg")}
start=$(cat "$run/.screen-start")
day=$(date -u -d "@${start%.*}" +%F)
offset=$(awk -v a="$(date -u -d "$day $at" +%s.%N)" -v s="$start" 'BEGIN { d = a - s; printf "%.2f", d < 0 ? 0 : d }')
out=${3:-$run/frames/${at//:/}.png}
mkdir -p "$(dirname "$out")"
"$FF" -v error -y -ss "$offset" -i "$run/screen.mkv" -frames:v 1 -vf "scale=${4:-1280}:-1" "$out"
echo "$out"
