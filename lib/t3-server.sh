#!/usr/bin/env bash
# T3 Code's server under Plutonium's launcher (t3_start in bin/plutonium):
#
#   t3-server.sh <T3 Code's server.ts> <its arguments, but --host>
#
# The host follows the shell's Settings, Connections, "Network access": T3's
# server saves the choice in $T3CODE_HOME/plutonium-network-access and stops
# (its plutonium/networkAccess.ts), and this starts it again on 0.0.0.0 or
# 127.0.0.1. Any other exit ends it. T3_HOST, when set, is the host whatever
# the setting says.
set -u
setting=$T3CODE_HOME/plutonium-network-access
child=
trap '[[ -n $child ]] && kill -TERM "$child" 2> /dev/null && wait "$child"; exit 143' TERM INT HUP

while :; do
  mode=$(cat "$setting" 2> /dev/null || true)
  if [[ -n ${T3_HOST:-} ]]; then
    host=$T3_HOST
  elif [[ $mode == network-accessible* ]]; then
    host=0.0.0.0
  else
    host=127.0.0.1
  fi
  echo "plutonium: T3 Code's server on $host"
  node "$@" --host "$host" &
  child=$!
  wait "$child"
  status=$?
  child=
  [[ $(cat "$setting" 2> /dev/null || true) != "$mode" ]] || exit "$status"
done
