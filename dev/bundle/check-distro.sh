#!/bin/sh
# In a clean container of one distribution (dev/bundle/check.sh): install only the
# libraries a desktop has (bundle/host-libs.txt's) and the tools the installer
# asks for, install the bundle in $1 with dev/bundle/install.sh (at /install.sh),
# check that every binary in it finds its libraries and starts, run a session
# from it as a user, and uninstall it.
set -eu
tarball=$1
log() { echo "[$(. /etc/os-release; echo "$ID-$VERSION_ID")] $*"; }

# The libraries, and Xvfb with Mesa's software renderer and a font to start
# Ash on (with no font at all, Ash's text shaping stops it). No Vulkan driver:
# a session draws with GL then. The installer's tools: python3, git, curl,
# pgrep; and useradd and su for the session's user.
# Quietly: the package manager's output only if it fails.
exec 3>&1
quiet() { "$@" > /tmp/packages.log 2>&1 || { cat /tmp/packages.log >&3; exit 1; }; }
if command -v apt-get > /dev/null; then
  quiet apt-get update
  # Ubuntu 24.04 renamed libasound2 for its 64-bit time_t transition.
  asound=libasound2; apt-cache show libasound2t64 > /dev/null 2>&1 && asound=libasound2t64
  DEBIAN_FRONTEND=noninteractive quiet apt-get install -y --no-install-recommends \
    libgbm1 libegl1 libgl1 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 libxext6 \
    libxfixes3 libxrandr2 libglib2.0-0 $asound libudev1 libdbus-1-3 libexpat1 xz-utils \
    xvfb libgl1-mesa-dri xkb-data fontconfig-config fonts-dejavu-core python3 git curl procps
elif command -v dnf > /dev/null; then
  quiet dnf install -y mesa-libgbm mesa-libEGL libX11 libX11-xcb libxcb libXcomposite libXdamage libXext \
    libXfixes libXrandr glib2 alsa-lib systemd-libs dbus-libs expat xz \
    xorg-x11-server-Xvfb mesa-dri-drivers xkeyboard-config fontconfig dejavu-sans-fonts \
    python3 git-core curl procps-ng shadow-utils util-linux
elif command -v pacman > /dev/null; then
  quiet pacman -Sy --noconfirm --needed mesa libx11 libxcb libxcomposite libxdamage libxext libxfixes libxrandr \
    glib2 alsa-lib systemd-libs dbus expat xz xorg-server-xvfb xkeyboard-config fontconfig ttf-dejavu \
    python git curl procps-ng shadow util-linux
elif command -v zypper > /dev/null; then
  quiet zypper -n in libgbm1 Mesa-libEGL1 libX11-6 libX11-xcb1 libxcb1 libXcomposite1 libXdamage1 libXext6 \
    libXfixes3 libXrandr2 libglib-2_0-0 libgobject-2_0-0 libgio-2_0-0 libasound2 libudev1 libdbus-1-3 libexpat1 xz findutils \
    xorg-x11-server-Xvfb Mesa-dri xkeyboard-config fontconfig dejavu-fonts \
    python3 git-core curl procps shadow util-linux
else
  log "no package manager I know"; exit 1
fi
log "glibc $(ldd --version | head -1 | grep -o '[0-9.]*$')"

# The installer looks for a running systemd, which a container hasn't.
mkdir -p /run/systemd/system
fail=0
if out=$(sh /install.sh --from "$tarball" 2>&1); then log "ok: installed: $(echo "$out" | grep '^Plutonium .*: ')"
else log "FAIL: install.sh:"; echo "$out" | tail -5 | sed 's/^/  /'; exit 1; fi
root=/opt/plutonium
. "$root/BUNDLE"
[ -n "${GLIBC_MIN:-}" ] && log "the bundle needs glibc $GLIBC_MIN"
if [ "$(stat -c %u:%a "$root/chrome/chrome-sandbox")" = 0:4755 ] && [ "$(readlink /usr/local/bin/plutonium)" = "$root/bin/plutonium" ] &&
   grep -q "^Exec=$root/bin/plutonium session start" /usr/share/wayland-sessions/plutonium.desktop; then
  log "ok: chrome-sandbox setuid root, /usr/local/bin/plutonium, the login screen entry"
else log "FAIL: the install is incomplete:"; ls -l "$root/chrome/chrome-sandbox" /usr/local/bin/plutonium /usr/share/wayland-sessions/plutonium.desktop; fail=1; fi

# Every ELF file: anything ldd can't find is a library the bundle should
# carry, or one host-libs.txt says the host has and this one hasn't.
find "$root" -type f \( -perm -u+x -o -name '*.so*' -o -name '*.node' \) > /tmp/files
: > /tmp/missing
elves=0
while read -r f; do
  [ "$(head -c 4 "$f" | od -An -c | tr -d ' ')" = 177ELF ] || continue
  elves=$((elves + 1))
  ldd "$f" 2>&1 | sed -n "s|^\s*\(.*\) => not found|${f#$root/}: \1|p" >> /tmp/missing
  ldd "$f" 2>&1 | sed -n "s|^.*version \`\(.*\)' not found.*|${f#$root/}: needs \1|p" >> /tmp/missing
done < /tmp/files
if [ "$elves" -eq 0 ]; then log "FAIL: found no binaries to check"; fail=1
elif [ -s /tmp/missing ]; then log "FAIL: missing libraries:"; sed 's/^/  /' /tmp/missing; fail=1
else log "ok: all $elves binaries find their libraries"; fi

check() {   # <what> <command…>
  what=$1; shift
  if out=$("$@" 2>&1); then log "ok: $what: $(echo "$out" | head -1)"
  else log "FAIL: $what:"; echo "$out" | tail -5 | sed 's/^/  /'; fail=1; fi
}
check chrome "$root/chrome/chrome" --no-sandbox --version
check node "$root/node/bin/node" --version
# Loads the helper's whole module graph, then prints its usage.
check helper sh -c "'$root/node/bin/node' '$root/helper/plutonium.ts' 2>&1 | grep -m1 '^usage:'"
[ -f "$root/shells/hydra/build/bin.mjs" ] && check "Hydra's T3 Code, through its own command" plutonium hydra --version

# Ash itself, on Xvfb, as a session starts it: its DevTools answer, and Exo's
# Wayland socket is there. (Root in a container: no sandbox.)
ash() {
  export XDG_RUNTIME_DIR=/tmp/runtime DISPLAY=:5
  mkdir -m 700 -p "$XDG_RUNTIME_DIR"
  Xvfb :5 -screen 0 1280x800x24 > /tmp/xvfb.log 2>&1 &
  sleep 2
  "$root/chrome/chrome" --no-sandbox --enable-wayland-server --wayland-server-socket=wayland-check \
    --remote-debugging-port=9333 --user-data-dir=/tmp/profile --ash-host-window-bounds=0+0-1280x800 \
    --disable-sync --enable-logging=stderr > /tmp/ash.log 2>&1 &
  for _ in $(seq 1 60); do
    version=$("$root/node/bin/node" -e 'fetch("http://127.0.0.1:9333/json/version").then(r => r.json()).then(v => console.log(v.Browser))' 2> /dev/null) && break
    sleep 1
  done
  if [ -n "${version:-}" ] && [ -S "$XDG_RUNTIME_DIR/wayland-check" ]; then echo "$version, with a Wayland socket"
  else tail -15 /tmp/ash.log; return 1; fi
}
check "Ash on Xvfb" ash
pkill -f "$root/chrome/chrome" 2> /dev/null; pkill Xvfb 2> /dev/null; sleep 1

# A session, as a user would start one: plutonium run, from the install, with
# Hydra and the plain shell; their pages open in Ash. The user's copy of Hydra
# is its manifest and command, without its source or build.
session() {
  useradd -m pluto > /dev/null 2>&1 || true
  uid=$(id -u pluto)
  mkdir -p "/run/user/$uid" && chown pluto "/run/user/$uid" && chmod 700 "/run/user/$uid"
  su pluto -c "XDG_RUNTIME_DIR=/run/user/$uid timeout 240 plutonium run --x11 hydra plain" > /tmp/run.log 2>&1 || { tail -8 /tmp/run.log; return 1; }
  pages=$(su pluto -c "curl -s localhost:9223/json/list" | grep -o '"url": *"http://[^"]*' | sed 's/.*"//')
  su pluto -c "XDG_RUNTIME_DIR=/run/user/$uid plutonium stop" > /dev/null 2>&1
  echo "$pages" | grep -q '^http://127.0.0.1:3773/' && echo "$pages" | grep -q '^http://plain.localhost:' ||
    { echo "the shells' pages aren't open: $pages"; tail -5 /tmp/run.log; return 1; }
  copy=$(su pluto -c "git -C ~/.pluto/shells/hydra ls-files" | paste -sd' ')
  [ "$copy" = "bin/hydra bin/supervise lib/env.sh shell.json" ] || { echo "the user's copy of Hydra has: $copy"; return 1; }
  echo "Hydra and the plain shell open ($(grep -c . /tmp/run.log) lines from plutonium run); the user's Hydra: $copy"
}
check "a session (plutonium run --x11 hydra plain)" session

if out=$(sh /install.sh --uninstall 2>&1) && [ ! -e "$root" ] && [ ! -e /usr/local/bin/plutonium ] &&
   [ ! -e /usr/share/wayland-sessions/plutonium.desktop ]; then log "ok: uninstalled"
else log "FAIL: install.sh --uninstall:"; echo "$out" | tail -3 | sed 's/^/  /'; fail=1; fi
exit $fail
