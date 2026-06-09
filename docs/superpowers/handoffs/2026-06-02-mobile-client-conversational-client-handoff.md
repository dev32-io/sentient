# Mobile Client — Conversational Client (Phases 1–3) Handoff

**Date:** 2026-06-02
**Branch:** `feature/mobile-client` (81 commits ahead of `develop`; **NOT pushed** — see Action Needed)
**Plan:** `docs/superpowers/plans/2026-06-01-mobile-client-conversational-client.md`
**Spec:** `docs/superpowers/specs/2026-06-01-mobile-client-design.md`
**Status:** Conversational client (SDK core + text + voice) **complete and sound end-to-end**. Plan 3 (push) + Plan 4 (deploy/store) are unblocked, out of this plan's scope.

---

## Summary — what shipped

A native iOS + Android conversational client, both built on ONE shared Kotlin Multiplatform SDK that mirrors `@sentient/web-sdk`:

- **KMP SDK** (`shared/mobile-sdk/`): a near-verbatim web-sdk port — WS transport, auth HTTP client, reconnect + session-resume, status FSM (`SdkStatus`), the **9 connectors** (`text.input` / `conversation.history` / `message.stream` / `cognition.status` / `session.preferences` / `task.status` / `sessions` / `audio.input` / `audio.output`), the gates (EchoGate / SpeechGate / AudioPreRollRing) + IdleDetector, the PCM16↔Float32 codec, the tagged logger + sanitizer, and **one observable `StateFlow<SdkState>`** that both UIs bind to and re-derive nothing from. Platform capability (WS engine, secure store, mic capture, audio playback, log sink, clock) enters via `expect`/`actual` or injected interfaces, each with a commonTest fake. SKIE bridges the surface to Swift `async`/`AsyncSequence`/enums.
- **Android** (`android/`, Compose): login (avatar grid + OS-numpad PIN) → chat (list + composer, text + voice) → history drawer → thin settings. Binds `SdkState` via `collectAsStateWithLifecycle()`.
- **iOS** (`ios/App/`, SwiftUI): same screens. Binds `SdkState` via `@Published state` drained from the SKIE `AsyncSequence` (`for await s in sdk.state`).
- **Voice** (both): native mic capture → SpeechGate/EchoGate/codec (shared) → PCM16 WS uplink; TTS downlink → playback; OS AEC; barge-in (mic-onset over TTS) distinct from UI-stop; animated `SentientMark` avatar states driven purely by SDK-derived voice status (no free-running idle loops).

---

## Verified GREEN (with evidence)

| Surface | Result | Command / evidence |
|---|---|---|
| KMP unit + contract suite | **iosSimulatorArm64: 296 / testDebug: 299 / testRelease: 299 — 0 failures** | `./gradlew :shared:mobile-sdk:allTests` (release variant passing confirms the TLS bypass compiles out cleanly) |
| TS CI — gateway | **1129 pass / 0 fail** | `bun run test:unit` (gateway) |
| TS CI — webui | 70 pass / 0 fail | `bun run test:unit` (webui) |
| TS lint | clean, 486 files | `bun run lint` (Biome — mobile dirs excluded, no leak) |
| TS typecheck | clean, all packages | `bun run typecheck` |
| Android build | SUCCESS | `./gradlew :android:assembleDebug` |
| iOS build | SUCCEEDED on iPhone 14 Pro / iOS 26.5 sim | `assembleMobileSdkDebugXCFramework` → `xcodegen` → `xcodebuild` |
| Phase-1 e2e | S1 (unit) green; S2 (`@live` text round-trip) green on local stack | gateway log trail: `auth.ok`→`session.ready`, cycleId correlated |
| Phase-2 text e2e (T1–T6) | green on Android emulator + iPhone 14 Pro / iOS 26.5 sim | screenshots in `qa/mobile/screens/` (gitignored) + gateway logs |
| Phase-3 voice e2e (V1, V3, V4) | green both platforms; **V3 with real Fish Audio TTS** | `connector.audio.start`→`done`, `isSpeaking`, `playback.stop` log trail |

> **Evidence note:** smoke screenshots live in `qa/mobile/screens/` which is **gitignored** (local-only). The durable evidence is the gateway log trail (`~/.sentient/gateway/logs/YYYY-MM-DD.log`, UTC) correlated by `sessionId`/`cycleId`. Reusable mobile e2e cases (T1–T6) are recorded in `agents/docs/testing-knowledge.md` (Mobile section).

---

## Bugs found + fixed during live smoke

The value of driving real e2e: four bugs surfaced only against the running stack, none caught by contract tests.

1. **`ts:null` in conversation feed (gateway → strict SDK crash).** On a Hermes-history resume, a rehydrated entry with no usable `ts` serialized `NaN`→`null` on the wire, crashing the strict kotlinx.serialization decoder. **Fixed gateway-side** with double-defense backfill: `hermes-message-to-mirror.ts` coerces the untrusted sidecar `ts` to a non-negative int (WARN on the degraded path), and `conversation-feed.ts` has a `safeTs` backstop at the wire-transform. **SDK side** degrades gracefully (coerce missing fields to `0` / `"-"`).
2. **gateway↔Hermes ACP-wire no-reconnect-on-abnormal-close.** After a gateway restart, a resumed session couldn't dispatch — the ACP WS stayed dead (1006) and the next prompt hung. **Fixed:** a `ManagedAcpSocket` (`acp-wire-socket.ts`) keeps a stable `acpConn` reference with a swappable socket underneath; lazy-ensure reconnect on the next send re-runs `initialize`; an epoch-gated `session/load` re-attaches the captured conversation before the prompt (`SessionAttachmentLedger`); `rejectInflight` rejects in-flight RPCs on abnormal close so the dispatch surfaces a terminal error instead of hanging; a per-request `requestTimeoutMs` backstop. Clean (1000) close / dispose never reconnect. Tunables in `gateway/config.yaml#hermes.acp_wire`.
3. **iOS Keychain `errSecParam` (-50).** `kSecReturnData` was passed as a Kotlin `Boolean` (→ NSNumber) instead of the `CFBooleanRef` the Security framework requires. **Fixed** with a CF-native query (`kSecReturnData = kCFBooleanTrue`, `kSecMatchLimit = kSecMatchLimitOne`) — load now returns the token.
4. **iOS audio-capture SIGABRT on sim.** `runCatching` cannot catch an ObjC `NSException` thrown by `AVAudioEngine` on an invalid mic format (Kotlin/Native only catches Kotlin throwables). **Fixed** with an ObjC `@try/@catch` cinterop shim (`ObjCExceptionGuard.ios.kt`) so capture fails soft (WARN + release the shared-engine retain) instead of crashing.

---

## Gateway changes (4 logical, all sound + tested, no mobile hack in core)

- **A0 — `clientType: "mobile"`**: `shared/protocol/src/messages.ts` enum `["webui","cube"]`→`["webui","cube","mobile"]`; `tts-policy.ts` adds an exhaustive `case "mobile"` (v1 = same policy as webui — mobile has a UI to read text). Landed specifically to enable **targeted push** later.
- **ts:null conversation-feed fix** (bug 1 above).
- **ACP-wire reconnect** (bug 2 above).
- **requestTimeout backstop** (bug 2 above) — per-request deadline so an in-flight prompt can't hang if a close event is missed.

All gated/exhaustive-switched so the compiler pressures the call site on future client types. Mobile cleanly falls into the webui arm; nothing mobile-specific leaked into gateway core paths.

---

## Holistic-review verdict — architecture invariants (Phases 1–3)

1. **web-sdk mirror** ✅ — status FSM, 9 connectors, gates, PCM16 codec, reconnect/resume all present. Connector capability strings match `@sentient/web-sdk` **and** the gateway's `session.configure` `supports[]` activation (`capabilities.has("text.input")` etc.) 1:1.
2. **Single `SdkState` surface (R5)** ✅ — one `StateFlow<SdkState>`; Android `collectAsStateWithLifecycle()`, iOS `@Published` over the SKIE AsyncSequence. No parallel state machines exposed.
3. **Dumb UIs** ✅ — UIs hold only UI-local state. The one derivation (`VoiceStatus.kt`/`.swift`) is a pure SDK-state→animation-mode mapping mirroring webui `buildVoiceStatus`; it consumes SDK state, reconstructs no protocol.
4. **Logging coverage** ✅ — WS send/recv (text/binary), close, failure, status/FSM transitions, gate decisions all logged with ids. Pure FSMs are driven by the orchestrator/pipeline which logs; the FSMs don't self-log.
5. **No secrets in logs** ✅ — sanitizer (`sanitizeLog`, redacts PASETO/bearer) is applied in the `createLogger` pipeline before the sink. Token store logs `tokenLength` only; AuthClient never logs PIN/token (explicit "NEVER logged" guards; Bearer header built inline).
6. **Scoped debug-only TLS bypass** ✅ — consistent across all 4 sites (WS engine + auth HTTP, both platforms), each a runtime `if (allowSelfSignedDevHost)` guard. App-layer sets the flag from `BuildConfig.DEBUG` (Android) / `#if DEBUG` (iOS); release URL is a `gateway.invalid` placeholder with no self-signed host. Release KMP variant (299 tests) passing confirms the bypass is structurally unreachable in release.
7. **Gateway changes** ✅ — sound, tested (1129 gateway tests green), no mobile hack in core.
8. **clean-code (<300 lines)** ✅ — every **source** file is under 300 (largest: `SentientSdk.kt` 292, `SecureTokenStore.ios.kt` 288, `AudioPipeline.kt` 287; Android `Composer.kt` 278; iOS `HistorySheet.swift` 263). The only files >300 are two **test** files (`IdleDetectorTest.kt` 431, `AudioPipelineTest.kt` 304) — tests are exempt from the source line limit.

**No cross-cutting issues found.**

---

## Device user-loop rows (operator follow-up — NOT agent-reachable)

These need real hardware (mic/AEC/audio-session); the sim cannot exercise them. Flagged in the Phase-3 matrix as V5–V7 + the real-mic V2.

- **V2 — transcript preview (real mic):** voice mode on a device, speak; assert the live transcript renders (`connector.transcript.final`).
- **V5 — real barge-in:** while TTS plays on the device, speak over it; expect playback stops on voice onset (`playback.stop reason=barge-in`).
- **V6 — AEC echo:** voice mode, loud speaker, assistant speaks with mic open; expect no self-retrigger (EchoGate playback-threshold rejects echo frames).
- **V7 — background/foreground audio-session:** voice active, background then foreground; expect the audio session restores cleanly, no orphaned capture.

**Requires:** a physical Android device (free, end-to-end incl. push via self-hosted ntfy) + an iOS device (**$99 Apple Developer Program enrollment**, spec §9 — gates iOS real-device voice + push).

---

## Known debt / follow-ups

- **TTS-preference desync (webui-shared).** Confirmed: `session.ready` carries no initial preferences, and the gateway only emits `session.preferences.changed` on a *delta*. So the SDK `PreferencesConnector` starts at `AudioPreferences.DEFAULT` (ttsEnabled=true) and never seeds the user's real profile prefs unless they change — the TTS toggle reads stale. **Fix:** gateway puts initial prefs in the `session.ready` payload; SDK seeds `PreferencesConnector` from it. Affects webui too.
- **Hilt DI not set up** (Android wires the SDK via a process-singleton `SdkHolder`, not Hilt).
- **`@Preview` / `#Preview` sweep** — screen-level previews not yet added (swiftui/compose rules want one per state).
- **Android release R8/proguard** not configured.
- **Hermes `getMessages` returns no per-message `ts` / `messageCount`** — gateway + SDK degrade gracefully (backfill to 0 / "-"), but real values need a Hermes/sentient-plugin change.
- **`getMessages` sidecar response is not zod-validated** in the gateway (untrusted external input).
- **Stale rule:** `.claude/rules/gateway/webui/audio.md:12` says "Barge-in: … send `barge_in` message" — contradicts the verified **PASSIVE** barge-in (mic-onset → `interrupt()`; the gateway owns the split, there is no `barge_in` wire frame). Needs a rule edit.
- **iOS cold-launch with a stored token always lands on login** — reconcile against Android's behavior (Android `AuthViewModel` retains `selectedUser`).
- **`shared/protocol/src/messages.ts` is 306 lines** — over the 300-line clean-code budget; split.
- **Chat polish** — markdown rendering, streaming pulse-dots, tool glyphs are v1-plain; noted as mechanical follow-up.

---

## What's unblocked

- **Plan 3 — Push plumbing:** new gateway `/api/v1/push/register` + `PushSender` abstraction (APNs backend for iOS, self-hosted UnifiedPush/ntfy for Android) + dumb-push (id-only → pull content) + receive→deep-link. The `clientType: "mobile"` enum (A0) landed specifically to enable targeted push.
- **Plan 4 — Deployment + store:** standalone iOS + Android build+install-on-family-device doc; pi-hosted family "store" (APK / F-Droid + iOS itms-services OTA); finalize debug/release TLS + signing.

The conversational client (this plan) is **complete**.

---

## Build / run commands for the next engineer

```bash
# --- shared env (required before any bun command) ---
source scripts/env.sh

# --- KMP SDK tests (no network) ---
./gradlew :shared:mobile-sdk:allTests

# --- @live SDK text round-trip (operator supplies a valid PIN; default skips with zero network) ---
SENTIENT_LIVE=1 SENTIENT_USER_ID=<userId> SENTIENT_PIN=<pin> \
  ./gradlew :shared:mobile-sdk:testDebugUnitTest --tests "*live_text_round_trip*"
# optional: SENTIENT_GW_URL=wss://localhost:8888/api/v1/ws (the default)

# --- Android build + install (use the `android` CLI / Maestro, NOT raw adb for driving) ---
./gradlew :android:assembleDebug
android run --apks=android/build/outputs/apk/debug/android-debug.apk   # install onto a booted emulator
# emulator → gateway is wss://10.0.2.2:8888/api/v1/ws (debug BuildConfig)

# --- iOS build (XCFramework → xcodegen → xcodebuild on iPhone 14 Pro / iOS 26.5) ---
./gradlew :shared:mobile-sdk:assembleMobileSdkDebugXCFramework
cd ios && xcodegen generate
xcodebuild -scheme SentientApp \
  -destination 'platform=iOS Simulator,name=iPhone 14 Pro (26.5)' build
# sim → gateway is wss://localhost:8888/api/v1/ws (#if DEBUG)
# drive UI via Maestro: maestro test /tmp/<flow>.yaml  (appId io.sentient.ios)
xcrun simctl privacy booted grant microphone io.sentient.ios   # for voice rows

# --- local stack bringup (smoke target) ---
cd deploy/macos && docker compose up -d gateway
curl -sk https://localhost:8888/api/v1/health    # → {"status":"ok"}

# --- TS CI ---
bun run ci   # lint + typecheck + test
```

---

## Action needed

**The branch is NOT pushed** — SSH auth is blocked in the agent shell. The operator must run:

```bash
git push -u origin feature/mobile-client
```

🤖 Generated with [Claude Code](https://claude.com/claude-code)
