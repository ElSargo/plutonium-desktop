#!/bin/sh
# Screenshot the panel straight from KMS: whatever the primary plane scans out
# (other planes, such as a fullscreen video's, are left out). Needs sudo
# (kmsgrab needs CAP_SYS_ADMIN) and an ffmpeg with kmsgrab and VA-API: the
# framebuffer is tiled/compressed, so VA-API untiles it.
# Usage: kmsshot.sh <out.png> [card]     FF=<ffmpeg> picks the binary.
exec sudo -n "${FF:-$(command -v ffmpeg)}" -loglevel error -y -device "/dev/dri/${2:-card1}" -f kmsgrab -i - \
  -vf 'hwmap=derive_device=vaapi,scale_vaapi=format=nv12,hwdownload,format=nv12' \
  -frames:v 1 -update 1 "$1"
