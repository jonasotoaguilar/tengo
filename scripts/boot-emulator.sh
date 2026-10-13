#!/bin/bash
# Levanta el AVD Tengo_API34 headless para Maestro.
# Nota: en este host se usa `-gpu off` porque el backend SwiftShader/Vulkan
# (default y `swiftshader_indirect`) hace segfault al QEMU durante el setup.
# KVM sí está usable, así que con `-gpu off` el boot tarda ~1-2 min.
# El primer arranque necesita datos limpios: pasar -wipe-data una vez.
set -u
export JAVA_HOME="$HOME/.local/jdk-17.0.20.1+1"
export ANDROID_HOME="$HOME/Android/Sdk"
export ANDROID_SDK_ROOT="$HOME/Android/Sdk"
export ANDROID_AVD_HOME="$HOME/.android/avd"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
adb start-server >/dev/null 2>&1
exec emulator -avd Tengo_API34 -no-window -no-audio -no-snapshot -gpu off -no-boot-anim -memory 2048 "$@"
