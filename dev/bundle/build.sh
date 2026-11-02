#!/usr/bin/env bash
# plutonium bundle build: the release bundle, one directory that runs on any
# x86-64 systemd distribution with a desktop's libraries (glibc, Mesa, X11,
# GLib: bundle/host-libs.txt), packed as dist/plutonium-<version>-x86_64.tar.xz.
#
#   chrome/     the release build, with the libraries the host lacks in lib/
#   node/       Node (dev/bundle/node.txt), for the helper, the shells and the CLI
#   bin/ lib/ helper/ shells/ skill/   from this checkout, less
#               what each shell's manifest excludes (Hydra's T3 Code patches)
#   shells/<name>/build/   what a shell's manifest "bundle" builds (Hydra's server)
#   BUNDLE      exactly what it was made from: the commit, the Chromium build,
#               each shell's files (their git tree) and build
#
# Made from a commit as it is: a checkout with uncommitted changes needs
# --allow-dirty, and says so in BUNDLE. Chrome is the official build in the
# Chromium checkout (chromium build --official), and BUNDLE's CHROMIUM_BUILD
# is its label (.plutonium-build: "official <hash of chromium/>").
#
# Options:
#   --chrome-out <dir>      the out dir chrome comes from
#                           (default: $CHROMIUM_DIR/src/out/Official)
#   --allow-dirty           build from uncommitted changes
#   --version <v>           default: git describe (a tag v0.1.0 is 0.1.0)
#   --out <dir>             where the tarball goes (default: dist/)
#   --no-shell-builds       leave the shells' builds out (Hydra can't run then)
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/common.sh"

chrome_out= version= out=$ROOT/dist shell_builds=1 allow_dirty=
while [[ $# -gt 0 ]]; do
  case $1 in
    --chrome-out) chrome_out=$2; shift ;;
    --allow-dirty) allow_dirty=1 ;;
    --version) version=$2; shift ;;
    --out) out=$2; shift ;;
    --no-shell-builds) shell_builds= ;;
    *) die "bundle build: unknown option $1" ;;
  esac
  shift
done
commit=$(git -C "$ROOT" rev-parse HEAD)
dirty=$([[ -n $(git -C "$ROOT" status --porcelain) ]] && echo 1 || true)
[[ -z $dirty || -n $allow_dirty ]] ||
  die "bundle build: $ROOT has uncommitted changes; commit them, or --allow-dirty (BUNDLE then says DIRTY=1)"
chrome_out=${chrome_out:-$CHROMIUM_DIR/src/$CHROMIUM_OFFICIAL_OUT}
# A tag v0.1.0 is version 0.1.0.
version=${version:-$(git -C "$ROOT" describe --tags --always --dirty)}
version=${version#v}
name=plutonium-$version-x86_64
. "$ROOT/dev/bundle/node.txt"

WORK=$DATA_DIR/bundle$SLOT_SUFFIX
stage=$WORK/stage/$name
mkdir -p "$WORK/cache" "$out"
rm -rf "$WORK/stage"
mkdir -p "$stage"
step() { echo "== $*"; }

# The builder image, made again when its Containerfile changes.
builder=localhost/plutonium-bundle:$(sha256sum "$ROOT/dev/bundle/Containerfile" | cut -c1-12)
in_builder() {
  pm image exists "$builder" || pm build -t "$builder" -f "$ROOT/dev/bundle/Containerfile" "$ROOT/dev/bundle"
  pm run --rm --security-opt label=disable -v "$WORK/stage:/stage" -v "$ROOT/dev/bundle:/bundle:ro" "$builder" "$@"
}

# --- Chromium ----------------------------------------------------------------
step "chrome from $chrome_out"
[[ -x $chrome_out/chrome ]] || die "no build at $chrome_out (plutonium chromium build --official)"
stage_release "$chrome_out" "$stage"
[[ -f $chrome_out/LICENSES.chromium.html ]] && cp "$chrome_out/LICENSES.chromium.html" "$stage/chrome/" ||
  echo "warning: no LICENSES.chromium.html (DEVELOPING.md, \"Publishing a release\"); the bundle can't be published without it" >&2
chromium_build=$(cat "$chrome_out/.plutonium-build" 2>/dev/null || true)
expected="official $(cat "$ROOT/chromium/BASE" "$ROOT/chromium/args.gn" "$ROOT"/chromium/patches/*.patch | sha256sum | cut -c1-12)"
[[ $chromium_build == "$expected" ]] ||
  echo "warning: $chrome_out is labelled '${chromium_build:-nothing}', not '$expected' (this checkout's patches); the bundle can't be published" >&2
(
  cd "$stage/chrome"
  shopt -s nullglob
  while read -r pattern; do
    [[ -z $pattern || $pattern == \#* ]] && continue
    # shellcheck disable=SC2086 # a glob
    rm -rf $pattern
  done < "$ROOT/dev/bundle/exclude.txt"
)
step "libraries"
in_builder bash /bundle/collect-libs.sh "/stage/$name/chrome" /bundle/host-libs.txt || die "collecting the libraries failed"
# Chromium reads keyboard layouts from /usr/share/X11/xkb and nowhere else (its
# xkb engine sets that path), and the bundled libinput its device quirks from
# /usr/share/libinput. NixOS has neither: copies, which the installer links
# there on such a host.
step "keyboard layouts and input quirks"
in_builder sh -c "cp -r /usr/share/X11/xkb '/stage/$name/chrome/xkb' && cp -r /usr/share/libinput '/stage/$name/chrome/libinput' &&
  cp /usr/share/doc/xkb-data/copyright '/stage/$name/chrome/lib/licenses/xkb-data.copyright' &&
  cp /usr/share/doc/libinput-bin/copyright '/stage/$name/chrome/lib/licenses/libinput-bin.copyright'" ||
  die "copying the keyboard layouts and input quirks failed"

# --- Node --------------------------------------------------------------------
step "node $NODE_VERSION"
node_tar=$WORK/cache/node-v$NODE_VERSION-linux-x64.tar.xz
if ! echo "$NODE_SHA256  $node_tar" | sha256sum -c --quiet 2> /dev/null; then
  curl -fsSL --retry 3 -o "$node_tar.part" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz"
  echo "$NODE_SHA256  $node_tar.part" | sha256sum -c --quiet || die "node-v$NODE_VERSION's checksum doesn't match bundle/node.txt"
  mv "$node_tar.part" "$node_tar"
fi
node_dir=$WORK/cache/node-v$NODE_VERSION-linux-x64
[[ -x $node_dir/bin/node ]] || tar -C "$WORK/cache" -xJf "$node_tar"
mkdir -p "$stage/node/bin"
cp "$node_dir/bin/node" "$stage/node/bin/"
cp "$node_dir/LICENSE" "$stage/node/"

# --- This checkout -----------------------------------------------------------
step "the CLI, helper and shells (this checkout at ${commit:0:12}${dirty:+, with uncommitted changes})"
# The files as they are (untracked ones too, for --allow-dirty), less what a
# shell's manifest excludes: its source (Hydra's T3 Code patches).
shell_field() { node -e 'const v = require(process.argv[1])[process.argv[2]]; if (v) console.log([].concat(v).join("\n"))' "$1" "$2"; }
excluded=()
for manifest in "$ROOT"/shells/*/shell.json; do
  dir=${manifest%/shell.json}
  while read -r path; do [[ -n $path ]] && excluded+=(":!:shells/${dir##*/}/$path"); done < <(shell_field "$manifest" exclude)
done
(cd "$ROOT" && git ls-files -z --cached --others --exclude-standard -- bin lib helper shells skill LICENSE ':!:helper/test' ':!:*/README.md' "${excluded[@]}" |
  while IFS= read -r -d '' f; do [[ -e $f ]] && printf '%s\0' "$f"; done | tar --null -T - -cf -) | tar -C "$stage" -xf -
# Each shell's files, as their git tree: what an install's copy says it was
# shipped from (plutonium shells, "shipped: <name> <version> (<tree>)").
shell_trees=$(
  index=$(mktemp)
  trap 'rm -f "$index"' EXIT
  for dir in "$stage"/shells/*/; do
    dir=${dir%/}
    rm -f "$index"
    (cd "$dir" && GIT_INDEX_FILE=$index GIT_DIR=$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir) GIT_WORK_TREE=$dir git add -A .)
    echo "${dir##*/}@$(GIT_INDEX_FILE=$index GIT_DIR=$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir) git write-tree | cut -c1-7)"
  done | paste -sd' '
)
# The host's npm: the dependencies are plain JavaScript (the bundled node
# needn't run here, on NixOS it can't; bundle check runs it).
(cd "$stage/helper" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
cp "$stage/helper/package-lock.json" "$stage/helper/node_modules/.plutonium-lock"

# --- The shells' builds ------------------------------------------------------
# What a shell's manifest "bundle" builds, in shells/<name>/build: Hydra's
# server. Its BUILD file says what it was made from.
shell_builds_info=
if [[ -n $shell_builds ]]; then
  for manifest in "$ROOT"/shells/*/shell.json; do
    dir=${manifest%/shell.json} name_=${dir##*/}
    mapfile -t argv < <(shell_field "$manifest" bundle)
    [[ ${#argv[@]} -gt 0 ]] || continue
    step "the $name_ shell's build"
    argv=("${argv[@]//\{out\}/$stage/shells/$name_/build}")
    (cd "$dir" && PLUTONIUM=$ROOT "$dir/${argv[0]}" "${argv[@]:1}") || die "the $name_ shell's build failed"
    [[ -f $stage/shells/$name_/build/BUILD ]] && shell_builds_info+=$(cat "$stage/shells/$name_/build/BUILD")$'\n'
  done
fi

# --- The manifest, and the tarball -------------------------------------------
step "manifest"
glibc=$(in_builder sh -c "find /stage/$name -type f \( -perm -u+x -o -name '*.so*' -o -name '*.node' \) -exec sh -c 'file -b \"\$1\" | grep -q ^ELF && objdump -T \"\$1\"' sh {} \; 2>/dev/null |
  grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1")
cat > "$stage/BUNDLE" <<EOF
VERSION=$version
COMMIT=$commit
DIRTY=${dirty:-0}
CHROMIUM_BUILD="$chromium_build"
SHELLS="$shell_trees"
${shell_builds_info}NODE_VERSION=$NODE_VERSION
GLIBC_MIN=${glibc#GLIBC_}
BUILT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
cat "$stage/BUNDLE"

step "packing"
tarball=$out/$name.tar.xz
# Files, not hard links; the same owner and order every time. The setuid bit
# of chrome-sandbox can't survive a user's tar: the installer sets it.
tar -C "$WORK/stage" --hard-dereference --owner=0 --group=0 --numeric-owner --sort=name \
  --mtime="@$(git -C "$ROOT" log -1 --format=%ct)" -cf - "$name" |
  xz -9 -T0 --memlimit-compress=25% > "$tarball.part"
# One build (2026-10-31) wrote an empty tarball and still succeeded.
[[ -s $tarball.part ]] && xz -tq "$tarball.part" || die "packing failed: $tarball.part is empty or corrupt"
mv "$tarball.part" "$tarball"
(cd "$out" && sha256sum "$name.tar.xz" > "$name.tar.xz.sha256")
echo "$tarball: $(du -h "$tarball" | cut -f1) ($(du -sh "$stage" | cut -f1) unpacked)"
du -sh "$stage"/* | sort -h | sed 's/^/  /'
