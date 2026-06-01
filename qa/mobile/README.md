# Mobile Dev-Loop Runbook

Branch: `feature/mobile-client` | Worktree: `.claude/worktrees/mobile-client`

> Validated 2026-06-01. All commands confirmed working. Steps 1–3 are verified reachability facts.

---

## Reachability: Verified Facts

| Surface | Host alias | Verified |
|---|---|---|
| Android emulator → gateway | `10.0.2.2:8888` | ping 0% loss |
| iOS sim → gateway | `localhost:8888` | Safari reached host (TLS prompt) |
| Gateway health | `https://localhost:8888/api/v1/health` → `{"status":"ok"}` | curl confirmed |

---

## Gateway

```bash
cd deploy/macos
docker compose up -d gateway

# Health check
curl -sk --max-time 5 https://localhost:8888/api/v1/health
# Expected: {"status":"ok"}
```

---

## KMP Shared SDK

```bash
# From worktree root
./gradlew :shared:mobile-sdk:allTests
```

---

## Android Drive Loop

**Target AVD:** `Pixel_3a_API_34`

```bash
# 1. Start emulator (headless-capable)
~/Library/Android/sdk/emulator/emulator -avd Pixel_3a_API_34 -no-snapshot-save &

# 2. Wait for boot
~/Library/Android/sdk/platform-tools/adb wait-for-device shell 'while [[ -z $(getprop sys.boot_completed) ]]; do sleep 1; done'

# 3. Build debug APK
./gradlew :android:assembleDebug

# 4. Install + launch (android CLI / bundletool)
android run --apks=android/build/outputs/apk/debug/android-debug.apk

# 5. Capture screen
~/Library/Android/sdk/platform-tools/adb exec-out screencap -p > /tmp/android-screen.png

# 6. Inspect layout
android layout

# 7. Stream logs (scoped)
~/Library/Android/sdk/platform-tools/adb logcat -s SentientApp:V

# Verify emulator → gateway NAT
~/Library/Android/sdk/platform-tools/adb shell ping -c 2 -W 2 10.0.2.2
```

**Gateway URL in Android app:** `wss://10.0.2.2:8888/ws` (debug builds only)

---

## iOS Drive Loop

**Target sim:** `iPhone 14 Pro (26.5)` | UDID: `2BB144EC-281C-4E5E-883F-65A21EF67056`

> **REQUIRED:** `xcodegen generate` must run before any `xcodebuild` call.
> The `.xcodeproj` is gitignored — `project.yml` is the source of truth.

```bash
# 1. Generate .xcodeproj from project.yml
cd ios && xcodegen generate

# 2. Build for simulator
xcodebuild \
  -project ios/Sentient.xcodeproj \
  -scheme Sentient \
  -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 14 Pro (26.5)' \
  build

# 3. Boot sim (idempotent)
xcrun simctl boot 2BB144EC-281C-4E5E-883F-65A21EF67056 2>/dev/null || true

# 4. Install + launch
xcrun simctl install 2BB144EC-281C-4E5E-883F-65A21EF67056 <path/to/Sentient.app>
xcrun simctl launch 2BB144EC-281C-4E5E-883F-65A21EF67056 io.sentient.app

# 5. Capture screenshot
xcrun simctl io 2BB144EC-281C-4E5E-883F-65A21EF67056 screenshot /tmp/ios-screen.png

# 6. Stream app logs
xcrun simctl spawn booted log stream \
  --predicate 'subsystem=="io.sentient.app"' \
  --style compact

# 7. Run Maestro smoke
export MAESTRO_CLI_NO_ANALYTICS=1
~/.maestro/bin/maestro --device 2BB144EC-281C-4E5E-883F-65A21EF67056 \
  test qa/mobile/foundation-ios.yaml
```

**Gateway URL in iOS app:** `wss://localhost:8888/ws` (sim shares host loopback)

---

## TLS Notes

| Context | Behavior |
|---|---|
| Android debug build | `network_security_config` debug-overrides trust self-signed cert for `10.0.2.2` and `localhost` |
| iOS debug build | ATS localhost exception in `Info.plist` allows `localhost` cleartext/self-signed |
| Release builds | Validate the Pi's real cert — no bypasses |

---

## P2 Carry-Forwards (do not fix in P0)

- **Android:** Manifest theme should move to `Theme.Material3.DayNight`; requires `com.google.android.material` entry in the version catalog.
- **iOS:** Needs Swift 6 xcconfig (`SWIFT_VERSION=6.0`, `SWIFT_STRICT_CONCURRENCY=complete`); add `#Preview` to `ContentView` once it has real content.
