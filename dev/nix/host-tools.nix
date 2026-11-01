# What the container has besides chrome, for sessions with HOST=1: Xvfb for
# private X11 sessions (run --x11 with no display), Python with websockets for
# tools/cdp.py. `plutonium host build` builds it; on_ash puts it on PATH.
{ buildEnv, xvfb, python3 }:

buildEnv {
  name = "plutonium-host-tools";
  paths = [ xvfb (python3.withPackages (ps: [ ps.websockets ])) ];
}
