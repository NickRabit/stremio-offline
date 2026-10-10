# Stremio Offline for Android TV

A native Android TV client for an existing Stremio Offline server: sign in with
a server address, a username and a password, and use the same account as the
web interface. The behaviour and the contracts are in
[`docs/android-tv-spec.md`](../docs/android-tv-spec.md); this file only covers
how to build and run the project. Setting up a new machine from scratch, step
by step, is in [`docs/android-tv-development.md`](../docs/android-tv-development.md).

## Requirements

- JDK 17.
- The Android SDK with platform 35 and build-tools 35.0.0. Point `ANDROID_HOME`
  at it; no `local.properties` is committed.

```bash
export JAVA_HOME=/path/to/jdk-17
export ANDROID_HOME=/path/to/android-sdk
```

## Build, test and lint

Run everything from `android-tv/`:

```bash
./gradlew assembleDebug          # app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest      # JVM unit tests
./gradlew lintDebug
```

`versionName` is read from the repository's root `package.json` at build time
and `versionCode` is derived from it, so the APK follows the shared version
without a second copy of it.

## Install on a device

```bash
adb connect <tv-address>:5555
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## Android TV emulator

```bash
sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0" \
  "system-images;android-34;android-tv;arm64-v8a"
avdmanager create avd -n stremio-tv -k "system-images;android-34;android-tv;arm64-v8a" -d tv_1080p
emulator -avd stremio-tv
```

Use `x86_64` instead of `arm64-v8a` on an Intel host.
