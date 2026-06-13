# SentientMobileVitals — E2E smoke (Task 13)

Date: 2026-06-13 (UTC). Stack: local Docker (`deploy/macos/`), gateway rebuilt +
restarted with the diagnostics endpoint + `~/.sentient/gateway/clientLogs` volume
live. Driver: Maestro 2.6.0. Android `emulator-5554` (Pixel_3a_API_34, Android 14).
iOS `iPhone 14 Pro (26.5)` sim `2BB144EC-281C-4E5E-883F-65A21EF67056`.

> **Privacy re-verify (2026-06-13, app v0.1.2):** the inbound-WS chat-content leak
> (the one RED case below) was fixed in commonMain — `WsTransport.routeText` now
> logs `recv-text len=…` instead of the raw frame (commit `c57dae8`). Both apps were
> rebuilt + reinstalled at **v0.1.2** (Android versionCode 4, iOS build 1, sdk 0.1.2)
> and the send-diagnostic flow re-run. The privacy-guard row is now **PASS on both
> platforms** — clean grep output in the "Privacy guard — PASS (re-verified)" section
> below. Original RED findings retained for the audit trail.

Flows (new, committed):
- `qa/mobile/flows/android/30-send-diagnostic.yaml`
- `qa/mobile/flows/ios/30-send-diagnostic.yaml`

## Case matrix

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail | Result |
|------|----------|-----------|--------|-----------------------|--------------------|--------|
| manual-upload Android | emulator-5554 | logged out, fresh launch | login → chat "hi" → drawer → settings → send-logs → send "This session" | progress bar → "Sent ✓ — ref XXXX" | gateway `diagnostics.received` + new file under clientLogs/mobile/ | **PASS** |
| manual-upload iOS | iPhone 14 Pro (26.5) | logged out, fresh launch | login → chat "hi" → drawer → settings → send-logs → send "This session" | progress bar → "Sent ✓ — ref XXXX" | gateway `diagnostics.received` + new file under clientLogs/mobile/ | **PASS** (see below) |
| session-meta present | both | uploaded file exists | inspect file header | n/a | header has platform/device/os/appVersion/deviceId/network | **PASS** |
| privacy guard | both | uploaded file exists | grep file for chat text | chat text ABSENT | no user/assistant text in file | **PASS** (re-verified v0.1.2, fix `c57dae8`) — chat content ABSENT on Android AND iOS (see "Privacy guard — PASS" section) |
| crash-auto-upload | both | n/a | trigger native unhandled crash | crash log auto-uploads with `-crash-` ref | gateway `diagnostics.received crashed=true` | **BLOCKED** — no in-app crash trigger (follow-up) |

Manual-upload happy path (user-visible behavior + file write + gateway log line) is
GREEN on both platforms. The session-meta header is present on both. The privacy
guard was the one RED case in the first run; it is now **GREEN on both platforms**
after the `c57dae8` commonMain fix + a v0.1.2 rebuild/reinstall (clean grep proof in
"Privacy guard — PASS"). The original RED section is kept below for the audit trail.

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

## Privacy guard — PASS (re-verified v0.1.2, fix `c57dae8`)

After the commonMain fix landed (`WsTransport.routeText` logs `recv-text len=…`,
never the raw frame — commit `c57dae8`), both apps were rebuilt + reinstalled at
**v0.1.2** and the send-diagnostic flow re-run. The chat content I exchanged
(user "hi" + the assistant reply) is now **ABSENT** from both uploaded files. The
old leak signature `recv-text raw=` is gone — `recv-text` now carries only `len=`.

**Re-verify uploads (NEW, v0.1.2 — distinct from the original RED files):**
- Android: `~/.sentient/gateway/clientLogs/mobile/u_8c866990-1781388428373-4825E1.log` (9600 bytes, ref `4825E1`); header `appVersion=0.1.2 build=4 sdkVersion=0.1.2`.
- iOS: `~/.sentient/gateway/clientLogs/mobile/u_8c866990-1781388591825-280C7A.log` (8346 bytes, ref `280C7A`); header `appVersion=0.1.2 build=1 sdkVersion=0.1.2`.

### Android — clean grep against `u_8c866990-1781388428373-4825E1.log`:

```
$ grep -c 'recv-text' <file>          → 13   (line still present)
$ grep 'recv-text' <file>             → every line reads "recv-text len=NNN", e.g.:
    sentient.mobile-sdk.transport.ws recv-text len=107
    sentient.mobile-sdk.transport.ws recv-text len=225
    sentient.mobile-sdk.transport.ws recv-text len=388
    …  (no chat content — length only)
$ grep -c 'recv-text raw=' <file>     → 0    (OLD leak signature GONE)
$ grep -cE '"delta"|"text"|message.delta' <file>   → 0    (no raw frame bodies)
$ grep -cE 'conversation\.entry|"type":|"item":|"kind":|entryId|"assistant"|"user"' <file>  → 0
$ grep -cE '\{' <file>                → 0    (no JSON frame bodies persisted at all)
```
Content-sensitive sinks log metadata only:
`inflight-message delta cycleId=cycle-1 deltaLen=36 totalLen=36` (length, not text),
`conversation-history entry ts=… cycleId=… size=…` (no item text),
`user-text-input send type=text.input len=2 pendingId=…` (length, not "hi"),
`send-text length=NNN` (length only).

### iOS — clean grep against `u_8c866990-1781388591825-280C7A.log`:

```
$ grep -c 'recv-text' <file>          → 14
$ grep 'recv-text' <file>             → every line "recv-text len=NNN", e.g.:
    sentient.mobile-sdk.transport.ws recv-text len=107
    sentient.mobile-sdk.transport.ws recv-text len=388
    sentient.mobile-sdk.transport.ws recv-text len=241
    …  (length only)
$ grep -c 'recv-text raw=' <file>     → 0    (OLD leak signature GONE)
$ grep -cE '"delta"|"text"|message.delta' <file>   → 0
$ grep -cE 'conversation\.entry|"type":|"item":|"kind":|entryId|"assistant"|"user"' <file>  → 0
$ grep -cE '\{' <file>                → 0
```
Content-sensitive sinks log metadata only:
`inflight-message delta cycleId=cycle-1 deltaLen=63 totalLen=63` (length, not the
63-char reply), `conversation-history entry ts=… size=…` (no item text),
`user-text-input send … len=2 pendingId=…` (length, not "hi"), `send-text length=NNN`.

Header block (`platform=`/`device=`/`os=`/`appVersion=`/`deviceId=`/`network=`),
`len=`/`deltaLen=`/ids are EXPECTED and present on both — only chat CONTENT must be
absent, and it is. Gateway `diagnostics.received` logged both uploads
(`ref=4825E1` Android, `ref=280C7A` iOS; both `crashed=false`); session-meta header
present + well-formed on both. **Privacy gate: GREEN on both platforms.**

---

## Privacy guard — FAIL (ORIGINAL RUN, superseded by the PASS above — audit trail)

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

**Fix applied (commit `c57dae8`, option a above):** `WsTransport.routeText` now logs
`log.debug("recv-text", mapOf("len" to raw.length))` — frame length only, never the
raw content. Re-verified at v0.1.2: see "Privacy guard — PASS (re-verified)" above —
`recv-text raw=` is gone on both platforms; `recv-text len=…` is all that remains.
Note: `PrivacyGuardTest` in `shared/mobile-sdk/src/commonTest/.../vitals/` passed in
unit form because it drove a synthetic text path; it did NOT exercise the
`WsTransport.routeText` `recv-text raw=` sink, which is why the leak slipped through
to the first E2E run — caught here, fixed, and now confirmed by a REAL upload.

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
- Gateway: `docker compose -f deploy/macos/docker-compose.yml build gateway` then `up -d gateway`; healthy; `/api/v1/diagnostics/logs` returns 401 `missing-token` unauthenticated (route live); clientLogs volume mounted host↔container. (Privacy re-verify did NOT rebuild the gateway — the fix is client-side; the gateway just stores what it receives.)
- Android: `./gradlew :android:assembleDebug` → `android/build/outputs/apk/debug/android-debug.apk` → `adb -s emulator-5554 install -r` (data preserved → persisted backend config survived).
- iOS: XCFramework + `xcodegen generate` + `xcodebuild -scheme SentientApp -configuration Debug` (SIGNED, no CODE_SIGNING_ALLOWED=NO) → `BUILD SUCCEEDED` → `xcrun simctl install`. The debug build is an arm64 sim slice; runs fine on the Apple-Silicon iPhone 14 Pro (26.5) simulator (no arch blocker).

### Privacy re-verify rebuild (v0.1.2, fix `c57dae8`)
Both apps rebuilt + reinstalled to carry the commonMain privacy fix + the 0.1.2
version bump, then the send-diagnostic flow re-run on each. Builds all green.
- Android: `./gradlew :android:assembleDebug` → `BUILD SUCCESSFUL` → `adb -s emulator-5554 install -r android/build/outputs/apk/debug/android-debug.apk` → `Success`. Uploaded header `appVersion=0.1.2 build=4`; on-screen "App version 0.1.2 (4)" → "Sent ✓ — ref 4825E1".
- iOS: `./gradlew :shared:mobile-data:assembleMobileDataDebugXCFramework` → `BUILD SUCCESSFUL`; `cd ios && xcodegen generate`; `xcodebuild -scheme SentientApp -configuration Debug -destination 'id=2BB144EC-…' build` (SIGNED — "Sign to Run Locally", no `CODE_SIGNING_ALLOWED=NO`) → `BUILD SUCCEEDED`; `xcrun simctl install …` → app `CFBundleShortVersionString 0.1.2`. Uploaded header `appVersion=0.1.2 build=1`; on-screen "App version 0.1.2 (1)" → "Sent ✓ — ref 280C7A".

## Screenshots
- `android-sent.png` — Android Settings "Sent ✓ — ref …" state (adb screencap right after the flow).
- `ios-sent.png` — iOS Settings "Sent ✓ — ref …" state (simctl screenshot right after the flow).
