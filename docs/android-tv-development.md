# Android TV development setup

How to prepare a machine to build, test and run the Android TV client
(`android-tv/`) next to the server and web app. It is written so that a coding
agent can follow it step by step: every step says what to install, how to check
it, and what to put in the shell profile. The product scope lives in
[android-tv-spec.md](android-tv-spec.md).

The steps are for macOS on Apple silicon with Homebrew. Linux notes follow each
step where the command differs.

## 1. Toolchain

| Tool | Why | Install (macOS) | Check |
| --- | --- | --- | --- |
| Node.js 22 | server and web build, unit tests | `brew install node@22` | `node --version` → `v22.x` |
| Docker | local deployment and e2e (`npm run test:e2e:docker`) | Docker Desktop | `docker compose version` |
| GitHub CLI | pull requests, workflow runs | `brew install gh`, then `gh auth login` | `gh auth status` |
| JDK 17 | Android Gradle Plugin | `brew install --cask temurin@17` | `/usr/libexec/java_home -v 17` |
| Android command-line tools | `sdkmanager`, `avdmanager` | `brew install --cask android-commandlinetools` | `sdkmanager --version` |

`node@22` is keg-only, so it is not on `PATH` until the profile says so.
On Linux use the NodeSource or distribution package for Node 22, the
`temurin-17-jdk` package, and the command-line tools zip from
developer.android.com unpacked to `$HOME/Android/Sdk/cmdline-tools/latest`.

The project's Gradle wrapper (`android-tv/gradlew`) downloads Gradle itself; a
system Gradle is not needed.

## 2. Shell profile

Append to `~/.zprofile` (bash: `~/.bash_profile`), then open a new shell:

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
export JAVA_HOME="$(/usr/libexec/java_home -v 17)"
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
```

On Linux: `JAVA_HOME=/usr/lib/jvm/temurin-17-jdk-amd64` (or wherever the
package put it) and `ANDROID_HOME=$HOME/Android/Sdk`.

## 3. Android SDK packages

Accepting the SDK licences is the user's decision; an agent asks before running
the first line.

```bash
yes | sdkmanager --licenses
sdkmanager --install "platform-tools" "platforms;android-35" "build-tools;35.0.0" "emulator" "system-images;android-34;android-tv;arm64-v8a"
```

On an x86-64 machine use `system-images;android-34;android-tv;x86`. The
emulator and image are about 3 GB; a build-only machine (CI) needs only the
first three packages.

## 4. Repository

```bash
git clone https://github.com/NickRabit/stremio-offline.git
cd stremio-offline
npm ci
npm run build && npm test
cd android-tv && ./gradlew assembleDebug testDebugUnitTest lintDebug
```

All of these must pass before any change. `android-tv/local.properties` is not
needed when `ANDROID_HOME` is set, and is git-ignored if Android Studio writes
one.

## 5. Emulator and a server to talk to

```bash
avdmanager create avd -n tv -k "system-images;android-34;android-tv;arm64-v8a" -d tv_1080p
emulator -avd tv &
adb wait-for-device
adb install -r android-tv/app/build/outputs/apk/debug/app-debug.apk
```

Start the server as `AGENTS.md` describes (`docker compose up -d --build`). The
emulator reaches the host as `10.0.2.2`, so the server address to type on the
sign-in screen is `http://10.0.2.2:8090`. A real television on the same network
uses the host's LAN address instead; installing onto the owner's televisions
needs their go-ahead.

`adb shell input keyevent DPAD_DOWN` (and `DPAD_UP`, `DPAD_LEFT`,
`DPAD_RIGHT`, `DPAD_CENTER`, `BACK`) drives the emulator like a remote;
`adb exec-out screencap -p > screen.png` takes a screenshot.

## 6. The AI team workflow (optional)

Some work in this repository runs through the local `ai-team` skill: Claude as
architect and reviewer, DeepSeek as implementer through the Codex CLI. None of
it is in git; on a new machine it needs:

1. The Codex CLI (ships with the ChatGPT desktop app, or `npm i -g @openai/codex`)
   linked as `~/.local/bin/codex`.
2. `DEEPSEEK_API_KEY` exported from `~/.zprofile`. The key is the owner's; an
   agent never asks for it in chat and never writes it into the repository.
3. A Codex profile named `deepseek` (`model_provider = "deepseek"`,
   `base_url = "https://api.deepseek.com/"`, `env_key = "DEEPSEEK_API_KEY"`,
   `wire_api = "responses"`), copied from the owner's `~/.codex/` with its model
   catalog.
4. The skill itself in `~/.claude/skills/ai-team`, copied as files (not a
   symlink) into the repository's `.claude/skills/ai-team`, because its scripts
   locate the repository from their own path.
5. `.claude/` and `.ai-team/` added to `.git/info/exclude`.

The worker's sandbox has no Node or Java, so the reviewer runs the gates
(`.claude/skills/ai-team/scripts/gates.sh <ID>`, and `./gradlew ...` for
`android-tv/`) on the host.

## Checklist for an agent

- [ ] `node --version` is 22.x and `npm test` passes at the repository root.
- [ ] `docker compose up -d --build` brings up a container whose
      `/api/status` answers `{"status":"ok",…}`.
- [ ] `java -version` under `JAVA_HOME` is 17.
- [ ] `sdkmanager --list_installed` shows platform 35, build-tools 35.0.0 and
      platform-tools.
- [ ] `./gradlew assembleDebug testDebugUnitTest lintDebug` passes in
      `android-tv/`.
- [ ] Optional: the `tv` emulator boots and the debug APK signs in to
      `http://10.0.2.2:8090`.
