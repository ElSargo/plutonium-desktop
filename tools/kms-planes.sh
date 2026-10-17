#!/usr/bin/env bash
# Which KMS planes scan out a framebuffer, sampled N times (default 10) every
# 0.25 s; identical samples are counted. Reads the kernel's atomic state, so it
# needs sudo. Usage: kms-planes.sh [N] [card]
n=${1:-10}
for _ in $(seq "$n"); do
  sudo -n cat "/sys/kernel/debug/dri/${2:-1}/state" | awk '
    /^plane\[/ {p=$2} /fb=[1-9]/ {on=1} /fb=0/ {on=0}
    on && /size=[0-9]+x/ {printf "%s %s ", p, $1}
    on && /format=/ {printf "%s ", $1}
    on && /modifier=/ {printf "%s; ", $1}'
  echo
  sleep 0.25
done | sort | uniq -c
