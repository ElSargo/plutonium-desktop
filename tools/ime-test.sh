#!/usr/bin/env bash
# A test input method for native apps (docs/features/IME.md): the extension in
# tools/ime-test-extension composes letters and commits on Space or Enter.
# Usage:
#   tools/ime-test.sh prefs <profile>    with the session stopped: enables it
#                                        in the profile (e.g.
#                                        ~/.local/share/plutonium/profile-x11-s3)
#   plutonium run --x11 --flags "$(tools/ime-test.sh flags)" plain
#   CDP=localhost:<the session's DevTools port> tools/ime-test.sh [off]
# The last makes it the current input method (or, with "off", the US
# keyboard again), through chrome.inputMethodPrivate (which the flags allow
# it).
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
dir=$root/tools/ime-test-extension
# An unpacked extension's id is its path's SHA-256, in the letters a-p.
id=$(python3 -c 'import hashlib,sys; print("".join(chr(97+int(c,16)) for c in hashlib.sha256(sys.argv[1].encode()).hexdigest()[:32]))' "$dir")
ime=_ext_ime_${id}pltest

case ${1:-} in
  prefs)
    # The stub user's profile. Ash turns an extension's input method on when
    # the extension loads only if the profile lists it.
    python3 -c '
import json, sys
path, ime = sys.argv[1:]
prefs = json.load(open(path))
language = prefs.setdefault("settings", {}).setdefault("language", {})
for key in ("enabled_extension_imes", "preload_engines"):
    ids = [i for i in language.get(key, "").split(",") if i]
    if ime not in ids:
        ids.append(ime)
    language[key] = ",".join(ids)
json.dump(prefs, open(path, "w"))
' "$2/test-user/Preferences" "$ime"
    exit ;;
  flags)
    echo "--load-extension=$dir --allowlisted-extension-id=$id"
    exit ;;
esac

cdp() { "$root/bin/plutonium" cdp "$@"; }
# Its control page does it, in a tab of its own that is closed again.
query=
[[ ${1:-} == off ]] && query='?id=_comp_ime_fgoepimhcoialccpbmpnnblemnepkkaoxkb:us::eng'
target=$(cdp browser Target.createTarget "{\"url\":\"chrome-extension://$id/control.html$query\"}" |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["targetId"])')
sleep 2
title=$(cdp eval control.html 'document.title')
cdp browser Target.closeTarget "{\"targetId\":\"$target\"}" > /dev/null
echo "test IME: $title"
[[ $title == '"current"' ]]
