# Hydra's settings, on top of Plutonium's lib/common.sh (which reads
# plutonium.env, where these can be set). bin/hydra sources it, and so do
# tools that drive Hydra (tools/agent-tests).

HYDRA=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)   # this shell's folder
# A checkout's Hydra source: T3 Code's BASE and the patches, and by default
# its T3 Code checkout (hydra fetch).
HYDRA_SRC=$ROOT/shells/hydra/src
T3CODE_DIR=${T3CODE_DIR:-$HYDRA_SRC/checkout}
T3_HOME=${T3_HOME:-${T3CODE_HOME:-$HOME/.t3}}          # T3 Code's data: the host's own
T3_PORT=${T3_PORT:-$(slot_port 3773)}
# T3_TAILSCALE=1: Tailscale Serve publishes the server over HTTPS on the tailnet,
# on 443 (slot N: 8443 + 100 x N).
(( SLOT )) && T3_TAILSCALE_PORT=${T3_TAILSCALE_PORT:-$(slot_port 8443)}
T3_TAILSCALE_PORT=${T3_TAILSCALE_PORT:-443}

# The server: a release install's build (hydra bundle, beside the shipped
# shell), with what T3's source would say about it in hydra.env; else the
# checkout's source.
HYDRA_BUILD=$ROOT/shells/hydra/build
if [[ -f $HYDRA_BUILD/bin.mjs ]]; then
  T3_SERVER=$HYDRA_BUILD/bin.mjs T3_SERVER_DIR=$HYDRA_BUILD
  . "$HYDRA_BUILD/hydra.env"
else
  HYDRA_BUILD=
  T3_SERVER=$T3CODE_DIR/apps/server/src/bin.ts T3_SERVER_DIR=$T3CODE_DIR
fi
