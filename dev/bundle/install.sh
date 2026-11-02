#!/bin/sh
# Plutonium's installer: puts a release (dev/bundle/build.sh's tarball) in
# /opt/plutonium, makes its chrome-sandbox setuid root, links `plutonium` into
# /usr/local/bin and adds Plutonium to the login screen. On NixOS, the rest is
# a module in the release (lib/nixos.nix) for the system's configuration.
#
#   curl -fsSL <the site>/install.sh | sh
#   sh install.sh [--from <url or file>] [--no-session] [--uninstall]
#
# --from (or PLUTONIUM_FROM): the tarball, a URL (https://, file://) or a path;
# default: the latest release. A download is checked against <url>.sha256; a
# local file is too, if it has one beside it. It runs as you, and uses sudo for
# what goes outside your home. An install over an older one replaces it, once
# its sessions have stopped. Your data (~/.pluto, ~/.local/share/plutonium,
# ~/.config/plutonium) is never touched, not by --uninstall either.
#
# POSIX sh: `curl | sh` runs it with whatever sh is (dash on Debian and Ubuntu).
set -eu

RELEASE_URL=https://github.com/ElSargo/pluto/releases/latest/download/plutonium-x86_64.tar.xz
DEST=/opt/plutonium
LINK=/usr/local/bin/plutonium
ENTRY=/usr/share/wayland-sessions/plutonium.desktop
APPARMOR=/etc/apparmor.d/plutonium
# Data the release reads from these paths, and its own copies of it.
HOST_DATA="/usr/share/X11/xkb:xkb /usr/share/libinput:libinput"

say() { printf '%s\n' "$*"; }
die() { printf 'plutonium install: %s\n' "$*" >&2; exit 1; }

from=${PLUTONIUM_FROM:-} session=1 uninstall=
while [ $# -gt 0 ]; do
  case $1 in
    --from) [ $# -ge 2 ] || die "--from needs a URL or a file"; from=$2; shift ;;
    --from=*) from=${1#--from=} ;;
    --no-session) session= ;;
    --uninstall) uninstall=1 ;;
    -h|--help) sed -n '2,15p' "$0" 2> /dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1 (--from, --no-session, --uninstall)" ;;
  esac
  shift
done

if [ "$(id -u)" = 0 ]; then as_root() { "$@"; }
else
  command -v sudo > /dev/null || die "this needs sudo (or run it as root)"
  as_root() { sudo "$@"; }
fi

# The distribution family, for the commands that fix what's missing.
family=
if [ -f /etc/os-release ]; then
  family=$(. /etc/os-release; echo " ${ID:-} ${ID_LIKE:-} ")
  case $family in
    *" nixos "*) family=nixos ;;
    *" fedora "*|*" rhel "*|*" centos "*) family=fedora ;;
    *" debian "*|*" ubuntu "*) family=debian ;;
    *" arch "*) family=arch ;;
    *" suse "*|*" opensuse "*) family=suse ;;
    *) family= ;;
  esac
fi
install_hint() {   # <package>...
  case $family in
    fedora) echo "sudo dnf install $*" ;;
    debian) echo "sudo apt install $*" ;;
    arch) echo "sudo pacman -S $*" ;;
    suse) echo "sudo zypper install $*" ;;
    nixos) echo "add to environment.systemPackages in configuration.nix: $*" ;;
    *) echo "install $* with your package manager" ;;
  esac
}
# The packages that have these libraries (sonames, like libXfixes.so.3), by the
# usual naming: Debian's lib<name><version> (libxfixes3), openSUSE's the same
# with its case kept, Arch's the bare name; Fedora's dnf takes the soname.
lib_packages() {   # <soname>...
  for lib in "$@"; do
    base=${lib%%.so*} major=${lib##*.so.}
    case $family in
      debian)
        case $base in
          libasound) echo libasound2t64 ;;
          libdbus-1) echo libdbus-1-3 ;;
          lib*-2.0) echo libglib2.0-0t64 ;;
          *) echo "$base$major" | tr '[:upper:]' '[:lower:]' ;;
        esac ;;
      suse) echo "$base$major" ;;
      arch) echo "${base#lib}" | tr '[:upper:]' '[:lower:]' | sed 's/^/lib/' ;;
      fedora) echo "'$lib()(64bit)'" ;;
      *) echo "$lib" ;;
    esac
  done | sort -u | tr '\n' ' '
}

# A running session from the install: replacing its files under it breaks it.
running() {
  pgrep -f "^$DEST/chrome/chrome " > /dev/null 2>&1 || pgrep -f "$DEST/helper/plutonium.ts daemon" > /dev/null 2>&1
}

# --- Uninstall ---------------------------------------------------------------
if [ -n "$uninstall" ]; then
  [ -f "$DEST/BUNDLE" ] || die "no Plutonium release in $DEST"
  running && die "a Plutonium session is running from $DEST: stop it first (plutonium stop)"
  [ "$(readlink "$LINK" 2> /dev/null)" = "$DEST/bin/plutonium" ] && as_root rm -f "$LINK"
  grep -qs "$DEST/bin/plutonium" "$ENTRY" && as_root rm -f "$ENTRY"
  for pair in $HOST_DATA; do
    [ "$(readlink "${pair%:*}" 2> /dev/null)" = "$DEST/chrome/${pair#*:}" ] && as_root rm -f "${pair%:*}"
  done
  if [ -f "$APPARMOR" ]; then
    as_root apparmor_parser -R "$APPARMOR" > /dev/null 2>&1 || true
    as_root rm -f "$APPARMOR"
  fi
  as_root rm -rf "$DEST"
  [ "$family" = nixos ] && say "On NixOS, also take plutonium.nix out of your configuration's imports, and rebuild."
  say "Plutonium is uninstalled. Your data is still in ~/.pluto, ~/.local/share/plutonium and ~/.config/plutonium."
  exit 0
fi

# --- What this machine needs -------------------------------------------------
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || die "Plutonium is for x86-64 Linux (this is $(uname -s) $(uname -m))"
[ -d /run/systemd/system ] || die "Plutonium needs systemd (logind hands it the display and input devices)"
# NixOS runs the release once the system has its module (lib/nixos.nix): its
# `plutonium`, and nix-ld's loader. Until then, the release is put in place,
# and the module's what's left.
nixos_ready=
if [ "$family" = nixos ] && [ "$(readlink /run/current-system/sw/bin/plutonium 2> /dev/null)" ] &&
   readlink -f /lib64/ld-linux-x86-64.so.2 2> /dev/null | grep -q nix-ld; then
  nixos_ready=1
fi
# What the release runs with from the host: the print portal and terminals
# are Python, installed shells are git repositories. (NixOS's module brings them.)
tools="tar xz python3 git curl pgrep"
[ "$family" = nixos ] && [ -z "$nixos_ready" ] && tools="tar xz"
missing=
for tool in $tools; do
  command -v "$tool" > /dev/null || missing="$missing $tool"
done
if [ -n "$missing" ]; then
  pkgs=
  for tool in $missing; do
    case $family:$tool in
      fedora:pgrep|arch:pgrep) pkgs="$pkgs procps-ng" ;;
      *:pgrep) pkgs="$pkgs procps" ;;
      debian:xz) pkgs="$pkgs xz-utils" ;;
      arch:python3) pkgs="$pkgs python" ;;
      *) pkgs="$pkgs $tool" ;;
    esac
  done
  # shellcheck disable=SC2086 # one package per word
  die "missing:$missing. Install them first: $(install_hint $pkgs)"
fi
if [ -e "$DEST" ] && [ ! -f "$DEST/BUNDLE" ]; then
  die "$DEST is there, and isn't a Plutonium release: move it out of the way first"
fi
running && die "a Plutonium session is running from $DEST: stop it first (plutonium stop), then install again"

# --- The tarball -------------------------------------------------------------
tmp=$(mktemp -d)
new=$DEST.new
trap 'rm -rf "$tmp"; [ -d "$new" ] && as_root rm -rf "$new"' EXIT
tarball=$tmp/plutonium.tar.xz
fetch() {   # <url> <file>
  if command -v curl > /dev/null; then curl -fL --retry 3 --progress-bar -o "$2" "$1"
  else wget -q --show-progress -O "$2" "$1"; fi
}
from=${from:-$RELEASE_URL}
case $from in
  https://*|http://*)
    say "downloading $from"
    fetch "$from" "$tarball" || die "couldn't download $from"
    fetch "$from.sha256" "$tmp/sha256" 2> /dev/null || die "couldn't download its checksum ($from.sha256)" ;;
  *)
    file=${from#file://}
    [ -f "$file" ] || die "no tarball at $file"
    cp "$file" "$tarball"
    if [ -f "$file.sha256" ]; then cp "$file.sha256" "$tmp/sha256"
    else say "note: no $file.sha256 beside it; not checking its checksum"; fi ;;
esac
if [ -f "$tmp/sha256" ]; then
  want=$(cut -d' ' -f1 < "$tmp/sha256")
  have=$(sha256sum "$tarball" | cut -d' ' -f1)
  [ "$want" = "$have" ] || die "the tarball's checksum doesn't match ($have, not $want): download it again"
fi

say "unpacking into $DEST"
as_root rm -rf "$new"
as_root mkdir -p "$new"
as_root tar -C "$new" --strip-components=1 --no-same-permissions -xJf "$tarball" || die "couldn't unpack the tarball"
[ -f "$new/BUNDLE" ] || die "that tarball isn't a Plutonium release (no BUNDLE in it)"
version=$(sed -n 's/^VERSION=//p' "$new/BUNDLE")
glibc_min=$(sed -n 's/^GLIBC_MIN=//p' "$new/BUNDLE")
glibc=$(getconf GNU_LIBC_VERSION 2> /dev/null | cut -d' ' -f2)
if [ -n "$glibc_min" ] && [ -n "$glibc" ] &&
   [ "$(printf '%s\n%s\n' "$glibc_min" "$glibc" | sort -V | head -1)" != "$glibc_min" ]; then
  die "Plutonium $version needs glibc $glibc_min or newer; this system has $glibc"
fi

# Its binaries start here: anything a library short shows up now, not at login.
# (Not on NixOS before its module: they can't start there yet.)
if [ "$family" != nixos ] || [ -n "$nixos_ready" ]; then
  if ! out=$("$new/node/bin/node" --version 2>&1); then
    die "the release's node doesn't start here: $out"
  fi
  if ! out=$("$new/chrome/chrome" --no-sandbox --version 2>&1); then
    libs=$(ldd "$new/chrome/chrome" 2> /dev/null | sed -n 's/^\s*\(.*\) => not found/\1/p' | sort -u | tr '\n' ' ')
    # shellcheck disable=SC2086 # one library per word
    [ -n "$libs" ] && die "chrome needs libraries this system lacks: $libs(a desktop has them: Mesa, X11, GLib, ALSA). Install them: $(install_hint $(lib_packages $libs))"
    die "chrome doesn't start here: $out"
  fi
  say "Plutonium $version: ${out% }, node $("$new/node/bin/node" --version)"
fi

# Chromium's sandbox: its helper has to be setuid root (a tarball can't keep
# that), and where AppArmor keeps unprivileged user namespaces from apps
# (Ubuntu 23.10 and later), chrome needs a profile that allows them.
as_root chown root:root "$new/chrome/chrome-sandbox"
as_root chmod 4755 "$new/chrome/chrome-sandbox"
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2> /dev/null)" = 1 ] && command -v apparmor_parser > /dev/null; then
  cat > "$tmp/apparmor" << EOF
# Plutonium's chrome (written by Plutonium's install.sh): user namespaces, for its sandbox.
abi <abi/4.0>,
include <tunables/global>

profile plutonium $DEST/chrome/chrome flags=(unconfined) {
  userns,

  include if exists <local/plutonium>
}
EOF
  as_root install -m644 "$tmp/apparmor" "$APPARMOR"
  as_root apparmor_parser -r "$APPARMOR" || say "warning: couldn't load $APPARMOR; chrome falls back to its setuid sandbox"
fi

# In place of the old one, in one move each.
if [ -d "$DEST" ]; then
  say "replacing Plutonium $(sed -n 's/^VERSION=//p' "$DEST/BUNDLE")"
  as_root rm -rf "$DEST.old"
  as_root mv "$DEST" "$DEST.old"
fi
as_root mv "$new" "$DEST"
as_root rm -rf "$DEST.old"

as_root mkdir -p "${LINK%/*}"
as_root ln -sfn "$DEST/bin/plutonium" "$LINK"

# Chromium reads keyboard layouts from /usr/share/X11/xkb only, and the
# release's libinput its device quirks from /usr/share/libinput. Every desktop
# distribution has both but NixOS; there, the release's copies (its module's
# links, on NixOS).
[ "$family" = nixos ] || for pair in $HOST_DATA; do
  path=${pair%:*} copy=$DEST/chrome/${pair#*:}
  if [ ! -e "$path" ] && [ -d "$copy" ]; then
    as_root mkdir -p "${path%/*}"
    as_root ln -s "$copy" "$path"
  fi
done

# The login screen: display managers read /usr/share/wayland-sessions (not on
# NixOS, whose display manager's sessions come from its configuration).
cmd=plutonium
command -v plutonium > /dev/null 2>&1 || cmd=$DEST/bin/plutonium
if [ -n "$session" ] && [ "$family" != nixos ]; then
  if [ "$(id -u)" = 0 ]; then HOME=$tmp "$DEST/bin/plutonium" session entry > "$tmp/entry"
  else "$DEST/bin/plutonium" session entry > "$tmp/entry"; fi
  as_root install -Dm644 "$tmp/entry" "$ENTRY"
  login="Log out, choose Plutonium on the login screen, and log in."
  # Display managers are display-manager.service; without one, logins are on
  # a text console.
  systemctl cat display-manager.service > /dev/null 2>&1 ||
    login="Log in on a text console (this system has no login screen) and run: $cmd run"
elif [ -z "$nixos_ready" ]; then
  module=$DEST/lib/nixos.nix
  say ""
  say "Plutonium $version is in $DEST. NixOS sets up the rest from its configuration:"
  say "  1. Copy $module beside your configuration.nix, as plutonium.nix"
  [ -f /etc/nixos/configuration.nix ] && say "     (sudo cp $module /etc/nixos/plutonium.nix)"
  say "  2. Add ./plutonium.nix to its imports"
  say "  3. sudo nixos-rebuild switch, then log out: the login screen lists Plutonium."
  say "It runs Plutonium's binaries (nix-ld), and adds the login screen's entry, the plutonium command, and the programs it uses (Python, git, foot, xwayland-satellite)."
  exit 0
elif [ -n "$session" ]; then
  login="Log out, choose Plutonium on the login screen, and log in."
else
  login="Start it from a text console: $cmd run"
fi
say ""
say "Plutonium $version is installed in $DEST."
say ""
say "$login"
say "Or try it in a window first: $cmd run --x11 :0 niri. $cmd doctor says what's missing."
