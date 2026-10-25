#!/usr/bin/env bash
# tools/capture-checks.sh [DEVTOOLS_PORT] [SHELL_PORT]: checks screen capture
# (docs/features/CAPTURE.md) in a running session, through DevTools: a
# screenshot of the output, a shell's MediaStream of it, a PipeWire node of it
# recorded with GStreamer's pipewiresrc, and the capture events. Writes what it
# took to logs/capture-checks/ and prints a line per check.
#
# Defaults: this checkout's slot's DRM session (DevTools 9224 + 100 × slot,
# niri on 8875). For an X11 session pass its DevTools port.
set -u
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
slot=$(cd "$root" && bin/plutonium worktree info 2>/dev/null | sed -n 's/.*slot \([0-9]*\).*/\1/p' | head -1)
port=${1:-$((9224 + 100 * ${slot:-0}))}
shell=${2:-$((8875 + 100 * ${slot:-0}))}
out=$root/logs/capture-checks
mkdir -p "$out"
export CDP=localhost:$port
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; }

js() { (cd "$root" && timeout 60 bin/plutonium cdp eval "$shell" "$1" 2>&1 | tail -1); }
lib="const s=(await import(document.querySelector('script[src*=\"shell.js\"]')?.src ?? (new URLSearchParams(location.search).get('helper') + '/v1/shell.js'))).connect();"

r=$(js "(async()=>{$lib const p=await s.saveScreenshot(await s.screenshot(await s.outputSource())); return p;})()")
case $r in *Screenshot*) pass "screenshot of the output: $r" ;; *) fail "screenshot: $r" ;; esac

r=$(js "(async()=>{$lib const st=await s.capture(await s.outputSource()); const rd=new MediaStreamTrackProcessor({track:st.getVideoTracks()[0]}).readable.getReader(); const f=(await rd.read()).value; const r=f.displayWidth+'x'+f.displayHeight; f.close(); const n=s.captures().length; st.getTracks().forEach(t=>t.stop()); return r+' captures '+n;})()")
case $r in *x*captures\ 1*) pass "a shell's stream of the output: $r" ;; *) fail "stream: $r" ;; esac

start=$(cd "$root/helper" && node --input-type=module -e "
import { BrowserCdp } from './src/cdp.ts';
import { Desktop } from './src/desktop.ts';
const desktop = new Desktop(new BrowserCdp($port));
await desktop.available();
const { outputs } = await desktop.captureSources();
const output = outputs.find((o) => o.primary) ?? outputs[0];
try {
  console.log(JSON.stringify(await desktop.captureCommand('start', { source: { type: 'output', id: output.id }, cursor: 'embedded', consumer: { name: 'capture-checks' } })));
} catch (e) { console.log('error ' + e.message); }
process.exit(0);" 2>&1 | tail -1)
node_id=$(echo "$start" | sed -n 's/.*"nodeId":\([0-9]*\).*/\1/p')
capture_id=$(echo "$start" | sed -n 's/.*"captureId":\([0-9]*\).*/\1/p')
if [[ -z $node_id ]]; then
  fail "PipeWire node: $start"
else
  rm -f "$out"/pipewire-*.png
  gst=(gst-launch-1.0 -q pipewiresrc "path=$node_id" num-buffers=3 always-copy=true ! videoconvert ! pngenc snapshot=false ! multifilesink "location=$out/pipewire-%d.png")
  if command -v gst-launch-1.0 > /dev/null; then
    timeout 30 "${gst[@]}"
  else
    timeout 300 nix-shell -p gst_all_1.gstreamer gst_all_1.gst-plugins-base gst_all_1.gst-plugins-good pipewire --run "timeout 30 ${gst[*]}"
  fi
  if ls "$out"/pipewire-*.png > /dev/null 2>&1; then pass "PipeWire node $node_id: $start, frames in $out/pipewire-*.png"
  else fail "PipeWire node $node_id: no frames (a still screen sends one; move the pointer)"; fi
  (cd "$root/helper" && node --input-type=module -e "
import { BrowserCdp } from './src/cdp.ts';
import { Desktop } from './src/desktop.ts';
const desktop = new Desktop(new BrowserCdp($port));
await desktop.captureCommand('stop', { id: $capture_id }).catch(() => {});
process.exit(0);")
fi
echo "Screenshots and PipeWire frames: $out and ~/Pictures/Screenshots"
