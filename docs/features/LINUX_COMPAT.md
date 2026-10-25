# What pages see: Linux Chromium, not ChromeOS

Plutonium is built as ChromeOS (Ash and Exo live there), but a page shouldn't be able to tell (`ARCHITECTURE.md`, "ChromeOS is an implementation detail"). Some sites serve ChromeOS their own UI, or break, when they see it.

## Fixed

- **The user agent** is `Mozilla/5.0 (X11; Linux x86_64) … Chrome/<major>.0.0.0 Safari/537.36`, as Linux Chromium's, not `X11; CrOS x86_64 14541.0.0`. UA client hints say platform `"Linux"` (`Sec-CH-UA-Platform`, `navigator.userAgentData.platform`), with an empty platform version, not `"Chromium OS"` and `24.4.0`. The OS/CPU string (the non-reduced UA) is `Linux x86_64`. Patch "pages see Linux, not ChromeOS" (`components/embedder_support/user_agent_utils.cc`, and its unit test's ChromeOS expectations). `navigator.platform` was already `Linux x86_64`.
- **The timezone** was UTC (the container's), so pages' clocks were off. Ash now gets the host's zone as `TZ` (`timedatectl`, else `/etc/localtime`), and `LANG`, from `lib/session.sh`, on every launch path. `Intl` and `Date` show the host's zone.
- **Languages** were `["en-US"]`; with `LANG` they are `["en-US", "en"]` as on Linux (`navigator.languages`, `Accept-Language`).
- **Web APIs ChromeOS has and desktop Linux Chromium doesn't** are off (`--disable-blink-features=WebShare,HandwritingRecognition,BarcodeDetector,WebBluetooth`, from `lib/session.sh`): `navigator.share`/`canShare`, `navigator.createHandwritingRecognizer`, `BarcodeDetector`, `navigator.bluetooth`. A site seeing them on a Linux user agent could tell.
- **H.264 and AAC** (`proprietary_codecs = true`, `ffmpeg_branding = "Chrome"` in `chromium/args*.gn`, as nixpkgs' Chromium). Verified 2026-10-26 on Xvfb: `canPlayType` says `probably` to `avc1.42E01E` and `mp4a.40.2`, MSE and WebCodecs accept them, and a 320×240 H.264/AAC mp4 (made with ffmpeg) plays in a tab (frames presented, audio decoded). A tab no shell shows is hidden, and like Chrome's background tabs it doesn't load media until it is shown.

Verified 2026-10-26 on Xvfb with the build of patch 0051, in a tab on example.com: `navigator.userAgent` `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36`, `navigator.platform` `Linux x86_64`, `userAgentData` platform `"Linux"`, `platformVersion` `""`, architecture `x86`, timezone `Pacific/Auckland`, `navigator.share` and `navigator.bluetooth` undefined.

## How it was compared

`navigator`, `window` globals, `userAgentData` (with the high-entropy values), codecs (`canPlayType`), media capabilities and devices, fonts, WebGL strings, `window.chrome`, timezone and languages, read by one script in a Plutonium tab and in Linux Chromium (nixpkgs, 147, `--headless=new`) on a localhost page. Differences that come from the versions (158 against 147: `HTMLCameraElement`, `cpuPerformance`, `globalPrivacyControl`, …) or from headless (no WebGL) aren't listed.

## Still different (backlog)

- **Fonts**: pages render with the container's fonts (135, DejaVu Sans as sans-serif), not the host's (1201 here, Noto Sans). Until Ash runs on the host, the container could see the host's fonts and fontconfig.
- **Web notifications from tabs** go to Ash's message center, which shell mode blocks: a granted `new Notification()` shows nothing. Linux Chromium shows them through the desktop's notification daemon. They could go to the shell (as tab requests), or through the helper to `org.freedesktop.Notifications`.
- **Speech synthesis** has no voices (ChromeOS's come from its TTS extensions; Linux Chromium's from speech-dispatcher).
- **Media keys and MPRIS**: a tab's media session goes to Ash's media controls; Linux Chromium exposes it on D-Bus (MPRIS), so the desktop's media keys and widgets see it.
- **Dark mode** follows Ash's setting (dark), not the host's.
- **IME**: Ash's input-method framework, not IBus/Fcitx (`BACKLOG.md`, text-input-v3).
- **Privacy Sandbox APIs** (Protected Audience, Shared Storage, fenced frames) are present in Linux Chromium 147 and not in ours; few sites look.
- **WebGL** reports ANGLE on Vulkan with the real GPU, like Linux Chromium with Vulkan; Linux Chromium's default is ANGLE on OpenGL, a different but not ChromeOS-specific string.
