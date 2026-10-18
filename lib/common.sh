# Shared settings for the scripts in bin/ and lib/. Source it; it sets ROOT and
# reads plutonium.env (see plutonium.env.example) for overrides.

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
[ -f "$ROOT/plutonium.env" ] && . "$ROOT/plutonium.env"
# A worktree's own overrides, on top of a plutonium.env it shares with the
# main checkout (plutonium worktree add links it).
[ -f "$ROOT/plutonium.local.env" ] && . "$ROOT/plutonium.local.env"
# The main checkout, which the containers mount; the same as ROOT unless this
# is a linked worktree.
MAIN_ROOT=$ROOT
_common=$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) && MAIN_ROOT=$(dirname "$_common")

# Parallel checkouts (docs/DEVELOPING.md): each has a slot, and slot N moves
# its sessions' sockets, ports, X display and profiles out of the others' way.
# Slot 0, the main checkout's, keeps the plain names.
SLOT=${PLUTONIUM_SLOT:-$(cat "$ROOT/.plutonium-slot" 2>/dev/null || echo 0)}
SLOT_SUFFIX=
(( SLOT )) && SLOT_SUFFIX=-s$SLOT
slot_port() { echo $(( $1 + 100 * SLOT )); }

# Where things live. The container mounts each of these at the same path, so a
# path means the same thing inside and outside it.
CHROMIUM_DIR=${CHROMIUM_DIR:-$HOME/chromium}          # holds .gclient and src/
DEPOT_TOOLS=${DEPOT_TOOLS:-$HOME/depot_tools}
CHROMIUM_OUT=${CHROMIUM_OUT:-out/Plutonium}           # build dir, relative to src/
CHROMIUM_RELEASE_OUT=${CHROMIUM_RELEASE_OUT:-out/Release}  # release build, for the prebuilt image
T3CODE_DIR=${T3CODE_DIR:-$ROOT/frontends/t3code/checkout}
DATA_DIR=${DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/plutonium}   # browser profiles
T3_HOME=${T3_HOME:-${T3CODE_HOME:-$HOME/.t3}}          # T3 Code's data: the host's own
T3_PORT=${T3_PORT:-$(slot_port 3774)}
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

# The container that builds Chromium. With PREBUILT=1, CONTAINER runs the
# prebuilt image, which can't build; the build container keeps its default name.
if [[ -n ${PREBUILT:-} ]]; then BUILD_CONTAINER=${BUILD_CONTAINER:-plutonium}
else BUILD_CONTAINER=${BUILD_CONTAINER:-$CONTAINER}; fi

# Dev builds of a patch set, kept by `plutonium chromium build` so that a
# checkout runs its own build while another one rebuilds the shared out dir.
# The key is a hash of what the build is made from.
BUILDS_DIR=${BUILDS_DIR:-$DATA_DIR/builds}
BUILDS_KEEP=${BUILDS_KEEP:-6}
# CCACHE=1: compile through ccache, in CCACHE_DIR (mounted in the container).
CCACHE_DIR=${CCACHE_DIR:-$DATA_DIR/ccache}
CCACHE_SIZE=${CCACHE_SIZE:-50G}
BUILD_KEY=$(cat "$ROOT/chromium/BASE" "$ROOT/chromium/args.gn" "$ROOT"/chromium/patches/*.patch | sha256sum | cut -c1-12)
# What the out dir holds (chromium build writes it): "key <K>" for patch set K
# as it is, "custom <K>" for more work on top of K.
OUT_BUILD=$(cat "$CHROMIUM_DIR/src/$CHROMIUM_OUT/.plutonium-build" 2>/dev/null || true)
# A session runs, in order: the out dir if it holds work on top of this
# checkout's patches; this patch set's kept build; the out dir.
if [[ -z ${CHROME_BIN:-} && $OUT_BUILD != "custom $BUILD_KEY" && -x $BUILDS_DIR/$BUILD_KEY/chrome ]]; then
  CHROME_BIN=$BUILDS_DIR/$BUILD_KEY/chrome
fi
CHROME_BIN=${CHROME_BIN:-$CHROMIUM_DIR/src/$CHROMIUM_OUT/chrome}
# HOST=1: run Ash on the host, with no container: the release build (from the
# prebuilt image with PREBUILT=1, or out/Release), with its libraries from
# nixpkgs (plutonium host build, nix/chrome.nix).
HOST_CHROME=${HOST_CHROME:-$DATA_DIR/host-chrome}
HOST_TOOLS=${HOST_TOOLS:-$DATA_DIR/host-tools}     # Xvfb, python3 with websockets
[[ -n ${HOST:-} ]] && CHROME_BIN=$HOST_CHROME/bin/chrome
# How Ash's command line starts, for pgrep and pkill. Chromium sets its process
# title from its own executable: on the host, that's the wrapped binary in the
# store, of whichever build of nix/chrome.nix started it. Otherwise any chrome:
# which build a checkout runs can change while a session is up, and the
# profile tells sessions apart.
ASH_BIN='[^ ]*/chrome'
[[ -n ${HOST:-} ]] && ASH_BIN='/nix/store/[^/ ]*-plutonium-chrome-[^/ ]*/libexec/plutonium/chrome/chrome'

# Every Ash a Plutonium launcher starts has this on its command line; the kill
# switch and the launchers find Ash by it.
ASH_MARK=--plutonium-shell-origin=

# The live frontends (plutonium live): what this slot's shell servers and
# helper serve, through a `current` link per part that a running session
# follows. Until something is applied, it's the checkout's own files.
LIVE_DIR=$DATA_DIR/live/slot$SLOT
live_current() {   # <part> <the checkout's own directory for it>
  local link=$LIVE_DIR/$1/current
  [[ -e $link ]] || { mkdir -p "$LIVE_DIR/$1"; ln -sfn "$2" "$link"; }
  echo "$link"
}

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
  [[ -n ${PREBUILT:-} ]] && dir=$MAIN_ROOT
  pm exec "${env[@]}" -w "$dir" "$CONTAINER" "$@"
}
# The same in the build container, from the Chromium checkout.
in_build_container() {
  local env=()
  while [[ $1 == -e ]]; do env+=(-e "$2"); shift 2; done
  pm exec "${env[@]}" -w "$CHROMIUM_DIR" "$BUILD_CONTAINER" "$@"
}
# Run a command where Ash runs: on the host with HOST=1 (with the host tools
# first on PATH), else in the container. -e VAR=value pairs may come first.
on_ash() {
  [[ -z ${HOST:-} ]] && { in_container "$@"; return; }
  local env=("PATH=$HOST_TOOLS/bin:$PATH")
  while [[ $1 == -e ]]; do env+=("$2"); shift 2; done
  env "${env[@]}" "$@"
}
# chrome is on the host (HOST=1), in the container (prebuilt) or in the
# mounted checkout.
chrome_built() {
  if [[ -z ${HOST:-} && -n ${PREBUILT:-} ]]; then container_running && in_container test -x "$CHROME_BIN"
  else [[ -x $CHROME_BIN ]]; fi
}
container_running() { [[ $(pm container inspect -f '{{.State.Running}}' "${1:-$CONTAINER}" 2>/dev/null) == true ]]; }
need_container() {
  container_running || die "the container '$CONTAINER' is not running (plutonium container create / start)"
}
# What a session needs before it starts Ash: the container, unless HOST=1.
need_ash_runtime() { [[ -n ${HOST:-} ]] || need_container; }

# A session's Wayland socket, DevTools and helper ports, and profile, for a
# mode (drm or x11) in this checkout's slot. PRIVATE_XDISP is the Xvfb an X11
# session starts when it's given no display.
session_vars() {
  if [[ $1 == drm ]]; then
    SOCKET=wayland-plutonium$SLOT_SUFFIX CDP_PORT=$(slot_port 9224) HELPER_PORT=$(slot_port 3782)
  else
    SOCKET=wayland-plutonium-x11$SLOT_SUFFIX CDP_PORT=$(slot_port 9223) HELPER_PORT=$(slot_port 3781)
  fi
  PROFILE=$DATA_DIR/profile-$1$SLOT_SUFFIX
}
PRIVATE_XDISP=:$(( 99 + SLOT ))
