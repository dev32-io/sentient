# Mobile Client v1 — Design Spec

**Date:** 2026-06-01
**Branch:** `worktree-mobile-client` (worktree at `.claude/worktrees/mobile-client`)
**Status:** Design approved; pre-plan. Companion research: `docs/research/2026-06-01-mobile-client-research.md`.
**Next:** writing-plans → implementation plan with concrete e2e matrix per phase.

## 1. Goal & scope

Build native iOS + Android clients for Sentient, sharing one Kotlin Multiplatform (KMP) SDK that mirrors the role of `@sentient/web-sdk`. Clients are dumb consumers of the gateway. Mobile ships **before** the ESP32 cube because it's pure software and unlocks push (→ gateway-as-agent-scheduler later).

**v1 in scope:**
- Full **voice parity with webui** (mic capture → WS PCM uplink → server STT → TTS playback → barge-in).
- **Text chat** + chat **history**.
- **Thin settings**: app version + logout.
- **Push plumbing** (register device token, receive push, deep-link to a chat) — **no gateway scheduler yet** (v2).
- Auth mirroring webui (avatar list + PIN).
- Logging per project principle (every boundary I/O, FSM transition, decision), platform-stream only.

**v1 explicitly NOT in scope:** gateway push-scheduler / agent tasks; on-device or OS-dictation STT; rich settings (soul/household/voice/model panels); multi-account switching; iOS real-device push (gated on paid Apple enrollment — see §9).

## 2. Locked decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Mobile before cube | Pure software; unlocks push; no hardware loop. |
| D2 | **KMP shared SDK + native UI** (SwiftUI + Compose); **not** shared UI (Compose Multiplatform) | Hard surface is native plumbing, not UI. Shared-UI iOS risks (text-input/IME, debugging blindness, no Cupertino) concentrate exactly where we're paranoid; payoff is ~1 screen. See research doc §4. |
| D3 | **Fat SDK** (Approach A): port all portable logic + WS transport + reconnect + connectors + state machines to KMP commonMain | 1:1 web-sdk mirror; protocol/reconnect changes write-once. The trickiest code (reconnect/resume) stays single-sourced. |
| D4 | **No on-device STT.** Reuse server STT over WS, same path as webui | OS dictation w/o turn detection = the system keyboard mic reinvented. Server STT already gives VAD + Smart-Turn + barge-in. |
| D5 | Full voice parity in v1 | User choice. Pulls native audio + OS AEC + audio FSM up front. |
| D6 | Push plumbing in v1, scheduler in v2 | Prove the pipe (token → receive → deep-link) without building the scheduler. |
| D7 | Auth mirrors webui (avatar + **OS numpad** PIN), token in Keychain/KeyStore | Gateway auth already built; zero new auth work. OS numpad over webui custom numpad — native feel, less code. |
| D8 | Logging = shared tagged logger → logcat / os_log only; I tail via CLI | Matches webui console-only philosophy; correlate to gateway by sessionId/cycleId. No log shipping. |
| D9 | iOS UI automation = **Maestro** (XCUITest/WDA, no idb); **android CLI** for Android | idb's Python client is abandoned + Apple-Silicon/Xcode-26 pain. Maestro dropped idb since 1.18.0. Validated on Xcode 26.5 + iOS 26.5 (§8). |
| D10 | Adopt dev32-io agentic-dev-harness rules, **adapted** (not blind-installed) | Same rule+details+tiered structure as sentient; but v0.1 has stale/broken Android pins + standard-app (non-KMP) assumptions + language globs. Cherry-pick + re-scope + audit-fix. |

## 3. Architecture

### 3.1 Repo layout
```
shared/mobile-sdk/          ← KMP module (Gradle). Mirrors @sentient/web-sdk.
  src/commonMain/kotlin/    ← ported portable logic (~1,100 lines from web-sdk)
  src/androidMain/kotlin/   ← actual: mic, playback, push, secure-store, log sink, WS engine
  src/iosMain/kotlin/       ← actual: AVFoundation, Keychain, APNs, os_log, Ktor Darwin
  → outputs: .aar/klib (Android) + XCFramework (iOS, SKIE-processed)
android/                    ← Android app (Compose UI), depends on :shared:mobile-sdk
ios/                        ← iOS app (SwiftUI), links mobile-sdk XCFramework via local Swift Package
```
- `shared/` is a bun/TS workspace today; KMP is Gradle — coexist, separate build systems. Root `settings.gradle.kts` wraps `shared/mobile-sdk` + `android`.
- iOS consumes the XCFramework via a local Swift Package wrapper (cleanest for agent-driven `xcodebuild`).
- **SKIE** Gradle plugin on the iOS output: `Flow`→`AsyncSequence`, `suspend`→`async`, sealed→Swift enum. The enabler for idiomatic, dumb-consumer Swift.

### 3.2 Shared SDK surface (commonMain) — 1:1 web-sdk mirror
**Ported near-verbatim (pure logic):**
- `SentientSdk` orchestrator + status FSM: `disconnected → connecting → authenticating → ready → reconnecting → error`.
- WS transport + reconnect (backoff/jitter/maxAttempts/probe-ping) + session-resume.
- All connectors: user-audio-input, assistant-audio-response, user-text-input, preferences, cognition-status, conversation-history, task-status, inflight-message, sessions.
- State machines: **EchoGate, SpeechGate, AudioPreRollRing, IdleDetector** (pure → direct ports).
- PCM16↔Float32 codec, typed event emitter, error classifier, log sanitizer.
- Auth HTTP client (`/auth/users`, `/auth/login`, `/auth/me`).
- `createLogger(tags)` → `debug/info/warn/error(message, props)`.

**`expect`/`actual` platform shims (thin):**
| Shim | Android | iOS |
|---|---|---|
| AudioCaptureAdapter | AudioRecord (VOICE_COMMUNICATION) | AVAudioEngine (VPIO) |
| AudioPlaybackAdapter | AudioTrack | AVAudioEngine / AVAudioPlayerNode |
| SecureTokenStore | EncryptedSharedPrefs / KeyStore | Keychain |
| PushTokenProvider | FCM | APNs |
| LogSink | logcat | os_log (subsystem = bundle id, category = tag) |
| WebSocket engine | Ktor OkHttp | Ktor Darwin |

Consumer apps see one state surface + commands: `connect() / disconnect() / sendText() / interrupt() / startMic() / stopMic()`. UI never touches protocol.

### 3.3 Wire contract (unchanged from webui)
- WS `wss://<gateway>/api/v1/ws`. First frame `{type:"auth", token}` → `{type:"auth.ok", user}`. Then `session.configure` → `session.ready {sessionId, audioEncoding, inputSampleRate, outputSampleRate, …}`.
- JSON control frames + raw **PCM16 LE** binary frames (mic uplink after `audio.start`/`audio.end`; TTS downlink).
- Session resume on reconnect (`session.created` / `session.switched`).

## 4. Full-voice audio path
```
mic → [native capture] → PCM16 → SpeechGate(shared) → WS binary uplink (after audio.start)
gateway STT → transcript → conversation connectors → UI
gateway TTS → WS binary PCM16 → EchoGate + AudioPreRollRing(shared) → [native playback]
barge-in: mic onset → interrupt() → clear playback queue + abort cycle
```
- **AEC**: OS hardware AEC replaces webui's WebRTC loopback — iOS `AVAudioSession .playAndRecord` + voice-processing IO; Android `VOICE_COMMUNICATION` source + `AcousticEchoCanceler`. Shared **EchoGate** stays as software second stage.
- **Audio FSM** (inactive→listening→user-speaking→processing→assistant-speaking→interrupting) lives in shared, drives both UIs identically; per the event-driven UX-state rule (state→UX binding, no free-running loops).
- **RISK — sample rate**: `session.ready` dictates rates (STT likely 16k); device mic is 44.1/48k. Native layer MUST request 16k capture or resample on-device. Mismatch = garbled STT. Pin in mobile-sdk details.

## 5. Auth + push
**Auth (zero new gateway work):**
- `GET /api/v1/auth/users` → avatar list → OS numpad PIN → `POST /api/v1/auth/login {userId,pin}` → `{token,user}` → token to Keychain/KeyStore → WS `{type:"auth",token}`.
- Launch: `GET /api/v1/auth/me` refresh (7-day TTL). Logout (thin settings) clears token.

**Push plumbing (one new gateway endpoint):**
- Client registers APNs/FCM → device push token → `POST /api/v1/push/register {token, platform}` (NEW; today's `/devices/` is Signal-only) → gateway stores per-user.
- Receive: payload carries deep-link (e.g. `sessionId`) → tap → open app → navigate to that chat.
- Gateway-side: token storage + a manual "send test push" script. **No scheduler.**

## 6. Native UI (copy webui)
- SwiftUI (iOS) + Compose (Android), both dumb reflections of the SDK voice FSM.
- **Shared design tokens** (dusk palette / type / spacing / radius / motion — exact values from webui `styles/tokens/*`) live in `shared/mobile-sdk` as constants; both UIs read identical values → visual parity without a shared renderer.
- **v1 screens:** Login (avatar list + OS numpad) → Chat (message list + composer: mic/send/interrupt/tts; speaking-wave; avatar listen/think/speak states) → History (native drawer/sheet) → Settings (version + logout).

### 6.1 Mobile layout adjustments (from webui)
| webui pattern | mobile fix |
|---|---|
| Topbar breadcrumbs "Sentient·My Home·Conversation" | title-only / drop crumbs @390 |
| "14 devices online" chip | hide on mobile (not v1) |
| Settings 2-column sidebar+pane | native push-nav list (thin v1 → trivial) |
| Session drawer 360px | native ModalDrawer / sheet |
| Tool pill strip overflow | ensure horizontal scroll |
| **Safe areas / notch / home indicator** | native insets (new vs web) |
| **Keyboard avoidance for composer** | `imePadding` (Compose) / keyboard-safe (SwiftUI) |
| Status bar over dusk palette | dark-content status bar |
| Tap targets | 44pt / 48dp min |

## 7. Logging
- Shared `createLogger(tags)` → `LogSink` expect/actual → logcat / os_log. Tags `["sentient","mobile-sdk",…]`, `["sentient","ios"/"android",…]`.
- Full coverage: every WS msg in/out, every FSM transition (status + audio + speech/echo gate), every decision (reconnect, barge-in, gate open/close, resume), each with `sessionId`/`cycleId`/`utteranceId`.
- Sanitizer (ported from gateway, redacts PASETO/tokens) runs in commonMain before the sink.
- Tail: `adb logcat` (Android) + `xcrun simctl spawn booted log stream --predicate 'subsystem=="<bundle>"'` (iOS). Correlate to gateway logs by id.

## 8. Dev-driving (agentic loop) — VALIDATED 2026-06-01
- **Android**: `android` CLI — emulator start · `run --apks` · `screen capture --annotate` · `screen resolve` (semantic→tap) · `layout --diff` (UI tree JSON) — plus `adb logcat`. ✅ screen-capture + layout confirmed against booted Pixel_3a_API_34 (Play image → FCM-capable).
- **iOS**: `xcodebuild` · `simctl` (boot/install/launch/`io screenshot`/`push`/`privacy grant microphone`/`log stream`) · **Maestro** for tap/type. ✅ Maestro built WDA + drove **iPhone 14 Pro / iOS 26.5** on Xcode 26.5, exit 0. No idb.
- **Local stack reach**: deploy/macos gateway `wss://localhost:8888`, health `{"status":"ok"}`. iOS sim → `localhost:8888` ✅ reached; Android emulator → `10.0.2.2:8888` ✅ reached. TLS handshake completed both sides (self-signed warning).
- **TLS — RESOLVED via debug-build bypass scoped to dev host** (no cert install): the self-signed cert is a macOS-local-stack-only issue; **prod pi has a valid cert**. Android: `network_security_config.xml` `<debug-overrides>` (or a debug-only trust-all `X509TrustManager` on the Ktor OkHttp engine). iOS: `#if DEBUG` URLSession delegate accepting the dev host's self-signed cert (or a debug-only ATS exception). **Release builds ship no bypass** → pi cert validates via system trust. Wire in P0c.
- **E2E matrix is the contract** (harness model + our e2e-testing rule): rows × phone viewport × platform; happy + sad (reconnect, auth-fail, barge-in, background/foreground, push-receive→deep-link). **Device-only rows** flagged for user-loop: real voice/AEC + barge-in (fake sim mic), iOS real-device push.

## 9. Apple account constraint
- **Current state: Xcode configured with personal team — sufficient for simulator-first dev** (and short sideloads). **Assume paid enrollment lands before family deploy.**
- Free personal team: build/run on **simulator** unlimited; `simctl push` to sim works (no APNs). Real-device install = **7-day expiry + 3-device cap**; **push on real device is BLOCKED** (entitlement needs paid program).
- **$99/yr Apple Developer Program** → private family distribution (Ad-Hoc / development, 100 devices, ~1yr profiles, **no store**), push enabled, no expiry, TestFlight internal. Not store submission.
- Self-distribution removes the **review gate** (private APIs run in Ad-Hoc builds) but NOT the **OS sandbox** (entitlement/TCC walls — e.g. always-on background mic — stay enforced regardless of pay/sideload). Agent-scheduler/background rides legit APIs (silent/VoIP push wake, BGTaskScheduler), no banned API needed.
- **Plan impact**: iOS = simulator-only until enrollment; SDK push connector + gateway endpoint built regardless; iOS real-device push + device voice/AEC smoke gated behind the $99 decision. **Android is free end-to-end** (Firebase Spark + FCM, real devices, push).

## 10. Testing (defensive-only, per testing.md)
- **Shared SDK**: pin wire/protocol contract (mock *exact* gateway frames in/out — no convenient envelopes), FSM/invariants (status machine, speech/echo gate, reconnect/resume), security (token store, sanitizer, auth). NO factory/DI/type/constant tests.
- **Native UI**: no unit wiring tests — e2e (Maestro / android CLI) owns UX verification.
- Borderline tests deleted, not kept.

## 11. Phasing (plan skeleton — each phase done = its e2e rows green)
- **P0a — Mobile platform rules**: adapt harness `platforms/{android,ios,mobile}` rules + paired details into `.claude/rules/{android,ios,mobile}/` + `agents/docs/<sub>/`. Re-scope `paths:` globs to subproject paths (`android/**`, `ios/**`, mobile→all three incl. `shared/mobile-sdk/**`). Apply harness audit fixes (AGP 9.2, Kotlin 2.1.x, compileSdk 36, Compose-compiler plugin, Java 21 — verify latest at scaffold time). KMP-adapt (android Hilt/MVI/Compose rules scope to UI app only; transport/state live in shared). Lift `claudeMdExcludes` for android/ios. Don't duplicate base rules.
- **P0b — mobile-sdk (KMP) rules**: author new `.claude/rules/mobile-sdk/*.md` + details, `paths: shared/mobile-sdk/**`: commonMain-purity, expect-actual-contract, kmp-gradle (catalog + XCFramework/SKIE export), coroutines-flow-surface, web-sdk-mirror-contract.
- **P0c — Scaffold**: KMP module + android + ios skeletons; Gradle wrapper + XCFramework + SKIE; **Maestro WDA smoke re-confirm on 26.5** (already green); self-signed cert trust into sim/emulator; sim/emulator ↔ host-gateway connectivity green.
- **P1 — Shared SDK core**: WS transport + auth + reconnect/resume + status FSM + logger + connectors (port web-sdk). Contract tests. Drive: text round-trip on local stack.
- **P2 — Text chat UI** both platforms (login → chat → history → thin settings). Text e2e matrix. Design-in the in-app version-check hook (cheap family-store updates later, §12.2).
- **P3 — Voice**: native capture/playback shims + audio FSM + gates + OS AEC. Sim e2e (UI/connect/transcript); device user-loop for AEC/barge-in.
- **P4 — Push plumbing**: token connector + gateway `/push/register` + receive→deep-link. iOS sim (`simctl push`) + Android device e2e.
- **P5 — Polish + layout pass + deployment doc + handoff**: write the standalone iOS + Android deployment doc (build + install on family device, §12); finalize debug/release TLS config; layout matrix pass.

## 12. Deployment & family distribution

Polished standalone deployment doc is a **P5 deliverable** (written once real bundle ids + signing exist). Strategy captured here.

### 12.1 Build + install on a family device (outline)
- **Android**: `./gradlew :android:assembleRelease` (or debug for dev) → signed APK → install via `android run --apks=…` (dev) or sideload (`adb install` / browser download + "install unknown apps").
- **iOS**: `xcodebuild -scheme … -configuration Release archive` → export signed `.ipa` (development / ad-hoc profile, family UDIDs registered) → install via Xcode Devices, Apple Configurator, or OTA (§12.2). Personal team = simulator + 7-day sideload only; paid program = proper family deploy.

### 12.2 Family home-network "store" (explored — pi is the host)
The pi is always-on family infra and already has a **valid TLS cert** — which iOS OTA install *requires*. Serve one landing page from the pi:
- **Android (easy, true auto-update)**: host `app.apk` on the pi. In-app updater checks pi for latest `versionCode` → downloads → `PackageInstaller` self-update (needs `REQUEST_INSTALL_PACKAGES`). Alternative: host a small **F-Droid repo** on the pi → family installs F-Droid client → automatic updates. Real "family store."
- **iOS (works, Apple-limited)**: OTA **ad-hoc** — host `app.ipa` + `manifest.plist`, install via `itms-services://?action=download-manifest&url=https://<pi>/manifest.plist`. Constraints: family device **UDIDs registered** in the ad-hoc profile (paid, 100/yr); **no silent auto-update** → in-app "update available" check deep-links the install URL for one-tap reinstall. New device = regen profile + rebuild.
- **Unified landing page** on the pi: Android APK / F-Droid entry + iOS itms-services link + current version. Distribution rides existing pi infra; **out of v1 scope** (post-app), but the in-app version-check hook should be designed in P2 so updates are cheap later.

## 13. Open items / flags carried to plan
1. ~~TLS~~ RESOLVED — debug-build bypass scoped to dev host; release uses pi's valid cert (§8). Wire in P0c.
2. Audio sample-rate match/resample (P3) — device mic vs `session.ready` rate.
3. Apple paid enrollment — **assumed incoming**; personal team carries simulator-first dev now. Gates iOS real-device push + device voice smoke (§9).
4. FCM Firebase project provisioning (P4) — free; needed for Android real-device push.
5. KMP Swift-interop + Compose/CMP/AGP/Kotlin versions move fast — verify pins at scaffold time (per verify-pinned-versions).
6. Verify `android screen resolve` tap on a real app target (validated capture+layout; resolve is same mechanism).
7. Deployment doc (iOS + Android build+install on family device) — **P5 deliverable** (§12).
8. Family home-network store (pi-hosted) — explored (§12.2); post-v1, but design the in-app version-check hook in P2.
```
