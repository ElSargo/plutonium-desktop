# The commands of a checkout of the source, which bin/plutonium sources after
# lib/common.sh (and dev/env.sh): the container, Chromium and its prebuilt
# image, HOST=1's build, the live frontends, worktrees and the release bundle.
# A release install has no dev/, and none of them.

dev_usage() {
  cat <<EOF2

Setup from source (INSTALL.md):
  container build            build the image ($IMAGE)
  container create           create the container ($CONTAINER) and start it
  container start|stop       start or stop it
  container shell            a shell inside it
  chromium fetch             depot_tools and a Chromium checkout at chromium/BASE (~100 GB, hours)
  chromium patch             apply chromium/patches on a branch 'plutonium'
  chromium build [--release|--official]
                             gn gen with chromium/args.gn (args.release.gn, args.official.gn),
                             then build chrome
                             from the checkout as it is (a dev build of this checkout's patches is kept)
  hydra fetch|build          Hydra's T3 Code: clone it and apply its patches, then build it
  image pull                 PREBUILT=1: download the prebuilt Chromium instead of building it
  host build                 HOST=1: the release build (prebuilt image, or out/Release) for the
                             host, with nixpkgs libraries (dev/nix/chrome.nix), and the tools a
                             session uses (dev/nix/host-tools.nix): no container to run it

Development:
  cdp [--x11] <args>         DevTools of this slot's DRM (or X11) session, where Ash runs:
                             tools/cdp.py --help; 'cdp where' prints its socket (or host:port)
  live apply|revert|status   swap the shell library (shell.js) a running session serves, and
                             reload its shells: plutonium live --help
  chromium export            rewrite chromium/patches from the checkout's commits since BASE
  chromium ensure            a dev build of this checkout's patches for its sessions: kept already,
                             or built in the Chromium checkout, which then goes back to what it had
  chromium wait [seconds]    wait for this checkout's --bg command: patch, build and ensure take
                             --bg to run as a user unit. They queue on one lock across checkouts
  hydra export|live          Hydra's patches; its web app in a running session: plutonium hydra help
  shells export <name>       your edits to an installed shell, back into shells/<name>
  image build|push|login|tag the prebuilt image, from the release build (chromium build --release)
  bundle build [options]     the release bundle: chrome with its libraries, node, the helper,
                             the shells and their builds (Hydra's server), in
                             dist/plutonium-<version>-x86_64.tar.xz
                             (dev/bundle/build.sh has the options)
  bundle check [tarball]     install it (dev/bundle/install.sh) in clean containers of several
                             distributions, check its binaries, run a session from it, uninstall
  worktree add <name> [ref]  a git worktree in .worktrees/<name> with its own slot (ports, sockets)
  worktree setup             give a worktree made elsewhere its slot and plutonium.env
  worktree info|list         this checkout's slot and ports / every worktree's slot

Settings: plutonium.env (see plutonium.env.example).
EOF2
}

dev_has() { [[ $1 == @(container|chromium|image|host|bundle|live|worktree|cdp) ]]; }
dev_cmd() {
  local cmd=$1
  shift
  case $cmd in
    container) container_cmd "$@" ;;
    chromium) chromium_cmd "$@" ;;
    image) image_cmd "$@" ;;
    host) host_cmd "$@" ;;
    live) live_cmd "$@" ;;
    worktree) worktree_cmd "$@" ;;
    bundle)
      case "${1:-}" in
        build) shift; exec "$ROOT/dev/bundle/build.sh" "$@" ;;
        check) shift; exec "$ROOT/dev/bundle/check.sh" "$@" ;;
        *) usage; exit 2 ;;
      esac ;;
    # tools/cdp.py from the main checkout, which the container mounts.
    cdp)
      local cdp_mode=drm
      [[ ${1:-} == --x11 ]] && { cdp_mode=x11; shift; }
      session_vars "$cdp_mode"
      if [[ ${1:-} == where ]]; then echo "${CDP:-$CDP_ADDR}"; return; fi
      need_ash_runtime; on_ash -e "CDP=${CDP:-$CDP_ADDR}" python3 "$MAIN_ROOT/tools/cdp.py" "$@" ;;
  esac
}

# plutonium status: where Ash runs and which chrome, and the Chromium checkout.
dev_status() {
  if [[ -n ${HOST:-} ]]; then echo "Ash runs on the host (HOST=1)"
  elif container_running; then echo "container $CONTAINER: running"
  else echo "container $CONTAINER: not running"; fi
  local from=
  [[ -z ${HOST:-} && -n ${PREBUILT:-} ]] && from=" (prebuilt, $IMAGE)"
  chrome_built && echo "chrome: $CHROME_BIN$from" || echo "chrome: missing ($CHROME_BIN)"
  local lock=$RUN_DIR/plutonium/chromium.lock
  if [[ -f $lock ]] && ! flock -n "$lock" true; then echo "Chromium checkout: busy, $(cat "$lock.who" 2>/dev/null)"; fi
  [[ $(systemctl --user is-active "$CHROMIUM_UNIT" 2>/dev/null) == active ]] &&
    echo "background chromium command: running (plutonium chromium wait)"
  (( SLOT )) && echo "slot $SLOT (plutonium worktree info)"
  # A release install on this machine runs what it was built from, not this
  # checkout: say how they differ.
  local release
  release=$(readlink -f "$(command -v plutonium 2> /dev/null || echo /usr/local/bin/plutonium)" 2> /dev/null) &&
    release=${release%/bin/plutonium}
  if [[ -n $release && -f $release/BUNDLE ]]; then
    local commit behind
    commit=$(sed -n 's/^COMMIT=//p' "$release/BUNDLE")
    behind=$(git -C "$ROOT" rev-list --count "${commit%-dirty}..HEAD" 2> /dev/null || echo "?")
    echo "release install: $release, $(bundle_describe "$release/BUNDLE"); this checkout is $behind commits ahead of it"
  fi
  true
}

# plutonium session start (a display manager's login): the container, unless
# HOST=1. Sets session_start's problem if it doesn't start.
dev_session_start() {
  [[ -z ${HOST:-} ]] && ! container_running || return 0
  if [[ -n $dry ]]; then session_log info "would start the container $CONTAINER (plutonium container start)"
  else container_cmd start > /dev/null 2>&1 || problem="the container $CONTAINER doesn't start (plutonium doctor)"; fi
}

# doctor's checks of a checkout: podman, and the container and Chromium
# build a session runs (or HOST=1's).
dev_doctor() {
  local podman_ok=
  check "podman" "command -v podman" "$(install_hint podman)"
  if command -v podman > /dev/null; then
    if pm info > /dev/null 2>&1; then ok "podman works from this shell"; podman_ok=1
    else missing "podman works from this shell" "$(podman_fix)"; fi
  fi
  if [[ -n ${HOST:-} ]]; then
    echo "Ash on the host (HOST=1):"
    check "nix" "command -v nix" "HOST=1 needs Nix; remove it from plutonium.env to run Ash in the container"
    check "chrome ($CHROME_BIN)" "chrome_built" "plutonium host build"
    check "Xvfb (--x11 without a display)" "on_ash sh -c 'command -v Xvfb'" "plutonium host build"
    check "python3 websockets (plutonium cdp)" "on_ash python3 -c 'import websockets'" "plutonium host build"
  elif [[ -z $podman_ok ]]; then
    echo "Container: (checked once podman works)"
  else
    echo "Container and Chromium:"
    local remake="make the container again: plutonium container stop; podman rm $CONTAINER; plutonium container create"
    if [[ -n ${PREBUILT:-} ]]; then
      check "prebuilt image $IMAGE" "pm image exists $IMAGE" "plutonium image pull (about 1.3 GB)"
    else
      check "build image $IMAGE" "pm image exists $IMAGE" "plutonium container build, or PREBUILT=1 in plutonium.env for the prebuilt Chromium"
    fi
    if ! pm container exists "$CONTAINER"; then
      missing "container $CONTAINER" "plutonium container create"
    elif ! container_running; then
      missing "container $CONTAINER running" "plutonium container start"
    else
      ok "container $CONTAINER running"
      if [[ -n ${PREBUILT:-} ]]; then
        check "it runs this checkout's image" "[ \"\$(pm container inspect -f '{{.ImageName}}' $CONTAINER)\" = $IMAGE ]" \
          "the image changed with chromium/ (git pull): plutonium image pull, then $remake"
      fi
      check "the system D-Bus in the container (DRM)" "in_container test -S /run/dbus/system_bus_socket" "$remake"
      check "uid 65534 unmapped in the container (DRM input hotplug)" "in_container cat /proc/self/uid_map | awk '\$1 <= 65534 && 65534 < \$1 + \$3 { m = 1 } END { exit m }'" "$remake"
      local camera
      for camera in /dev/video*; do
        [[ -c $camera ]] || continue
        check_opt "camera $camera in the container (tabs' getUserMedia)" "in_container test -c $camera" "$remake"
      done
      if [[ -n ${PREBUILT:-} ]]; then
        check "chrome in the container" "chrome_built" "$remake"
      fi
    fi
    if [[ -z ${PREBUILT:-} ]]; then
      check "Chromium checkout at $CHROMIUM_DIR/src" "[ -d $CHROMIUM_DIR/src/.git ]" "plutonium chromium fetch, or PREBUILT=1 in plutonium.env"
      check "patched (branch plutonium)" "git -C $CHROMIUM_DIR/src rev-parse -q --verify refs/heads/plutonium" "plutonium chromium patch"
      check "built ($CHROME_BIN)" "[ -x $CHROME_BIN ]" "plutonium chromium build"
    fi
  fi
}

# --- Container ---------------------------------------------------------------
container_cmd() {
  case "${1:-}" in
    build)
      pm build --build-arg "CHROMIUM_BASE=$(cat "$ROOT/chromium/BASE")" -t "$IMAGE" \
        -f "$ROOT/dev/container/Containerfile" "$ROOT/dev/container" ;;
    create)
      pm container exists "$CONTAINER" && die "a container '$CONTAINER' already exists"
      mkdir -p "$DATA_DIR" "$RUN_DIR"
      [[ -n ${PREBUILT:-} ]] || mkdir -p "$CHROMIUM_DIR" "$DEPOT_TOOLS"
      local mounts=() dir
      # Same path inside as outside, so paths need no translation. The
      # user's home too (TAB_FEATURES.md, "Paths in the container"): a file
      # picked for a tab is a host path, and Ash opens it as it is. The
      # container's own $HOME (depot_tools' settings and caches, what Chrome
      # writes there) is a directory under the data dir.
      mkdir -p "$DATA_DIR/container-home"
      mounts+=(-v "$HOME:$HOME")
      local dirs=("$ROOT" "$DATA_DIR" "$RUN_DIR")
      [[ -n ${PREBUILT:-} ]] || dirs+=("$CHROMIUM_DIR" "$DEPOT_TOOLS")
      for dir in "${dirs[@]}"; do
        mounts+=(-v "$dir:$dir")
      done
      [[ -d /tmp/.X11-unix ]] && mounts+=(-v /tmp/.X11-unix:/tmp/.X11-unix)
      # Cameras, for tabs' getUserMedia (V4L2, as on desktop Linux). Those
      # plugged in now: one plugged in later needs the container made again.
      local dev
      for dev in /dev/video* /dev/media*; do
        [[ -c $dev ]] && mounts+=(--device "$dev")
      done
      # The host's fonts and fontconfig (LINUX_COMPAT.md, "Fonts"), in place
      # of the image's: its /etc/fonts and the font directories it names
      # (NixOS: the store). The user's own are in $HOME (lib/session.sh).
      if [[ -f /etc/fonts/fonts.conf ]]; then
        mounts+=(-v /etc/fonts:/etc/fonts:ro --label plutonium.host-fonts=1)
        for dir in /usr/share/fonts /usr/local/share/fonts /nix/store; do
          [[ -d $dir ]] && mounts+=(-v "$dir:$dir:ro")
        done
      fi
      # - host pid namespace: Exo reports real client pids, which the helper
      #   maps to threads;
      # - /dev/dri, /dev/input and udev: Ash on DRM with evdev input (and the
      #   cameras above);
      # - the system D-Bus: Ash gets the display and input devices from logind;
      # - keep-id: files in the checkout stay yours. size=65534 leaves uid
      #   65534 unmapped, which host root shows up as: libudev trusts senders
      #   outside its user namespace, so it takes the host's udev events, and
      #   Ash sees hotplugged input devices. Mapped, it drops them.
      pm create --name "$CONTAINER" --hostname "$CONTAINER" --pid=host --network=host --ipc=host \
        --userns=keep-id:size=65534 --group-add keep-groups --security-opt label=disable \
        --device /dev/dri -v /dev/input:/dev/input -v /run/udev:/run/udev:ro -v /run/dbus:/run/dbus "${mounts[@]}" \
        -e HOME="$DATA_DIR/container-home" -e XDG_RUNTIME_DIR="$RUN_DIR" \
        -e PATH="$DEPOT_TOOLS:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
        -w "$([[ -n ${PREBUILT:-} ]] && echo "$ROOT" || echo "$CHROMIUM_DIR")" "$IMAGE" sleep infinity > /dev/null
      container_cmd start ;;
    start)
      # From a systemd user unit that stays, so the container's monitor
      # (conmon) outlives the shell, or podman wrapper, that started it.
      systemctl --user reset-failed "plutonium-container-$CONTAINER" 2>/dev/null || true
      systemctl --user stop "plutonium-container-$CONTAINER" 2>/dev/null || true
      systemd-run --user --quiet --unit="plutonium-container-$CONTAINER" -p Type=oneshot -p RemainAfterExit=yes \
        --setenv=PATH="$PATH" "$(command -v podman)" start "$CONTAINER" > /dev/null
      sleep 1
      container_running || die "$CONTAINER did not start (podman logs $CONTAINER)"
      echo "started $CONTAINER" ;;
    stop) pm stop -t 5 "$CONTAINER" > /dev/null; systemctl --user stop "plutonium-container-$CONTAINER" 2>/dev/null || true ;;
    shell) need_container; pm exec -it "$CONTAINER" bash ;;
    *) usage; exit 2 ;;
  esac
}

# --- Prebuilt image ----------------------------------------------------------
image_cmd() {
  local ref=$PREBUILT_REPO:$PREBUILT_TAG
  case "${1:-}" in
    build)
      # In the build container: it has strip and the Chromium checkout, and
      # the prebuilt image (CONTAINER with PREBUILT=1) has neither.
      container_running "$BUILD_CONTAINER" ||
        die "the build container '$BUILD_CONTAINER' is not running (plutonium container create, without PREBUILT=1; or set BUILD_CONTAINER)"
      local out=$CHROMIUM_DIR/src/$CHROMIUM_RELEASE_OUT stage=$DATA_DIR/image-stage
      [[ -x $out/chrome ]] || die "no release build at $out (plutonium chromium build --release)"
      stage_release "$out" "$stage"
      in_build_container sh -c "strip --strip-unneeded '$stage/chrome/chrome' '$stage/chrome/chrome_crashpad_handler' '$stage'/chrome/*.so*"
      # Chromium's license notices, which redistributing it requires.
      in_build_container sh -c "cd src && python3 tools/licenses/licenses.py credits --gn-target //chrome:chrome --gn-out-dir $CHROMIUM_RELEASE_OUT '$stage/chrome/LICENSES.chromium.html'" ||
        echo "warning: could not generate LICENSES.chromium.html" >&2
      cp "$ROOT/dev/container/Containerfile.runtime" "$stage/Containerfile"
      du -sh "$stage/chrome"
      pm build -t "$ref" -f "$stage/Containerfile" "$stage"
      pm tag "$ref" "$PREBUILT_REPO:latest"
      echo "built $ref" ;;
    push)
      pm push "$ref" && pm push "$PREBUILT_REPO:latest" ;;
    pull)
      local err
      err=$(pm pull "$ref" 2>&1 | tee /dev/stderr) && return
      case $err in
        *unauthorized*|*denied*|*authentication*)
          die "ghcr.io won't give $ref without a login: log in with a GitHub token that can read packages (INSTALL.md, Prebuilt)" ;;
        *"manifest unknown"*|*"not found"*)
          die "there is no prebuilt image for this checkout's chromium/ ($PREBUILT_TAG): its patches changed after the last published image. Check out a commit that has one, or build Chromium yourself (INSTALL.md, steps 3 and 4)" ;;
        *) die "could not pull $ref" ;;
      esac ;;
    login)
      # A token with write:packages (gh auth refresh -s write:packages).
      gh auth token | pm login ghcr.io -u "$(gh api user --jq .login)" --password-stdin ;;
    tag) echo "$ref" ;;
    *) usage; exit 2 ;;
  esac
}

# --- On the host --------------------------------------------------------------
host_cmd() {
  case "${1:-}" in
    build)
      command -v nix > /dev/null || die "host build needs Nix"
      local stage=$DATA_DIR/host-stage
      rm -rf "$stage"
      mkdir -p "$stage"
      if [[ -n ${PREBUILT:-} ]]; then
        pm image exists "$IMAGE" || die "no image $IMAGE (plutonium image pull)"
        local c
        c=$(pm create "$IMAGE" true)
        pm cp "$c:/opt/plutonium/chrome" "$stage/" || { pm rm "$c" > /dev/null; die "could not copy chrome out of $IMAGE"; }
        pm rm "$c" > /dev/null
      else
        local out=$CHROMIUM_DIR/src/$CHROMIUM_RELEASE_OUT
        [[ -x $out/chrome ]] || die "no release build at $out (plutonium chromium build --release)"
        stage_release "$out" "$stage"
      fi
      # Against the system's nixpkgs, so libgbm and libEGL match its Mesa.
      nix build --impure --out-link "$HOST_CHROME" --expr \
        "(import <nixpkgs> {}).callPackage $ROOT/dev/nix/chrome.nix { src = /. + \"$stage/chrome\"; }"
      nix build --impure --out-link "$HOST_TOOLS" --expr \
        "(import <nixpkgs> {}).callPackage $ROOT/dev/nix/host-tools.nix {}"
      rm -rf "$stage"
      echo "chrome for the host: $HOST_CHROME/bin/chrome. Set HOST=1 in plutonium.env to run sessions with it" ;;
    *) usage; exit 2 ;;
  esac
}

# --- Chromium ----------------------------------------------------------------
# One Chromium checkout serves every checkout of this repository (worktrees
# too), so whatever changes it or builds in it takes a lock, and waits for
# whoever holds it.
chromium_lock() {
  local lock=$RUN_DIR/plutonium/chromium.lock
  mkdir -p "$RUN_DIR/plutonium"
  exec 9>> "$lock"
  if ! flock -n 9; then
    echo "waiting for the Chromium checkout: $(cat "$lock.who" 2>/dev/null || echo "another command has it")" >&2
    flock 9
  fi
  echo "chromium $1 from $ROOT (since $(date +%T))" > "$lock.who"
}
src_clean() { [[ -z $(git -C "$CHROMIUM_DIR/src" status --porcelain --untracked-files=no) ]]; }

# git commit-tree needs a committer; a neutral one if git has none configured.
committer() {
  if git config user.email > /dev/null; then "$@"
  else GIT_COMMITTER_NAME=Plutonium GIT_COMMITTER_EMAIL=plutonium@localhost "$@"; fi
}

# This checkout's patch series as a commit on BASE, made without touching the
# checkout's files: each patch is applied to a scratch index (what git am
# does, with the same author, date and message), so `chromium export` gives
# the same patches back. Kept by BUILD_KEY.
patch_commit() (
  set -e
  src=$CHROMIUM_DIR/src cache=$BUILDS_DIR/.commits/$BUILD_KEY
  if commit=$(cat "$cache" 2>/dev/null) && git -C "$src" cat-file -e "$commit^{commit}" 2>/dev/null; then
    echo "$commit"; exit 0
  fi
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  export GIT_INDEX_FILE=$tmp/index
  commit=$(cat "$ROOT/chromium/BASE")
  git -C "$src" read-tree "$commit"
  for patch in "$ROOT"/chromium/patches/*.patch; do
    git -C "$src" mailinfo "$tmp/msg" "$tmp/diff" < "$patch" > "$tmp/info"
    git -C "$src" apply --cached --3way "$tmp/diff" 2> "$tmp/err" ||
      { cat "$tmp/err" >&2; echo "plutonium: ${patch##*/} does not apply" >&2; exit 1; }
    field() { sed -n "s/^$1: //p" "$tmp/info"; }
    { field Subject; [[ -s $tmp/msg ]] && { echo; cat "$tmp/msg"; }; } > "$tmp/message"
    commit=$(GIT_AUTHOR_NAME=$(field Author) GIT_AUTHOR_EMAIL=$(field Email) GIT_AUTHOR_DATE=$(field Date) \
      committer git -C "$src" commit-tree "$(git -C "$src" write-tree)" -p "$commit" -F "$tmp/message")
  done
  mkdir -p "${cache%/*}"
  echo "$commit" > "$cache"
  echo "$commit"
)

# The build's args.gn: chromium/args.gn (args.release.gn, args.official.gn), and with CCACHE=1
# the compiler through ccache. Chromium's clang modules can't be cached, so
# they're off then.
chromium_args() {
  cat "$1"
  [[ -n ${CCACHE:-} ]] && printf '%s\n' "" "# CCACHE=1 (plutonium.env)" 'cc_wrapper = "ccache"' "use_clang_modules = false"
  true
}
# Build chrome in the out dir (the release or official one), from the
# Chromium checkout as it is. A dev build of this checkout's own series is kept.
chromium_build() {
  local release=${1:-} src=$CHROMIUM_DIR/src outdir=$CHROMIUM_OUT args=$ROOT/chromium/args.gn env=()
  container_running "$BUILD_CONTAINER" ||
    die "the build container '$BUILD_CONTAINER' is not running (plutonium container create, without PREBUILT=1; or set BUILD_CONTAINER)"
  case $release in
    release) outdir=$CHROMIUM_RELEASE_OUT args=$ROOT/chromium/args.release.gn ;;
    official) outdir=$CHROMIUM_OFFICIAL_OUT args=$ROOT/chromium/args.official.gn ;;
  esac
  mkdir -p "$src/$outdir"
  cmp -s <(chromium_args "$args") "$src/$outdir/args.gn" || chromium_args "$args" > "$src/$outdir/args.gn"
  if [[ -n ${CCACHE:-} ]]; then
    in_build_container sh -c 'command -v ccache' > /dev/null ||
      die "CCACHE=1, but the build container has no ccache (plutonium container build, then create it again)"
    env=(-e "CCACHE_DIR=$CCACHE_DIR" -e "CCACHE_MAXSIZE=$CCACHE_SIZE" -e "CCACHE_BASEDIR=$src"
         -e CCACHE_SLOPPINESS=time_macros,include_file_mtime,include_file_ctime)
  fi
  # Out of memory, the kernel kills a compiler or linker rather than the
  # desktop's Chrome (whose renderers ask to go first, with up to 1000).
  in_build_container "${env[@]}" sh -c "echo 1000 > /proc/self/oom_score_adj; cd src && gn gen $outdir && autoninja -j $BUILD_JOBS -C $outdir chrome"
  [[ -n $release ]] || record_build "$src/$outdir"
}
# Say in the out dir what it holds, and keep a build of this checkout's series
# where a session can run it while the out dir moves on.
record_build() {
  local out=$1 src=$CHROMIUM_DIR/src mine
  mine=$(patch_commit) || return 0
  if src_clean && [[ $(git -C "$src" rev-parse 'HEAD^{tree}') == $(git -C "$src" rev-parse "$mine^{tree}") ]]; then
    echo "key $BUILD_KEY" > "$out/.plutonium-build"
    keep_build "$out"
  elif git -C "$src" merge-base --is-ancestor "$mine" HEAD; then
    echo "custom $BUILD_KEY" > "$out/.plutonium-build"   # more work on top of this series
  else
    echo "other" > "$out/.plutonium-build"
  fi
}
# Copy what chrome runs with (reflinks, where the filesystem has them) to
# BUILDS_DIR/<key>, and drop the oldest kept builds that no session runs.
keep_build() {
  local out=$1 dest=$BUILDS_DIR/$BUILD_KEY tmp=$BUILDS_DIR/.$BUILD_KEY.$$ f dir n=0
  mkdir -p "$tmp"
  for f in "$out"/*; do
    case ${f##*/} in
      obj|gen|clang_*|local_rustc_sysroot|pyproto|jsproto|args.gn|siso*|*.TOC|*.runtime_deps|*.ninja|*.ninja.*|*_unittest_exes.txt) continue ;;
    esac
    cp -a --reflink=auto "$f" "$tmp/"
  done
  rm -rf "$dest"
  mv "$tmp" "$dest"
  echo "kept this build as $dest"
  for dir in $(ls -1dt "$BUILDS_DIR"/*/ 2> /dev/null); do
    dir=${dir%/}
    n=$((n + 1))
    (( n <= BUILDS_KEEP )) && continue
    pgrep -f "^$dir/chrome " > /dev/null && continue
    rm -rf "$dir"
  done
}

# --bg: run a chromium command as a systemd user unit, so it outlives the
# shell (and an agent's command timeout). One per checkout; the lock queues
# them across checkouts. `chromium wait` waits for it.
CHROMIUM_UNIT=plutonium-chromium-$(echo "$ROOT" | sha256sum | cut -c1-8)
chromium_bg() {
  local log=$LOGS/chromium.log status=$LOGS/chromium.status
  [[ $(systemctl --user is-active "$CHROMIUM_UNIT" 2> /dev/null) == @(active|activating) ]] &&
    die "this checkout's background command is still running (plutonium chromium wait)"
  systemctl --user reset-failed "$CHROMIUM_UNIT" 2> /dev/null || true
  rm -f "$status"
  : > "$log"
  systemd-run --user --quiet --collect --unit="$CHROMIUM_UNIT" --setenv=PATH="$PATH" \
    sh -c 'log=$1 status=$2; shift 2; "$@" >> "$log" 2>&1; echo $? > "$status"' \
    sh "$log" "$status" "$ROOT/bin/plutonium" chromium "$@"
  echo "chromium $* runs in the background (log logs/chromium.log); plutonium chromium wait"
}
chromium_wait() {
  local limit=${1:-} start=$SECONDS log=$LOGS/chromium.log status=$LOGS/chromium.status
  while [[ $(systemctl --user is-active "$CHROMIUM_UNIT" 2> /dev/null) == @(active|activating|deactivating) ]]; do
    if [[ -n $limit ]] && (( SECONDS - start >= limit )); then
      echo "still running: $(tail -n 1 "$log" | cut -c1-160)"
      return 124
    fi
    sleep 5
  done
  [[ -f $status ]] || die "this checkout has no background chromium command"
  tail -n 3 "$log"
  return "$(cat "$status")"
}

chromium_cmd() {
  local base src=$CHROMIUM_DIR/src arg args=() bg=
  base=$(cat "$ROOT/chromium/BASE")
  for arg in "$@"; do [[ $arg == --bg ]] && bg=1 || args+=("$arg"); done
  set -- "${args[@]}"
  if [[ -n $bg ]]; then
    [[ ${1:-} == @(patch|build|ensure) ]] || die "--bg is for chromium patch, build and ensure"
    chromium_bg "$@"
    return
  fi
  case "${1:-}" in
    fetch)
      container_running "$BUILD_CONTAINER" || die "the build container '$BUILD_CONTAINER' is not running"
      [[ -d $DEPOT_TOOLS/.git ]] ||
        git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git "$DEPOT_TOOLS"
      # What `fetch chromium` writes, plus the ChromeOS target; then one sync
      # straight to BASE (fetch would first sync to the newest revision).
      [[ -f $CHROMIUM_DIR/.gclient ]] || cat > "$CHROMIUM_DIR/.gclient" <<'GCLIENT'
solutions = [
  {
    "name": "src",
    "url": "https://chromium.googlesource.com/chromium/src.git",
    "custom_deps": {},
    "custom_vars": {},
  },
]
target_os = ['chromeos']
GCLIENT
      # googlesource rate-limits gclient's default parallelism (HTTP 429).
      in_build_container gclient sync --revision "src@$base" --nohooks --no-history -D -j 4
      in_build_container gclient runhooks
      echo "Chromium is at $base. Next: plutonium chromium patch" ;;
    patch)
      # Branch plutonium, at this checkout's series. Only files that differ
      # from what the checkout has are written, so the next build redoes no more
      # than it must.
      [[ -e $src/.git ]] || die "no checkout at $src (plutonium chromium fetch)"
      chromium_lock patch
      src_clean || die "$src has uncommitted changes"
      local commit tip last
      commit=$(patch_commit) || exit 1
      last=$(cat "$CHROMIUM_DIR/.plutonium-branch" 2> /dev/null || true)
      if tip=$(git -C "$src" rev-parse -q --verify refs/heads/plutonium) &&
         [[ $tip != "$commit" && $tip != "$last" && ${2:-} != --force ]]; then
        die "branch 'plutonium' in $src has commits that aren't in chromium/patches (chromium export them); --force moves it anyway (the old tip stays in its reflog)"
      fi
      git -C "$src" checkout -q -B plutonium "$commit"
      echo "$commit" > "$CHROMIUM_DIR/.plutonium-branch"
      echo "$(git -C "$src" rev-list --count "$base"..HEAD) patches on branch plutonium" ;;
    build)
      chromium_lock build
      case ${2:-} in
        '') chromium_build ;;
        --release|--official) chromium_build "${2#--}" ;;
        *) die "chromium build: unknown option $2" ;;
      esac ;;
    ensure)
      # A dev build of this checkout's series, for its sessions: the one kept
      # already, or the series built in the Chromium checkout, which then goes
      # back to what it had.
      [[ -e $src/.git ]] || die "no checkout at $src (plutonium chromium fetch)"
      chromium_lock ensure
      if [[ -x $BUILDS_DIR/$BUILD_KEY/chrome ]]; then
        echo "built already: $BUILDS_DIR/$BUILD_KEY"
      else
        src_clean || die "$src has uncommitted changes (someone is working in it); commit or stash them first"
        local commit prev
        commit=$(patch_commit) || exit 1
        prev=$(git -C "$src" symbolic-ref -q --short HEAD || git -C "$src" rev-parse HEAD)
        # shellcheck disable=SC2064 # $prev is local: expand it now
        trap "git -C '$src' checkout -q '$prev' && echo 'the Chromium checkout is back on $prev'" EXIT
        git -C "$src" checkout -q --detach "$commit"
        chromium_build
      fi
      [[ -n ${PREBUILT:-} ]] &&
        echo "note: this checkout's sessions run the prebuilt image (PREBUILT=1). To run this build, put PREBUILT= and CONTAINER=$BUILD_CONTAINER in plutonium.local.env"
      true ;;
    wait) chromium_wait "${2:-}" ;;
    export)
      [[ -e $src/.git ]] || die "no checkout at $src"
      # A worktree of the checkout (CHROMIUM_DIR=~/chromium-wt/<name>) is its
      # own; only the shared checkout needs the lock.
      [[ -d $src/.git ]] && chromium_lock export
      src_clean || die "commit your changes in $src first"
      rm -f "$ROOT"/chromium/patches/*.patch
      git -C "$src" format-patch -q --zero-commit --no-signature -o "$ROOT/chromium/patches" "$base"..HEAD
      ls "$ROOT/chromium/patches" | wc -l | xargs echo "patches written to chromium/patches:" ;;
    *) usage; exit 2 ;;
  esac
}

# --- Live frontends ----------------------------------------------------------
# A session's shells come through links (live_current, in common.sh) that their
# servers read through on every request. Pointing a link at other files and
# reloading the page changes a shell without restarting anything, and the page
# stays on the origin that Ash gave shell rights to when it started.
LIVE_KEEP=${LIVE_KEEP:-5}
LIVE_ALL=(shell-lib)
live_usage() {
  cat <<EOF2
Usage: plutonium live <command>

Changes what this slot's running sessions use as their shells, with no restart.
Parts: shell-lib (the helper's /v1/shell.js). The installed shells are served
from \$PLUTO_HOME/shells, read on every request: edit them there, or merge a
checkout's version with plutonium shells update <name> --from <checkout>.
Hydra's web app has its own: plutonium hydra live.

  apply <part>... [--from <dir|commit>] [--follow] [--no-reload]
        Copy the part from a checkout's files as they are now (default: this
        checkout), or from a commit of this repository. Serve the copy, and
        reload the pages that use it. --follow serves the checkout's own
        files instead.
  revert <part>...   go back to what was served before
  reload <part>...   reload the pages that use it
  status             what each part serves, and from where
  list <part>        its copies
EOF2
}
# A part's directory: its copies, and the links current and previous.
live_root() { echo "$LIVE_DIR/$1"; }
live_subdir() { case $1 in shell-lib) echo helper/web ;; esac; }
# Repoint a link with one rename, so no request finds it missing.
live_link() { ln -sfn "$2" "$1.tmp" && mv -T "$1.tmp" "$1"; }
# Make a target the part's current one; what was current becomes previous.
live_switch() {
  local root=$1 target=$2 old
  old=$(readlink "$root/current" 2> /dev/null || true)
  [[ -n $old && $old != "$target" ]] && live_link "$root/previous" "$old"
  live_link "$root/current" "$target"
}
live_new_id() {   # <root> <label>: a new copy's name, unused in <root>
  local id n=1
  id=$(date +%Y%m%d-%H%M%S)-$2
  while [[ -e $1/$id ]]; do n=$((n + 1)) id=${id%_[0-9]*}_$n; done
  echo "$id"
}
# "<commit>", with "-dirty" if the checkout has changes under the paths.
live_commit_of() {
  local dir=$1 commit
  shift
  commit=$(git -C "$dir" rev-parse --short=8 HEAD 2> /dev/null || echo nogit)
  [[ -n $(git -C "$dir" status --porcelain -- "$@" 2> /dev/null) ]] && commit+=-dirty
  echo "$commit"
}
live_note() {   # <root> <id> <source> <commit>
  printf 'source %s\ncommit %s\ntaken %s\n' "$3" "$4" "$(date '+%F %T')" > "$1/$2.info"
}

# Copy a shell part (or link it, with follow); prints the new target.
live_take() {   # <part> <source> <follow>
  local part=$1 src=$2 follow=$3 root sub id commit
  root=$(live_root "$part") sub=$(live_subdir "$part")
  mkdir -p "$root"
  if [[ -d $src ]]; then
    src=$(realpath "$src")
    [[ -d $src/$sub ]] || die "$src has no $sub"
    [[ -n $follow ]] && { echo "$src/$sub"; return; }
    commit=$(live_commit_of "$src" "$sub")
    id=$(live_new_id "$root" "$commit")
    cp -a --reflink=auto "$src/$sub" "$root/$id"
  else
    [[ -z $follow ]] || die "--follow takes a checkout directory, not a commit"
    commit=$(git -C "$ROOT" rev-parse --short=8 -q --verify "$src^{commit}") ||
      die "'$src' is neither a directory nor a commit in $ROOT"
    id=$(live_new_id "$root" "$commit") src="$ROOT at $src"
    mkdir "$root/$id"
    git -C "$ROOT" archive "$commit" "$sub" | tar -x -C "$root/$id" --strip-components=$(( $(tr -cd / <<< "$sub" | wc -c) + 1 ))
  fi
  live_note "$root" "$id" "$src" "$commit"
  echo "$id"
}

# The running helpers of this slot that serve shell.js from elsewhere.
live_helper_check() {
  local mode pid want=$LIVE_DIR/shell-lib/current/plutonium-shell.js
  for mode in drm x11; do
    session_vars "$mode"
    pid=$(cat "$RUN_DIR/plutonium/helper-$SOCKET.pid" 2> /dev/null || true)
    [[ -n $pid && -r /proc/$pid/environ ]] || continue
    tr '\0' '\n' < "/proc/$pid/environ" | grep -qxF "PLUTONIUM_SHELL_LIBRARY=$want" && continue
    echo "warning: the $mode session's helper started before live, and serves its own shell.js until the session restarts" >&2
  done
}
live_reload() {   # <part>...: the pages that use it (shell-lib: every shell's), through the sessions' helpers
  local mode name
  for mode in drm x11; do
    session_vars "$mode"
    [[ -S $RUN_DIR/plutonium/$SOCKET.sock ]] || continue
    for name in $(shells_cli list --json | grep -o '"name": "[^"]*"' | cut -d'"' -f4); do
      shell_server "$mode" "$name" reload 2> /dev/null | sed "/: 0$/d; s/^/$mode session, $name: /"
    done
  done
  true
}
live_prune() {   # <root>
  local root=$1 cur prev id
  cur=$(readlink "$root/current" 2> /dev/null || true) prev=$(readlink "$root/previous" 2> /dev/null || true)
  { ls -1 "$root" | grep -E '^[0-9]{8}-[0-9]{6}-[^.]*$' | sort -r | tail -n +$(( LIVE_KEEP + 1 )); } 2> /dev/null |
    while read -r id; do
      [[ $id == "$cur" || $id == "$prev" ]] || rm -rf "${root:?}/$id" "$root/$id.info"
    done || true
}
live_describe() {   # <root> <link>
  local target
  target=$(readlink "$1/$2" 2> /dev/null) || { echo "-"; return; }
  if [[ $target == /* ]]; then echo "$target, as it is"
  else echo "$target, from $(sed -n 's/^source //p' "$1/$target.info" 2> /dev/null), taken $(sed -n 's/^taken //p' "$1/$target.info" 2> /dev/null)"; fi
}
live_parts() {   # the arguments' parts, or die
  local arg
  for arg; do
    case $arg in
      shells|shell-lib) echo shell-lib ;;
      t3|hydra) die "Hydra's web app is Hydra's: plutonium hydra live" ;;
      *) [[ -d $PLUTO_HOME/shells/$arg ]] &&
           die "$arg is an installed shell, served from $PLUTO_HOME/shells/$arg as it is: edit it there, or merge a checkout's version (plutonium shells update $arg --from <checkout>)"
         die "unknown part '$arg' (shell-lib)" ;;
    esac
  done
}

live_cmd() {
  local cmd=${1:-} parts=() part root target from= follow= reload=1
  shift || true
  case $cmd in
    apply)
      while [[ $# -gt 0 ]]; do
        case $1 in
          --from) from=${2:?--from needs a directory or commit}; shift ;;
          --follow) follow=1 ;;
          --no-reload) reload= ;;
          *) parts+=($(live_parts "$1")) ;;
        esac
        shift
      done
      [[ ${#parts[@]} -gt 0 ]] || { live_usage; exit 2; }
      for part in "${parts[@]}"; do
        root=$(live_root "$part")
        live_current "$part" "$ROOT/$(live_subdir "$part")" > /dev/null
        target=$(live_take "$part" "${from:-$ROOT}" "$follow")
        live_switch "$root" "$target"
        echo "$part: $(live_describe "$root" current)"
        live_prune "$root"
      done
      [[ " ${parts[*]} " == *" shell-lib "* ]] && live_helper_check
      if [[ -n $reload ]]; then
        echo "(reloading the shells: Hydra's browser panel tabs move to Elsewhere, as after any reload)"
        live_reload "${parts[@]}"
      fi ;;
    revert)
      [[ $# -gt 0 ]] || { live_usage; exit 2; }
      parts=($(live_parts "$@"))
      for part in "${parts[@]}"; do
        root=$(live_root "$part")
        target=$(readlink "$root/previous" 2> /dev/null) || die "$part has nothing to go back to"
        live_switch "$root" "$target"
        echo "$part: $(live_describe "$root" current)"
      done
      live_reload "${parts[@]}" ;;
    reload)
      [[ $# -gt 0 ]] || { live_usage; exit 2; }
      live_reload $(live_parts "$@") ;;
    status)
      for part in "${LIVE_ALL[@]}"; do
        root=$(live_root "$part")
        if [[ ! -L $root/current ]]; then
          echo "$part: this checkout's own files (the next session links them)"
          continue
        fi
        echo "$part: $(live_describe "$root" current)"
        [[ -L $root/previous ]] && echo "  previous: $(live_describe "$root" previous)"
        live_helper_check 2>&1 | sed 's/^warning: /  /'
      done ;;
    list)
      [[ $# -eq 1 ]] || { live_usage; exit 2; }
      part=$(live_parts "$1") root=$(live_root "$part")
      local cur prev id mark
      cur=$(readlink "$root/current" 2> /dev/null || true) prev=$(readlink "$root/previous" 2> /dev/null || true)
      for id in $(ls -1 "$root" 2> /dev/null | grep -E '^[0-9]{8}-[0-9]{6}-[^.]*$' | sort -r || true); do
        mark="  "; [[ $id == "$cur" ]] && mark="* "; [[ $id == "$prev" ]] && mark="< "
        echo "$mark$id  $(sed -n 's/^source //p' "$root/$id.info" 2> /dev/null)"
      done
      [[ $cur == /* ]] && echo "* $cur (followed)"
      [[ $prev == /* ]] && echo "< $prev (followed)"
      true ;;
    *) live_usage; [[ -z $cmd || $cmd == -h || $cmd == --help ]] || exit 2 ;;
  esac
}

# --- Worktrees ---------------------------------------------------------------
# Parallel checkouts: each worktree gets a free slot and the main checkout's
# plutonium.env, so its sessions run beside everyone else's.
worktree_slots() {
  local dir
  git -C "$MAIN_ROOT" worktree list --porcelain | sed -n 's/^worktree //p' | while read -r dir; do
    [[ $dir == "$1" ]] || cat "$dir/.plutonium-slot" 2> /dev/null || true
  done
}
worktree_setup() {
  local dir=$1 slot=1 used
  if [[ ! -f $dir/.plutonium-slot ]]; then
    used=$(worktree_slots "$dir")
    while grep -qx "$slot" <<< "$used"; do slot=$((slot + 1)); done
    echo "$slot" > "$dir/.plutonium-slot"
  fi
  [[ -e $dir/plutonium.env || ! -f $MAIN_ROOT/plutonium.env ]] || ln -s "$MAIN_ROOT/plutonium.env" "$dir/plutonium.env"
  (cd "$dir" && "$dir/bin/plutonium" worktree info)
}
worktree_cmd() {
  case "${1:-}" in
    add)
      local name=${2:-} start=${3:-HEAD} dir
      [[ -n $name ]] || die "usage: plutonium worktree add <name> [<start>]"
      dir=$MAIN_ROOT/.worktrees/$name
      if git -C "$MAIN_ROOT" rev-parse -q --verify "refs/heads/$name" > /dev/null; then
        git -C "$MAIN_ROOT" worktree add -q "$dir" "$name"
      else
        git -C "$MAIN_ROOT" worktree add -q -b "$name" "$dir" "$start"
      fi
      worktree_setup "$dir" ;;
    setup)
      [[ $ROOT != "$MAIN_ROOT" ]] || die "this is the main checkout (slot 0); run this in a worktree"
      worktree_setup "$ROOT" ;;
    info)
      session_vars x11
      echo "$ROOT: slot $SLOT"
      echo "  X11 sessions: $SOCKET, DevTools $CDP_WHERE, helper $HELPER_PORT, Xvfb $PRIVATE_XDISP"
      session_vars drm
      echo "  DRM sessions: $SOCKET, DevTools $CDP_WHERE, helper $HELPER_PORT"
      echo "  shells: http://<name>.localhost:$SHELLS_PORT (server shells: their port + 100 × $SLOT); installed in $PLUTO_HOME"
      echo "  Chromium: $CHROME_BIN" ;;
    list)
      local dir
      git -C "$MAIN_ROOT" worktree list --porcelain | sed -n 's/^worktree //p' | while read -r dir; do
        echo "slot $(cat "$dir/.plutonium-slot" 2> /dev/null || echo "0 (unset)")  $dir"
      done ;;
    *) usage; exit 2 ;;
  esac
}

# Why podman doesn't work from here, and what fixes it.
podman_fix() {
  local err
  err=$(pm info 2>&1 > /dev/null | grep -iE 'error|cannot|denied' | tail -1)
  if ! grep -q "^$(id -un):" /etc/subuid 2>/dev/null || ! grep -q "^$(id -un):" /etc/subgid 2>/dev/null; then
    echo "no /etc/subuid or /etc/subgid entry for $(id -un): sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $(id -un), then podman system migrate"
  elif [[ $err == *"re-exec"* ]]; then
    echo "this shell is in another user namespace: set PODMAN=dev/pm.sh in plutonium.env"
  elif [[ $err == *newuidmap* && ! -x /usr/bin/newuidmap ]]; then
    echo "no newuidmap: $(install_hint uidmap)"
  elif [[ $err == *newuidmap* ]]; then
    echo "newuidmap can't map your subordinate ids (${err:0:120}): it must be setuid root (sudo chmod u+s /usr/bin/newuidmap /usr/bin/newgidmap), or this is a container"
  else
    echo "${err:-podman info fails}; see podman info"
  fi
}

