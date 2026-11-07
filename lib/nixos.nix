# Plutonium's release on NixOS: what the installer does elsewhere, and what
# NixOS only takes from its configuration. Copy it beside configuration.nix,
# add ./plutonium.nix to its imports, and rebuild (install.sh says so).
#
# The release in /opt/plutonium is generic Linux binaries: they need a loader
# at /lib64/ld-linux-x86-64.so.2 (nix-ld) with the libraries a desktop
# distribution has. Only those: the release carries the rest beside its
# binaries, and anything listed here would be found before its own copies.
{ pkgs, ... }:
let
  dest = "/opt/plutonium";
  session = (pkgs.writeTextDir "share/wayland-sessions/plutonium.desktop" ''
    [Desktop Entry]
    Name=Pluto
    Comment=A web-based desktop (from ${dest})
    Exec=${dest}/bin/plutonium session start
    TryExec=${dest}/bin/plutonium
    Type=Application
    DesktopNames=Plutonium
  '').overrideAttrs { passthru.providedSessions = [ "plutonium" ]; };
in
{
  programs.nix-ld = {
    enable = true;
    libraries = with pkgs; [
      stdenv.cc.cc.lib
      mesa
      libgbm
      libglvnd
      libdrm
      wayland
      expat
      zlib
      zstd
      libffi
      libbsd
      libmd
      systemd
      dbus
      alsa-lib
      glib
      pcre2
      libselinux
      util-linux
      # libpci, which ANGLE dlopen()s for the GPU's PCI ids. Without them
      # Chromium's ChromeOS GPU list can't tell an AMD or Intel GPU from one it
      # doesn't trust, and turns GPU rasterization off: every page is painted
      # on the CPU (Charon's overview at 20-30 fps).
      pciutils
    ]
    # X11's: lowercase at the top level since NixOS 26.05, in xorg before.
    ++ map (name: pkgs.${pkgs.lib.toLower name} or pkgs.xorg.${name}) [
      "libX11" "libXau" "libXdmcp" "libXcomposite" "libXdamage" "libXext"
      "libXfixes" "libXrandr" "libXrender" "libXi" "libXtst" "libxcb"
    ];
  };

  # The GPU's drivers, for Ash's display and its Vulkan.
  hardware.graphics.enable = true;

  # The login screen's entry.
  services.displayManager.sessionPackages = [ session ];

  # `plutonium` (NixOS's PATH has no /usr/local/bin), and what the release
  # runs with from the host: Python (the print portal, terminals), git
  # (installed shells), curl; foot (the shells' terminal) and
  # xwayland-satellite (X11 apps).
  environment.systemPackages = [
    (pkgs.writeShellScriptBin "plutonium" ''exec ${dest}/bin/plutonium "$@"'')
    pkgs.python3
    pkgs.git
    pkgs.curl
    pkgs.foot
    pkgs.xwayland-satellite
  ];

  # Chromium reads keyboard layouts from /usr/share/X11/xkb only, and the
  # release's libinput its device quirks from /usr/share/libinput: the
  # release's own copies.
  systemd.tmpfiles.rules = [
    "d /usr/share/X11 0755 root root -"
    "L /usr/share/X11/xkb - - - - ${dest}/chrome/xkb"
    "L /usr/share/libinput - - - - ${dest}/chrome/libinput"
  ];
}
