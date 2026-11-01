#!/usr/bin/env bash
# plutonium bundle check [tarball] [image…]: install a release bundle (default:
# the newest in dist/) in clean containers of the distributions it's for
# (dev/bundle/check-distro.sh), and say what fails where.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/common.sh"

tarball=${1:-$(ls -t "$ROOT"/dist/plutonium-*.tar.xz 2> /dev/null | head -1)}
[[ -f $tarball ]] || die "no bundle to check (plutonium bundle build)"
tarball=$(realpath "$tarball")
shift || true
images=("$@")
[[ ${#images[@]} -gt 0 ]] || images=(
  docker.io/library/ubuntu:22.04 docker.io/library/ubuntu:24.04 docker.io/library/debian:12
  registry.fedoraproject.org/fedora:latest docker.io/library/archlinux:latest
  registry.opensuse.org/opensuse/tumbleweed:latest
)
echo "checking $tarball"
failed=()
for image in "${images[@]}"; do
  sha=()
  [[ -f $tarball.sha256 ]] && sha=(-v "$tarball.sha256:/bundle.tar.xz.sha256:ro")
  pm run --rm --security-opt label=disable -v "$tarball:/bundle.tar.xz:ro" "${sha[@]}" \
    -v "$ROOT/dev/bundle/install.sh:/install.sh:ro" \
    -v "$ROOT/dev/bundle/check-distro.sh:/check-distro.sh:ro" "$image" sh /check-distro.sh /bundle.tar.xz ||
    failed+=("$image")
done
if [[ ${#failed[@]} -gt 0 ]]; then echo "FAILED on: ${failed[*]}"; exit 1; fi
echo "the bundle works on every distribution checked"
