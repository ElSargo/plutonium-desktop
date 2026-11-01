#!/usr/bin/env bash
# Put a release tarball on this machine's desktop and restart the desktop on
# it: stop the DRM session, install the tarball with the bundle's installer
# (dev/bundle/install.sh; it refuses while a session runs from /opt/plutonium),
# and start the session again on the VT it was on, whether or not the install
# worked. The session it stops may be the one running this (an agent in a
# Hydra thread), so run it detached, as a transient user unit:
#
#   systemd-run --user --unit=plutonium-redeploy --collect \
#     --setenv=PATH=/run/wrappers/bin:/run/current-system/sw/bin:/usr/bin:/bin \
#     tools/redeploy.sh <tarball> <install.sh> [ttyN]
#
# ttyN: the text console you're logged in on (default tty2). The session then
# runs in that unit (`plutonium run --vt ttyN`) rather than in the console's
# shell; `plutonium stop` ends it as usual. Its log: journalctl --user -u
# plutonium-redeploy, and ~/.local/share/plutonium/logs/redeploy.log.
#
# The session it starts gets the user's login environment, not the unit's bare
# one: it re-runs itself through a login shell (/etc/profile: on NixOS the
# nix profiles in PATH, XDG_DATA_DIRS for their apps, NIX_LD), plus
# ~/.local/bin, so apps started on the desktop find what a terminal does.
set -uo pipefail
if [[ -z ${REDEPLOY_LOGIN_ENV:-} ]]; then
  export REDEPLOY_LOGIN_ENV=1
  exec bash -lc 'exec "$0" "$@"' "$0" "$@"
fi
[[ -d $HOME/.local/bin && :$PATH: != *:$HOME/.local/bin:* ]] && PATH=$HOME/.local/bin:$PATH
export PATH
tarball=${1:?usage: redeploy.sh <tarball> <install.sh> [ttyN]}
installer=${2:?usage: redeploy.sh <tarball> <install.sh> [ttyN]}
vt=${3:-tty2}
log=${XDG_DATA_HOME:-$HOME/.local/share}/plutonium/logs/redeploy.log
exec > >(tee -a "$log") 2>&1
say() { echo "$(date +%T) redeploy: $*"; }

[[ -f $tarball ]] || { say "no tarball at $tarball"; exit 1; }
[[ -f $installer ]] || { say "no installer at $installer"; exit 1; }
say "stopping the DRM session"
plutonium stop --drm
for _ in $(seq 1 60); do
  pgrep -f '^/opt/plutonium/chrome/chrome ' > /dev/null ||
    pgrep -f '/opt/plutonium/helper/plutonium.ts daemon' > /dev/null || break
  sleep 0.5
done
say "installing $tarball"
if sh "$installer" --from "$tarball"; then
  say "installed: $(sed -n 's/^VERSION=//p' /opt/plutonium/BUNDLE)"
else
  say "the install failed; starting the session from what /opt/plutonium has"
fi
say "starting the session on $vt"
exec plutonium run --vt "$vt"
