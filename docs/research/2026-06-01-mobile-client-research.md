# Mobile Client Research — Framework, STT, Push

**Date:** 2026-06-01
**Branch:** `feature/mobile-client-research`
**Status:** Research / pre-planning. No code. Detailed planning deferred.

## Question

Start mobile client (iOS + Android) **before** the ESP32 cube? And if so, build native per-platform, or cross-platform (React Native / Flutter / Kotlin Multiplatform)?

Drivers raised:
- Phone push notifications turn the gateway into an **agent scheduler** (e.g. morning daily-briefing task → notify → tap to open chat / read artifact).
- Client should stay a **dumb consumer** of the gateway, mirroring the `@sentient/web-sdk` model.
- Paranoia about cross-platform frameworks — easy start, platform-specific traps later (especially iOS).
- Idea floated: lean on **OS-level dictation** for free on-device STT, avoid touching the local STT service.

## Findings

### 1. Mobile-before-cube — yes

Phone is pure software; ships faster than cube (which needs firmware + hardware smoke loop regardless). Push unlocks the agent-scheduler vision. No dependency forces cube first. Proceed with phone.

### 2. OS-level dictation idea — **dropped**

The original plan was to use iOS `DictationTranscriber` / Android on-device `SpeechRecognizer` for free on-device transcription.

Killed by a sharp realization:

- **OS dictation with no turn detection = the system keyboard mic button, reinvented.** User taps field → keyboard mic → talks → send. Already free, already there, zero code, better UX than anything we'd build. Building a dictation integration to match it is pure waste.
- ChatGPT/Claude apps do **not** use OS dictation either — they record audio and send to Whisper server-side. We weren't even copying them.
- OS dictation gives raw text only. We lose VAD, **turn detection (Smart-Turn v3)**, and **barge-in** — the entire value of our tuned pipeline. It's the useless middle: costs voice-mode effort, delivers keyboard-mic capability.

**The thing both sides initially skipped:** we *already have server STT.* webui streams audio over WS → gateway runs Silero VAD + Smart-Turn v3 + SenseVoice → transcript + turn events back. **The phone is just another WS audio client.** Reuse the exact webui audio path → full turn detection + barge-in for free, zero new STT code (on-device or otherwise). The "avoid messing with the local STT service" worry inverts: on-device is *more* work for *less* capability. The local service is the asset.

**Resolved STT model:**
- **Phone v1**: WS audio client mirroring webui. Server STT owns turn detection + barge-in. Plus OS keyboard mic for quick typed input (no code — just the keyboard into a text field).
- **No on-device STT. No OS dictation API. Deleted from scope.**
- Open question for planning: battery / background-mic limits on a phone holding an open mic + WS — verify the webui audio path survives mobile backgrounding constraints.

### 3. Framework — Kotlin Multiplatform (KMP), shared **logic only**

The "simple dumb client" framing hid where the work is. Real surface:

| Concern | Shareable? | Notes |
|---|---|---|
| WS transport + reconnect | ✅ shared logic | easy anywhere |
| Protocol codec (control + binary audio) | ✅ shared | |
| Audio/session state machine | ✅ shared | non-trivial, worth share-once |
| SpeechGate latch logic | ✅ shared | |
| Logger (`createLogger` equiv) | ✅ shared | |
| Chat UI (toggle-to-talk + transcript) | ⚠️ ~1 screen | simple, but see §4 |
| Mic capture / playback | ❌ native | `AVAudioEngine` vs `AudioRecord` |
| Push register (APNs / FCM) | ❌ native | |
| Background mode / permissions | ❌ native | |

~70% of the *hard* part is platform-native plumbing, not shared UI. That **inverts the RN/Flutter value prop** — they share UI but force bridging every native thing, which is exactly the "easy-start, gotcha-later" trap we fear. KMP shares the easy part (Kotlin logic) and gives **first-class native API access with no bridge** for the hard part.

- Compose Multiplatform iOS **stable since 1.8.0 (May 2025)**; latest 1.11.0 (May 2026).
- KMP maintenance reported ~25% lower than RN (RN breaking-update churn is the documented pain).
- Counter-cases where KMP would lose: JS-heavy team → RN (talent pool); pixel-identical cross-platform UI as a hard requirement → Flutter. Neither fits us.
- KMP risks: smaller talent pool; Swift interop still maturing (direct Swift export landed Kotlin 2.2.20, stable interop targeted 2026 — **verify before grounding**).

### 4. Shared **UI** (Compose Multiplatform on iOS) — **skip for v1**

Paranoia about iOS + cross-platform is justified specifically for shared UI. Logic-sharing is safe (compiles to native, no rendering); UI-sharing on iOS has real teeth.

iOS Compose MP gotchas (current field reports, 2026):

| Gotcha | Bites us? |
|---|---|
| No Cupertino kit — all Material | Soft. Our design is custom (match webui), not chasing iOS-native look. |
| **Text input edge cases — IME, multi-lang, keyboard** | **HARD** — our typed-input path leans on the OS keyboard mic + IME, i.e. exactly Compose-iOS's weakest zone. Self-inflicted risk. |
| Accessibility not at SwiftUI parity | Medium — family assistant, VoiceOver may matter. |
| **Xcode can't inspect Compose views; XCTest blind** | **HARD** — the iOS-only weirdness we fear is the bug class we'd lose our best debugging tools for. Compounds paranoia. |
| CPU/mem on heavy lists, old devices (issue #4912) | Soft — transcript is short; watch old iPhones. |
| +15–20MB binary (Kotlin/Native runtime) | Cosmetic. |
| SwiftUI/UIKit interop "not first-class" | Medium if embedding native bits. |

**Decision:** shared SDK **yes**, shared UI **no** (for v1). Payoff of shared UI is small (~1 screen); risk concentrates on iOS exactly where we're paranoid, and removes native debugging.

**Consistency without shared renderer** comes from:
1. Shared SDK drives identical state → both UIs are dumb reflections of one state machine; behavior can't diverge.
2. Shared design tokens (colors/spacing/type as a small constants file, can live in the SDK) → both native UIs read the same values.
3. Two thin views (SwiftUI + Compose) off one contract; ~1 screen each, drift is bounded.

Revisit Compose MP if the app grows to many screens — then write-once pays and we re-weigh.

## Proposed architecture (for detailed planning)

```
shared/mobile-sdk (Kotlin)        ← mirrors @sentient/web-sdk role
  ├─ WS transport + reconnect
  ├─ protocol codec (control + binary audio)
  ├─ session/audio state machine
  ├─ SpeechGate latch
  ├─ logger
  ├─ design tokens (shared constants)
  └─ expect/actual: mic capture, playback, push register, permissions
  │
  ├─ XCFramework  → iOS app   (SwiftUI, ~1 screen, binds via SKIE)
  └─ aar/klib     → Android app (Compose, ~1 screen)
```

- **SKIE** (Touchlab) maps Kotlin `Flow` → Swift `AsyncSequence`, `suspend` → `async/await`, sealed classes → Swift enums. Key enabler for an idiomatic, dumb-consumer feel in Swift (analogous to how web-sdk feels native in TS). Without it, iOS consumption of coroutines/Flow is the main interop gotcha.
- Single state-machine surface out of the SDK (per `feedback_sdk_single_surface` — VAD/error internal, one stream of states).
- Mic capture behind one `expect fun`, same as web-sdk wrapping `getUserMedia`.

### Push / agent-scheduler

- All three frameworks support FCM (Android) + APNs (iOS). KMP libs: KMPNotifier / Alarmee wrap both in one API.
- Client side is thin: receive payload → display → deep-link into the chat / artifact.
- Real work is **gateway-side, framework-agnostic**: gateway becomes a push sender (needs FCM server key + APNs p8/cert) plus a scheduler that wakes a Hermes cycle, runs the task, pushes the result. Keeps the client dumb as intended.

## Open questions for detailed planning

1. Mobile background constraints on the webui WS audio path — does an open mic + WS survive iOS/Android backgrounding? Battery cost? (relates to `feedback_no_server_heartbeat` — no periodic server pings; visibility-triggered probes.)
2. Voice-mode scope for phone v1 — full barge-in like webui, or text-first chat + push only, with full voice deferred?
3. Gateway push-scheduler contract — schedule format, task→push payload shape, deep-link routing into a chat/artifact.
4. SKIE + XCFramework export build setup — one-time cost; confirm Gradle/CI fit.
5. Verify KMP Swift-interop stability and Compose MP version state at planning time (versions move fast).
6. Auth on mobile — PASETO browser-session model vs a mobile-appropriate token flow (see `sentient-auth`).

## Decisions locked

- Mobile before cube.
- KMP for shared **logic** SDK (`shared/mobile-sdk`), mirroring `@sentient/web-sdk`.
- **Native UI** per platform (SwiftUI + Compose), not Compose Multiplatform shared UI, for v1.
- **No on-device / OS-dictation STT.** Phone reuses the server STT path over WS, same as webui.
- Gateway grows a push-scheduler; client stays a dumb push consumer.

## Sources

- KMP production-ready 2026 — https://www.kmpship.app/blog/is-kotlin-multiplatform-production-ready-2026
- Compose MP 1.8.0 iOS stable — https://blog.jetbrains.com/kotlin/2025/05/compose-multiplatform-1-8-0-released-compose-multiplatform-for-ios-is-stable-and-production-ready/
- Compose MP 1.11.0 — https://blog.jetbrains.com/kotlin/2026/05/compose-multiplatform-1-11-0/
- KMP vs Flutter vs RN CTO guide 2026 — https://medium.com/@avirootinfosolution/react-native-vs-flutter-vs-kotlin-multiplatform-a-ctos-decision-guide-2026-21dc43277cf0
- KMP vs RN (kotlinlang) — https://kotlinlang.org/docs/multiplatform/kotlin-multiplatform-react-native.html
- CMP iOS production field guide 2026 — https://medium.com/@thanhnh98/is-compose-multiplatform-production-ready-in-2026-a-practical-field-guide-b4863748dbe7
- Sharing UI Android/iOS — what actually works — https://mzeus.medium.com/sharing-ui-across-android-and-ios-with-compose-multiplatform-what-actually-works-e3d9cd14609b
- CMP iOS accessibility — https://kotlinlang.org/docs/multiplatform/compose-ios-accessibility.html
- CMP iOS binary size overhead #3632 — https://github.com/JetBrains/compose-multiplatform/issues/3632
- iOS 26 SpeechAnalyzer guide — https://antongubarenko.substack.com/p/ios-26-speechanalyzer-guide
- SpeechAnalyzer vs SFSpeechRecognizer — https://blakecrosley.com/blog/speech-framework-vs-sfspeechrecognizer
- Android speech recognition 2026 — https://picovoice.ai/blog/android-speech-recognition/
- KMP push notifications guide 2026 — https://www.kmpship.app/blog/kotlin-multiplatform-push-notifications-guide-2026
- KMPNotifier — https://github.com/mirzemehdi/KMPNotifier
