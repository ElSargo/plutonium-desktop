# A checkout of the source, on top of lib/common.sh (which sources this): its
# Chromium builds, the container a session can run Ash in, and its logs. The
# commands for them are in dev/commands.sh.

# The main checkout, which the containers mount; the same as ROOT unless this
# is a linked worktree.
MAIN_ROOT=$ROOT
_common=$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) && MAIN_ROOT=$(dirname "$_common")
LOGS=${LOGS:-$ROOT/logs}

# Where things live. The container mounts each of these at the same path, so a
# path means the same thing inside and outside it.
CHROMIUM_DIR=${CHROMIUM_DIR:-$HOME/chromium}          # holds .gclient and src/
DEPOT_TOOLS=${DEPOT_TOOLS:-$HOME/depot_tools}
CHROMIUM_OUT=${CHROMIUM_OUT:-out/Plutonium}           # build dir, relative to src/
CHROMIUM_RELEASE_OUT=${CHROMIUM_RELEASE_OUT:-out/Release}  # release build, for HOST=1
CHROMIUM_OFFICIAL_OUT=${CHROMIUM_OFFICIAL_OUT:-out/Official}  # official (LTO) build, for a published tarball

# The build and run container (rootless podman, Ubuntu 24.04).
CONTAINER=${CONTAINER:-plutonium}
BUILD_IMAGE=${BUILD_IMAGE:-localhost/plutonium-build:24.04}
IMAGE=${IMAGE:-$BUILD_IMAGE}
# Podman command. From a shell inside another user namespace (an agent's
# sandbox, some IDE terminals) podman can't run directly; use dev/pm.sh. A
# relative path is in the checkout (lib/pm.sh, from before dev/, is dev/pm.sh).
PODMAN=${PODMAN:-podman}
[[ $PODMAN == lib/pm.sh ]] && PODMAN=dev/pm.sh
[[ $PODMAN == */* && $PODMAN != /* ]] && PODMAN=$ROOT/$PODMAN

# The container that builds Chromium: the one sessions run in, unless set.
BUILD_CONTAINER=${BUILD_CONTAINER:-$CONTAINER}

# Dev builds of a patch set, kept by `plutonium chromium build` so that a
# checkout runs its own build while another one rebuilds the shared out dir.
# The key is a hash of what the build is made from.
BUILDS_DIR=${BUILDS_DIR:-$DATA_DIR/builds}
BUILDS_KEEP=${BUILDS_KEEP:-6}
# CCACHE=1: compile through ccache, in CCACHE_DIR (mounted in the container).
CCACHE_DIR=${CCACHE_DIR:-$DATA_DIR/ccache}
CCACHE_SIZE=${CCACHE_SIZE:-50G}
# Compile jobs a Chromium build runs at once: one per 2 GiB of RAM, at most one
# per CPU. Chromium's heavier files take 1.5-2 GB each to compile, and autoninja
# otherwise runs one per CPU, which runs a 32-thread, 32 GB machine out of memory.
BUILD_JOBS=${BUILD_JOBS:-$(awk -v cpus="$(nproc)" '/^MemTotal:/ { j = int($2 / 2097152); if (j > cpus) j = cpus; print (j < 1 ? 1 : j) }' /proc/meminfo)}
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
# HOST=1: run Ash on the host, with no container: the release build
# (out/Release), with its libraries from
# nixpkgs (plutonium host build, dev/nix/chrome.nix).
HOST_CHROME=${HOST_CHROME:-$DATA_DIR/host-chrome}
HOST_TOOLS=${HOST_TOOLS:-$DATA_DIR/host-tools}     # Xvfb, python3 with websockets
# Chromium sets its process title from its own executable: on the host,
# that's the wrapped binary in the store, of whichever build of
# dev/nix/chrome.nix started it.
if [[ -n ${HOST:-} ]]; then
  CHROME_BIN=$HOST_CHROME/bin/chrome
  ASH_BIN='/nix/store/[^/ ]*-plutonium-chrome-[^/ ]*/libexec/plutonium/chrome/chrome'
fi
if [[ -z ${HOST:-} ]]; then
  CHROME_FIX="plutonium chromium build"
  ASH_RUNTIME_FIX="make the container again (plutonium container stop; podman rm $CONTAINER; plutonium container create), with /run/dbus"
else
  CHROME_FIX="plutonium host build"
fi

# The live frontends (plutonium live): what this slot's shell servers and
# helper serve, through a `current` link per part that a running session
# follows. Until something is applied, it's the checkout's own files.
LIVE_DIR=$DATA_DIR/live/slot$SLOT
live_current() {   # <part> <the checkout's own directory for it>
  local link=$LIVE_DIR/$1/current
  [[ -e $link ]] || { mkdir -p "$LIVE_DIR/$1"; ln -sfn "$2" "$link"; }
  echo "$link"
}
# A new session serves this checkout's shell library. A copy pinned with
# `plutonium live apply` was for a session that has ended, and would hide
# every change since (it hid a week's, 2026-10-19 to 26). PLUTONIUM_LIVE_KEEP=1 keeps it.
shell_library() {
  local lib=$LIVE_DIR/shell-lib/current
  if [[ -z ${PLUTONIUM_LIVE_KEEP:-} && -L $lib && $(readlink -f "$lib") != "$(readlink -f "$ROOT/helper/web")" ]]; then
    log "shell library: was pinned to $(readlink "$lib"); serving this checkout's again"
    ln -sfn "$ROOT/helper/web" "$lib"
  fi
  SHELL_LIBRARY=$(live_current shell-lib "$ROOT/helper/web")
}

pm() { $PODMAN "$@"; }
# Run a command in the container. -e VAR=value pairs may come first.
in_container() {
  local env=()
  while [[ $1 == -e ]]; do env+=(-e "$2"); shift 2; done
  pm exec "${env[@]}" -w "$CHROMIUM_DIR" "$CONTAINER" "$@"
}
# The same in the build container, from the Chromium checkout.
in_build_container() {
  local env=()
  while [[ $1 == -e ]]; do env+=(-e "$2"); shift 2; done
  pm exec "${env[@]}" -w "$CHROMIUM_DIR" "$BUILD_CONTAINER" "$@"
}
container_running() { [[ $(pm container inspect -f '{{.State.Running}}' "${1:-$CONTAINER}" 2>/dev/null) == true ]]; }
need_container() {
  container_running || die "the container '$CONTAINER' is not running (plutonium container create / start)"
}

# Where Ash runs (lib/common.sh): on the host with HOST=1, with the host tools
# first on PATH; else in the container.
if [[ -n ${HOST:-} ]]; then
  on_ash() {
    local env=("PATH=$HOST_TOOLS/bin:$PATH")
    while [[ $1 == -e ]]; do env+=("$2"); shift 2; done
    env "${env[@]}" "$@"
  }
  on_ash_daemon() { PATH=$HOST_TOOLS/bin:$PATH setsid "$@" < /dev/null > /dev/null 2>&1 & }
else
  on_ash() { in_container "$@"; }
  on_ash_setsid() {
    local env=()
    while [[ $1 == -e ]]; do env+=(-e "$2"); shift 2; done
    setsid $PODMAN exec "${env[@]}" "$CONTAINER" "$@"
  }
  # Detached: a background process of an attached exec keeps its session (and
  # pm's systemd-run --wait) from ever ending. Under a shell: as the detached
  # exec's own process, a daemon (Xvfb) dies within a second.
  on_ash_daemon() { pm exec -d "$CONTAINER" sh -c '"$@" > /dev/null 2>&1' sh "$@" > /dev/null; }
  need_ash_runtime() { need_container; }
  # Pages and shells use the host's fonts (LINUX_COMPAT.md, "Fonts"). In the
  # container, /etc/fonts is the host's when the container was made with it
  # (plutonium container create); this adds the user's own fonts and
  # settings, which the container's $HOME doesn't have. And the container
  # sees the runtime dir, not the rest of $HOME: an X11 session's XAUTHORITY
  # is copied there.
  ash_prepare() {
    local fonts=$DATA_DIR/fonts-$SOCKET.conf data_home=${XDG_DATA_HOME:-$HOME/.local/share} config_home=${XDG_CONFIG_HOME:-$HOME/.config}
    cat > "$fonts" <<FONTS
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <dir>$data_home/fonts</dir>
  <dir>$HOME/.fonts</dir>
  <include ignore_missing="yes">$config_home/fontconfig/conf.d</include>
  <include ignore_missing="yes">$config_home/fontconfig/fonts.conf</include>
</fontconfig>
FONTS
    ASH_ENV+=(-e "FONTCONFIG_FILE=$fonts")
    [[ $(pm container inspect --format '{{index .Config.Labels "plutonium.host-fonts"}}' "$CONTAINER" 2> /dev/null) == 1 ]] ||
      log "note: $CONTAINER has the image's fonts, not the host's: make it again for the host's (podman rm -f $CONTAINER; plutonium container create)"
    if [[ $MODE == x11 && -n ${XAUTHORITY:-} && $XAUTHORITY != "$RUN_DIR"/* && -f $XAUTHORITY ]]; then
      mkdir -p "$RUN_DIR/plutonium"
      cp "$XAUTHORITY" "$RUN_DIR/plutonium/xauthority"
      XAUTHORITY=$RUN_DIR/plutonium/xauthority
    fi
  }
fi

# Copy what a release build runs with from out dir $1 into $2/chrome.
stage_release() {
  local out=$1 stage=$2 f
  rm -rf "$stage/chrome"
  mkdir -p "$stage/chrome"
  # What Chrome's Linux installer ships (chrome/installer/linux), plus
  # every top-level resource file, since the ChromeOS build has more.
  for f in chrome chrome_crashpad_handler icudtl.dat vk_swiftshader_icd.json \
           libEGL.so libGLESv2.so libvk_swiftshader.so libvulkan.so.1 \
           "$out"/*.pak "$out"/*.bin "$out"/*.dat; do
    f=${f##*/}
    [[ -e $out/$f ]] && cp -a "$out/$f" "$stage/chrome/"
  done
  [[ -e $out/chrome_sandbox ]] && cp -a "$out/chrome_sandbox" "$stage/chrome/chrome-sandbox"
  for f in locales MEIPreload PrivacySandboxAttestationsPreloaded resources; do
    [[ -d $out/$f ]] && cp -a "$out/$f" "$stage/chrome/"
  done
  true
}
