#!/usr/bin/env bash
# plutonium bundle publish: puts a release bundle (build.sh's tarball) on
# GitHub as a release, under the names dev/bundle/install.sh downloads:
#
#   plutonium-x86_64.tar.xz(.sha256)            the fixed name (install.sh's RELEASE_URL)
#   plutonium-<version>-x86_64.tar.xz(.sha256)  the same file, by version
#   install.sh                                  the installer, as of the bundle's commit
#
# The bundle has to be a release: made from a clean tree (BUNDLE's DIRTY=0)
# at a tag, v<version>, that names its commit. Its notes are
# docs/releases/v<version>.md, as of that commit.
#
#   dev/bundle/publish.sh [options] dist/plutonium-<version>-x86_64.tar.xz
#
# Options:
#   --repo <owner/name>  where to publish (default: gh's for this checkout)
#   --draft              a draft release, to look at before publishing it
#   --prerelease         marked as a pre-release
#   --dry-run            check and stage the files (dist/publish/<version>/),
#                        and print the gh command instead of running it
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/common.sh"

repo= draft= prerelease= dry_run= tarball=
while [[ $# -gt 0 ]]; do
  case $1 in
    --repo) repo=$2; shift ;;
    --draft) draft=1 ;;
    --prerelease) prerelease=1 ;;
    --dry-run) dry_run=1 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "bundle publish: unknown option $1" ;;
    *) [[ -z $tarball ]] || die "bundle publish: one tarball"; tarball=$1 ;;
  esac
  shift
done
[[ -n $tarball ]] || die "usage: plutonium bundle publish [--repo <owner/name>] [--draft] [--prerelease] [--dry-run] <tarball>"
[[ -f $tarball ]] || die "bundle publish: no $tarball"
name=$(basename "$tarball" .tar.xz)
[[ $name == plutonium-*-x86_64 ]] || die "bundle publish: $tarball isn't named plutonium-<version>-x86_64.tar.xz"

# What it was made from.
bundle=$(tar -xOJf "$tarball" "$name/BUNDLE") || die "bundle publish: $tarball has no $name/BUNDLE"
field() { sed -n "s/^$1=//p" <<< "$bundle" | head -1; }
version=$(field VERSION) commit=$(field COMMIT)
[[ $(field DIRTY) == 0 ]] || die "bundle publish: $name was built from uncommitted changes (DIRTY=1); build it again from a clean tree"
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] ||
  die "bundle publish: its version is '$version', not a release's (tag the commit v<x.y.z>, and build it again)"
tag=v$version
[[ $(git -C "$ROOT" rev-parse -q --verify "refs/tags/$tag^{commit}" || true) == "$commit" ]] ||
  die "bundle publish: tag $tag isn't the bundle's commit ${commit:0:12}"
[[ -n $(field CHROMIUM_FROM)$(field CHROMIUM_TAG) ]] || die "bundle publish: BUNDLE names no Chromium build"
tar -tJf "$tarball" "$name/chrome/LICENSES.chromium.html" > /dev/null 2>&1 ||
  die "bundle publish: $name has no chrome/LICENSES.chromium.html (Chromium's license notices; DEVELOPING.md, \"Publishing a release\")"
notes=$(git -C "$ROOT" show "$commit:docs/releases/$tag.md" 2> /dev/null) ||
  die "bundle publish: no docs/releases/$tag.md at $tag; write the release notes first"

# The files, as install.sh expects them: its checksum file's first field.
if [[ -f $tarball.sha256 ]]; then
  (cd "$(dirname "$tarball")" && sha256sum -c --quiet "$name.tar.xz.sha256") || die "bundle publish: $tarball doesn't match its .sha256"
fi
stage=$ROOT/dist/publish/$version
rm -rf "$stage" && mkdir -p "$stage"
cp "$tarball" "$stage/$name.tar.xz"
ln "$stage/$name.tar.xz" "$stage/plutonium-x86_64.tar.xz" 2> /dev/null || cp "$tarball" "$stage/plutonium-x86_64.tar.xz"
(cd "$stage" && for f in "$name.tar.xz" plutonium-x86_64.tar.xz; do sha256sum "$f" > "$f.sha256"; done)
git -C "$ROOT" show "$commit:dev/bundle/install.sh" > "$stage/install.sh"
printf '%s\n' "$notes" > "$stage/NOTES.md"
echo "$tag: $(field SHELLS); chrome from $(field CHROMIUM_TAG)$(field CHROMIUM_FROM); $(du -h "$stage/$name.tar.xz" | cut -f1)"
echo "staged in $stage"

args=(release create "$tag" --verify-tag --title "Plutonium $version" --notes-file "$stage/NOTES.md"
      ${repo:+--repo "$repo"} ${draft:+--draft} ${prerelease:+--prerelease}
      "$stage/plutonium-x86_64.tar.xz" "$stage/plutonium-x86_64.tar.xz.sha256"
      "$stage/$name.tar.xz" "$stage/$name.tar.xz.sha256" "$stage/install.sh")
if [[ -n $dry_run ]]; then
  printf 'would run: gh'; printf ' %q' "${args[@]}"; echo
  exit 0
fi
command -v gh > /dev/null || die "bundle publish: needs gh (GitHub's CLI), logged in (gh auth login)"
gh auth status > /dev/null 2>&1 || die "bundle publish: gh isn't logged in (gh auth login)"
# --verify-tag: the tag has to be on GitHub already (git push <remote> $tag).
gh "${args[@]}"
