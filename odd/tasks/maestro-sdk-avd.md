# Maestro + Android SDK setup (this host)

Goal: leave the Maestro CLI, the Maestro MCP server, the Android SDK and
an AVD ready to run `.maestro/smoke.yaml`, `.maestro/m3-query.yaml` and
`.maestro/m4-forms.yaml` locally. Everything is installed user-local; no
sudo password is available on this host.

## Verified initial state (2026-10-11)

- Java Temurin 17.0.20.1+1 already installed at
  `~/.local/jdk-17.0.20.1+1` (exported from `.bashrc`).
- Maestro CLI 2.11.0 already installed at `~/.maestro/bin/maestro`; it
  needs that Java on `JAVA_HOME`.
- MCP server `mcp__maestro` connected (10 tools); `list_devices` only
  showed `chromium` before an emulator was running.
- No Android SDK (`~/Android/Sdk` did not exist, although `ANDROID_HOME`
  pointed there). No `adb`, no `emulator`.
- `/dev/kvm` present and accessible per `test -rw` (the `kvm` group is
  empty, so access comes from an ACL; `getfacl` is not installed to
  confirm).
- Earlier notes in `maestro-mcp.md` mention AVDs from another host
  (`/home/jona/...`) and do not apply here.

## Tasks

- [x] S1 Feasibility: Debian 13, 381G free, network reachable to
  `dl.google.com`, no passwordless sudo, so everything is user-local.
- [x] S2 Download cmdline-tools into `~/Android/Sdk/cmdline-tools/latest`.
  Done: build 11076708, 147MB.
- [x] S3 Install with `sdkmanager`: `platform-tools`, `emulator`,
  `platforms;android-34`, `system-images;android-34;google_apis;x86_64`;
  accept the licences. Done: emulator 37.2.12, platform-tools 37.0.1.
- [x] S4 Persistent PATH (`.bashrc`/`.zshrc`): `platform-tools`,
  `emulator`, `cmdline-tools/latest/bin`, without duplicating the
  existing Java and `.maestro` entries. Done; `ANDROID_AVD_HOME` was also
  normalised to `$HOME/.android/avd`.
- [x] S5 Create the AVD `Tengo_API34` (Pixel 6, API 34, `google_apis`,
  `x86_64`) consistent with `docs/testing.md`. Done.
- [x] S6 Verify: `adb --version`, `emulator -list-avds`,
  `maestro --version`, a cold boot of the AVD plus `adb wait-for-device`,
  and the MCP `list_devices` call with the emulator up. Done 2026-10-11 —
  `emulator-5554` online, Android 14, MCP `list_devices` reports it
  `connected:true`. Finding: `-gpu swiftshader_indirect` and the default
  GPU backend segfault QEMU on this host; with `-gpu off` the AVD boots
  in about 1–2 minutes. Helper: `scripts/boot-emulator.sh`.
- [ ] S7 Run `.maestro/smoke.yaml` against the emulator once everything
  above passes. Pending — `com.tengo.app` must be installed on the AVD
  first, which requires a debug build plus Metro (`npx expo run:android`
  or an existing `android/app/build/outputs/apk/debug/app-debug.apk`
  installed with `adb install -r`).

## KVM note

If the emulator complains about `/dev/kvm`, the user must be added to the
`kvm` group (`sudo usermod -aG kvm $USER` followed by a re-login). That
needs a password and is the user's call.
