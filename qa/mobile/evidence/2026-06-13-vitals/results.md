# SentientMobileVitals — E2E smoke (Task 13)

Date: 2026-06-13 (UTC). Stack: local Docker (`deploy/macos/`), gateway rebuilt +
restarted with the diagnostics endpoint + `~/.sentient/gateway/clientLogs` volume
live. Driver: Maestro 2.6.0. Android `emulator-5554` (Pixel_3a_API_34, Android 14).
iOS `iPhone 14 Pro (26.5)` sim `2BB144EC-281C-4E5E-883F-65A21EF67056`.

Flows (new, committed):
- `qa/mobile/flows/android/30-send-diagnostic.yaml`
- `qa/mobile/flows/ios/30-send-diagnostic.yaml`

## Case matrix

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail | Result |
|------|----------|-----------|--------|-----------------------|--------------------|--------|
| manual-upload Android | emulator-5554 | logged out, fresh launch | login → chat "hi" → drawer → settings → send-logs → send "This session" | progress bar → "Sent ✓ — ref XXXX" | gateway `diagnostics.received` + new file under clientLogs/mobile/ | **PASS** |
| manual-upload iOS | iPhone 14 Pro (26.5) | logged out, fresh launch | login → chat "hi" → drawer → settings → send-logs → send "This session" | progress bar → "Sent ✓ — ref XXXX" | gateway `diagnostics.received` + new file under clientLogs/mobile/ | **PASS** (see below) |
| session-meta present | both | uploaded file exists | inspect file header | n/a | header has platform/device/os/appVersion/deviceId/network | **PASS** |
| privacy guard | both | uploaded file exists | grep file for chat text | chat text ABSENT | no user/assistant text in file | **FAIL** — chat text PRESENT on Android AND iOS (see Privacy section) |
| crash-auto-upload | both | n/a | trigger native unhandled crash | crash log auto-uploads with `-crash-` ref | gateway `diagnostics.received crashed=true` | **BLOCKED** — no in-app crash trigger (follow-up) |

Manual-upload happy path (user-visible behavior + file write + gateway log line) is
GREEN on both platforms. The session-meta header is present on both. The privacy
guard is the one RED case, and it fails identically on both platforms.

## Gateway evidence — Android upload

**File:** `~/.sentient/gateway/clientLogs/mobile/u_8c866990-1781387134712-689966.log` (10984 bytes)

**Header block** (client-written session-meta, all required fields present):
```
# fileHint=vitals-1781387103298.log
=== SENTIENT VITALS SESSION ===
platform=android
device=Google sdk_gphone64_arm64
os=Android 14
appVersion=0.1.1
build=3
sdkVersion=0.1.1
deviceId=5a5b8852-13fd-478c-9119-e329db3a47ee
userId=-
sessionStartMs=1781387103298
locale=en_US
network=wifi
freeMemBytes=191553776
freeDiskBytes=4032708608
=== LOG ===
```

**Gateway log line** (`~/.sentient/gateway/logs/2026-06-13.log`, UTC):
```
2026-06-13T14:45:34.717 INFO  [api:diagnostics] diagnostics.received | userId="u_8c866990" bytes=10948 crashed=false ref="689966" name="u_8c866990-1781387134712-689966.log"
```
ref `689966` in the log matches the filename suffix. `crashed=false` (manual upload, no crash sentinel).

## Gateway evidence — iOS upload

**File:** `~/.sentient/gateway/clientLogs/mobile/u_8c866990-1781387552490-1B6B29.log` (13118 bytes)

**Header block** (all required fields present):
```
# fileHint=vitals-1781387532020.log
=== SENTIENT VITALS SESSION ===
platform=ios
device=iPhone
os=iOS 26.5
appVersion=0.1.1
build=1
sdkVersion=0.1.1
deviceId=4629e59f-37d7-4058-8655-a6fa02ac5f3f
userId=-
sessionStartMs=1781387532020
locale=en_CA
network=unknown
freeMemBytes=0
freeDiskBytes=0
=== LOG ===
```
(`network=unknown`, `freeMemBytes/freeDiskBytes=0` are the iOS-sim placeholder values
from the platform vitals provider — not a regression; the required-meta fields are all
present and well-formed.)

**Gateway log line:**
```
2026-06-13T14:52:32.492 INFO  [api:diagnostics] diagnostics.received | userId="u_8c866990" bytes=13118 crashed=false ref="1B6B29" name="u_8c866990-1781387552490-1B6B29.log"
```
ref `1B6B29` matches the filename suffix.

### iOS selector note (test-only, not a code bug)
On iOS SwiftUI the inner button's `accessibilityIdentifier` (`settings-log-send` /
`settings-log-sent`) is NOT surfaced in the Maestro/XCUI tree — only the row
container's id (`settings-log-session-<ms>`) survives, because SwiftUI elides child
a11y ids when the parent `HStack` carries its own identifier. The UI renders
correctly ("This session" selected → "Send" button → "Sent ✓ — ref …"). The iOS
flow therefore drives + asserts by the visible button TEXT ("Send" / "Sent ✓"),
which is reliable. Android's Compose `testTag` ids ARE queryable, so the Android
flow uses ids. This is a selector quirk, not a defect.

## Privacy guard — FAIL (security-boundary regression, BOTH platforms)

The spec requires the chat text I sent (and the assistant reply) to be ABSENT from
the uploaded file. It is PRESENT on both Android and iOS. The leak is on the
**inbound** WS path only — the outbound path is clean (logs lengths, not content).

### Android — grep against `u_8c866990-1781387134712-689966.log`:

```
121:sentient.mobile-sdk.transport.ws recv-text raw={"type":"message.delta","cycleId":"cycle-1","delta":"Hi there! 😊 It's good to talk with you. How's your day going?\n", …
111:sentient.mobile-sdk.transport.ws recv-text raw={"type":"conversation.entry","item":{"entryId":"…","ts":…,"kind":"user", …
128:sentient.mobile-sdk.transport.ws recv-text raw={"type":"conversation.entry","cycleId":"cycle-1","item":{"entryId":"…","kind":"assistant", …
```

- The assistant's full reply (`"Hi there! 😊 It's good to talk with you. How's your day going?"`) is logged verbatim.
- `conversation.entry` frames (carrying both the user message text and assistant text) are logged raw.

### iOS — grep against `u_8c866990-1781387552490-1B6B29.log`:
```
140:sentient.mobile-sdk.transport.ws recv-text raw={"type":"conversation.entry","item":{… "kind":"user", …
150:sentient.mobile-sdk.transport.ws recv-text raw={"type":"message.delta","cycleId":"cycle-1","delta":"Hi there! How's your day going?\n", …
157:sentient.mobile-sdk.transport.ws recv-text raw={"type":"conversation.entry","cycleId":"cycle-1","item":{… "kind":"assistant", …
```
Identical leak. The iOS-side `inflight-message delta` log correctly logs only
`deltaLen=32` (length, not content) — so it is specifically the `recv-text raw=`
sink that leaks.

**Outbound path is clean on both platforms** (no content leak):
```
android  107:sentient.mobile-sdk.connector.user-text-input send type=text.input len=2 …   (length only)
android  89/93:sentient.mobile-sdk.transport.ws.android send-text length=53 / length=15    (length only)
ios      34/88:sentient.mobile-sdk.transport.ws.ios send-text length=305                    (length only)
```

**Root cause:** `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/transport/WsTransport.kt:143`
```kotlin
log.debug("recv-text", mapOf("raw" to raw))
```
logs the entire raw inbound WS frame at DEBUG. The diagnostic ring captures DEBUG,
so every inbound frame's text content (assistant `message.delta` deltas,
`conversation.entry` user+assistant items) is persisted into the rolling vitals
file and uploaded. The logger's ≤120-char truncation does not protect short chat
replies — they fit inside the window and leak in full. This is a privacy/security
boundary the feature exists to respect; it is the only inbound-content sink that
needs redaction (the send path already logs lengths only).

This is a cross-platform CODE BUG (lives in `commonMain`, affects Android + iOS),
not an environment blocker. The manual-upload happy path (user-visible + file write
+ gateway log) is GREEN on both platforms; the privacy guard is RED and is the
headline finding for follow-up.

**Suggested fix direction (for the follow-up, not applied here):** the diagnostic
ring should never persist `recv-text raw=` content. Options: (a) drop the `raw`
field from that DEBUG log and log only `type` + byte length + seq; (b) gate the
raw-frame log behind a flag that the vitals ring does not capture; or (c) redact
known content-bearing fields (`delta`, `conversation.entry.item.*text`) before
logging. The send path already demonstrates the right pattern (length-only).
Note: `PrivacyGuardTest` in `shared/mobile-sdk/src/commonTest/.../vitals/` passes in
unit form because it drives a synthetic text path; it does NOT exercise the
`WsTransport.routeText` `recv-text raw=` sink, which is why the leak slipped through.

## Crash auto-upload — BLOCKED (follow-up)

There is no in-app way to trigger a Kotlin/Kotlin-Native unhandled exception, and
`adb` / `simctl` signals do not fire the `UncaughtExceptionHandler` / K-N crash
hook. Not fabricated, no crash button added. Needs an in-app debug crash trigger
to exercise the `-crash-` auto-upload path. Flagged for follow-up.

## Maestro output excerpts

### Android (all steps COMPLETED)
```
 > Flow 30-send-diagnostic
Launch app "io.dev32.sentient.debug" with clear state... COMPLETED
... login (avatar + PIN 1234) ... COMPLETED
Input text hi / Tap chat-send ... COMPLETED
Assert assistant-bubble visible... COMPLETED
Tap history-open / settings-open ... COMPLETED
Assert settings-send-logs visible / Tap ... COMPLETED
Assert settings-log-send visible / Tap ... COMPLETED
Assert settings-log-sent is visible... COMPLETED
Take screenshot vitals-android-sent... COMPLETED
```

### iOS (all steps COMPLETED)
```
 > Flow 30-send-diagnostic
Run login.yaml... (avatar + PIN 1234) ... COMPLETED
Input text hi / Tap chat-send / Tap chat-message-list ... COMPLETED
Assert assistant-bubble visible... COMPLETED
Tap history-open / settings-open ... COMPLETED
Assert settings-send-logs visible / Tap ... COMPLETED
Assert "This session" is visible... COMPLETED
Tap on "Send"... COMPLETED
Assert "Sent ✓.*" is visible... COMPLETED
Take screenshot vitals-ios-sent... COMPLETED
```
(iOS drives the send/assert by visible text — see the iOS selector note above.)

## Build / install notes
- Gateway: `docker compose -f deploy/macos/docker-compose.yml build gateway` then `up -d gateway`; healthy; `/api/v1/diagnostics/logs` returns 401 `missing-token` unauthenticated (route live); clientLogs volume mounted host↔container.
- Android: `./gradlew :android:assembleDebug` → `android/build/outputs/apk/debug/android-debug.apk` → `adb -s emulator-5554 install -r` (data preserved → persisted backend config survived).
- iOS: XCFramework + `xcodegen generate` + `xcodebuild -scheme SentientApp -configuration Debug` (SIGNED, no CODE_SIGNING_ALLOWED=NO) → `BUILD SUCCEEDED` → `xcrun simctl install`. The debug build is an arm64 sim slice; runs fine on the Apple-Silicon iPhone 14 Pro (26.5) simulator (no arch blocker).

## Screenshots
- `android-sent.png` — Android Settings "Sent ✓ — ref …" state (adb screencap right after the flow).
- `ios-sent.png` — iOS Settings "Sent ✓ — ref …" state (simctl screenshot right after the flow).
