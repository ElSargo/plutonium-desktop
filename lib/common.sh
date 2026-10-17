# Shared settings for the scripts in bin/ and lib/. Source it; it sets ROOT and
# reads plutonium.env (see plutonium.env.example) for overrides.

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
[ -f "$ROOT/plutonium.env" ] && . "$ROOT/plutonium.env"

# Where things live. The container mounts each of these at the same path, so a
# path means the same thing inside and outside it.
CHROMIUM_DIR=${CHROMIUM_DIR:-$HOME/chromium}          # holds .gclient and src/
DEPOT_TOOLS=${DEPOT_TOOLS:-$HOME/depot_tools}
CHROMIUM_OUT=${CHROMIUM_OUT:-out/Plutonium}           # build dir, relative to src/
CHROMIUM_RELEASE_OUT=${CHROMIUM_RELEASE_OUT:-out/Release}  # release build, for the prebuilt image
T3CODE_DIR=${T3CODE_DIR:-$ROOT/frontends/t3code/checkout}
DATA_DIR=${DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/plutonium}   # browser profiles
T3_HOME=${T3_HOME:-$DATA_DIR/t3}                      # T3 Code's server data
RUN_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
LOGS=${LOGS:-$ROOT/logs}

# The build and run container (rootless podman, Ubuntu 24.04).
CONTAINER=${CONTAINER:-plutonium}
BUILD_IMAGE=${BUILD_IMAGE:-localhost/plutonium-build:24.04}
# The prebuilt image (plutonium image build/push/pull). Its tag is a hash of
# what the Chromium build is made from, so it always matches this checkout.
PREBUILT_REPO=${PREBUILT_REPO:-ghcr.io/elsargo/plutonium}
PREBUILT_TAG=chromium-$(cat "$ROOT/chromium/BASE" "$ROOT/chromium/args.release.gn" "$ROOT"/chromium/patches/*.patch | sha256sum | cut -c1-12)
# PREBUILT=1: run Chromium from the prebuilt image; no checkout or build.
if [[ -n ${PREBUILT:-} ]]; then
  IMAGE=${IMAGE:-$PREBUILT_REPO:$PREBUILT_TAG}
  CHROME_BIN=/opt/plutonium/chrome/chrome
else
  IMAGE=${IMAGE:-$BUILD_IMAGE}
fi
# Podman command. From a shell inside another user namespace (an agent's
# sandbox, some IDE terminals) podman can't run directly; use lib/pm.sh.
PODMAN=${PODMAN:-podman}
[[ $PODMAN == */* && $PODMAN != /* ]] && PODMAN=$ROOT/$PODMAN

CHROME_BIN=${CHROME_BIN:-$CHROMIUM_DIR/src/$CHROMIUM_OUT/chrome}

# Every Ash a Plutonium launcher starts has this on its command line; the kill
# switch and the launchers find Ash by it.
ASH_MARK=--plutonium-shell-origin=

# The helper reads this when it starts a thread's X server.
[[ -n ${PLUTONIUM_XWAYLAND_SATELLITE:-} ]] && export PLUTONIUM_XWAYLAND_SATELLITE

mkdir -p "$LOGS"

die() { echo "plutonium: $*" >&2; exit 1; }
pm() { $PODMAN "$@"; }
# Run a command in the container. -e VAR=value pairs may come first.
in_container() {
  local env=()
  while [[ $1 == -e ]]; do env+=(-e "$2"); shift 2; done
  local dir=$CHROMIUM_DIR
  [[ -n ${PREBUILT:-} ]] && dir=$ROOT
  pm exec "${env[@]}" -w "$dir" "$CONTAINER" "$@"
}
# chrome is in the container (prebuilt) or in the mounted checkout.
chrome_built() { if [[ -n ${PREBUILT:-} ]]; then container_running && in_container test -x "$CHROME_BIN"; else [[ -x $CHROME_BIN ]]; fi; }
container_running() { [[ $(pm container inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null) == true ]]; }
need_container() {
  container_running || die "the container '$CONTAINER' is not running (plutonium container create / start)"
}
