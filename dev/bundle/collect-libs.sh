#!/bin/bash
# In the bundle builder (bundle/Containerfile): strip the release build in
# $1 (a chrome/ directory), copy the libraries it needs that the host doesn't
# provide (bundle/host-libs.txt) into $1/lib, and point every binary at them
# with RUNPATH, so nothing needs LD_LIBRARY_PATH (which would leak into every
# app Plutonium starts).
set -euo pipefail
chrome=$1 hostlibs=$2
lib=$chrome/lib
cd "$chrome"

# The release build's own ELF files (chrome, the crashpad handler, ANGLE,
# SwiftShader, the Vulkan loader).
elves=()
for f in *; do
  [[ -f $f && ! -L $f ]] && file -b "$f" | grep -q '^ELF' && elves+=("$f")
done
strip --strip-unneeded "${elves[@]}"

host_regex="^($(grep -v -E '^\s*(#|$)' "$hostlibs" | paste -sd'|'))$"
is_host() { [[ $1 =~ $host_regex ]]; }

rm -rf "$lib"
mkdir -p "$lib/nss" "$lib/licenses"
declare -A copied=()
# Copies what $1 links (its NEEDED entries) that isn't the host's, and what
# those link in turn. Not what the host's libraries need: those come with
# them (libudev's libcap is the host's business).
collect() {
  local soname path
  declare -A where=()
  while read -r soname path; do where[$soname]=$path; done < <(ldd "$1" | awk '$2 == "=>" { print $1, $3 }')
  for soname in $(readelf -d "$1" | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p'); do
    is_host "$soname" && continue
    [[ -n ${copied[$soname]:-} ]] && continue
    path=${where[$soname]:-}
    [[ $path == /* ]] || { echo "collect-libs: $1 needs $soname, which nothing provides" >&2; exit 1; }
    cp -L "$path" "$lib/$soname"
    copied[$soname]=$path
    collect "$lib/$soname"
  done
}
for f in "${elves[@]}"; do collect "$f"; done

# dlopen()ed, so ldd can't see them. NSS loads its crypto module and the root
# certificates from nss/ beside libnss3 (Debian's layout).
for f in libsoftokn3.so libfreeblpriv3.so libnssckbi.so; do
  cp -L "/usr/lib/x86_64-linux-gnu/nss/$f" "$lib/nss/$f"
  copied[nss/$f]=/usr/lib/x86_64-linux-gnu/nss/$f
  collect "$lib/nss/$f"
done

# chrome's binaries look in lib/ first (before the host's library path),
# the libraries beside each other.
for f in "${elves[@]}"; do
  old=$(patchelf --print-rpath "$f")
  patchelf --set-rpath "\$ORIGIN/lib${old:+:$old}" "$f"
done
for f in "$lib"/*.so* ; do patchelf --set-rpath '$ORIGIN' "$f"; done
for f in "$lib"/nss/*.so; do patchelf --set-rpath '$ORIGIN:$ORIGIN/..' "$f"; done
strip --strip-unneeded "$lib"/*.so* "$lib"/nss/*.so

# What came from where, and each package's license (redistributing needs it).
{
  echo "# Libraries in chrome/lib, from Ubuntu 22.04 (bundle/Containerfile)"
  for soname in $(printf '%s\n' "${!copied[@]}" | sort); do
    # dpkg knows each file by the path its package has it at: /lib or /usr/lib
    # (usrmerge), the link or what it points to.
    real=$(readlink -f "${copied[$soname]}") pkg=
    for p in "${copied[$soname]}" "$real" "${real#/usr}" "/usr${copied[$soname]}"; do
      pkg=$(dpkg -S "$p" 2>/dev/null | head -1 | cut -d: -f1) && [[ -n $pkg ]] && break
    done
    [[ -n $pkg ]] || { echo "collect-libs: no package has ${copied[$soname]}" >&2; exit 1; }
    echo "$soname $pkg $(dpkg-query -W -f '${Version}' "$pkg")"
    cp "/usr/share/doc/$pkg/copyright" "$lib/licenses/$pkg.copyright"
  done
} > "$lib/BUNDLED.txt"

# Every bundled soname must now resolve into lib/, for every binary.
bad=0
for f in "${elves[@]}" "$lib"/*.so* "$lib"/nss/*.so; do
  while read -r soname path; do
    if [[ -e $lib/$soname || -e $lib/nss/$soname ]] && [[ $(readlink -f "$path") != "$(readlink -f "$lib")"/* ]]; then
      echo "collect-libs: $f loads $soname from $path, not lib/" >&2; bad=1
    fi
  done < <(ldd "$f" | awk '$2 == "=>" { print $1, $3 }')
done
(( bad == 0 ))
echo "collect-libs: ${#copied[@]} libraries in lib/ ($(du -sh "$lib" | cut -f1))"
