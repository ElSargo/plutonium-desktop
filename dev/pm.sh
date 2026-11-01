#!/bin/sh
# podman through a transient systemd user unit. Use it (PODMAN=dev/pm.sh in
# plutonium.env) when podman fails with "cannot re-exec process to join the
# existing user namespace": the shell runs in a user namespace of its own.
exec systemd-run --user --wait --pipe --quiet --collect -p Type=exec --setenv=PATH="$PATH" \
  "$(command -v podman)" "$@"
