# Plutonium's Chromium (Ash + Exo) on the host, without the container: a
# release build (the prebuilt image's /opt/plutonium/chrome, or out/Release),
# with its libraries from nixpkgs. `plutonium host build` stages the files and
# builds this against the system's <nixpkgs>, so libgbm, libEGL and Vulkan
# match the Mesa drivers in /run/opengl-driver.
{
  lib, stdenv, autoPatchelfHook, makeWrapper, src,
  # Linked by chrome and ANGLE (readelf -d)
  alsa-lib, dbus, expat, libgbm, libinput, libxkbcommon, nspr, nss, systemdLibs,
  libx11, libxcb, libxcomposite, libxdamage, libxext, libxfixes, libxrandr,
  # Loaded at run time: GL/EGL (glvnd), VA-API, PCI ids, audio, printing
  libglvnd, libva, pciutils, libpulseaudio, cups,
}:

stdenv.mkDerivation {
  pname = "plutonium-chrome";
  version = "0";
  inherit src;

  nativeBuildInputs = [ autoPatchelfHook makeWrapper ];
  buildInputs = [
    alsa-lib dbus expat libgbm libinput libxkbcommon nspr nss systemdLibs
    libx11 libxcb libxcomposite libxdamage libxext libxfixes libxrandr
    stdenv.cc.cc.lib
  ];
  # dlopen()ed, so autoPatchelf can't see them: on every binary's RUNPATH.
  runtimeDependencies = [ libglvnd libva pciutils libpulseaudio cups systemdLibs ];

  installPhase = ''
    runHook preInstall
    mkdir -p $out/libexec/plutonium $out/bin
    cp -a . $out/libexec/plutonium/chrome
    # The setuid sandbox can't be setuid in the store; Chromium uses the user
    # namespace sandbox instead, but only if this helper isn't there.
    rm -f $out/libexec/plutonium/chrome/chrome-sandbox
    # XDG_DATA_DIRS: Mesa's Vulkan ICDs, for the bundled Vulkan loader. The
    # CLI and the kill switch find Ash by the binary's own path (lib/common.sh,
    # ASH_BIN), which Chromium puts in its process title.
    makeWrapper $out/libexec/plutonium/chrome/chrome $out/bin/chrome \
      --prefix XDG_DATA_DIRS : /run/opengl-driver/share
    runHook postInstall
  '';

  meta = {
    description = "Plutonium's Chromium (Ash + Exo), from a release build";
    platforms = [ "x86_64-linux" ];
    mainProgram = "chrome";
  };
}
