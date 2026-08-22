# Sentient — Android client

Native Android client for Sentient (the family voice assistant). A **thin Jetpack
Compose UI over the shared KMP SDK** (`shared/mobile-sdk`): transport, session/audio
state, reconnect, opus, and logging all live in the SDK — this module is UI + DI +
navigation only. STT/TTS are server-side; there is no on-device wake word in v1.

- **App id:** `io.dev32.sentient` (`.debug` suffix on debug builds) · **namespace:** `io.sentient.android`
- **Version:** `0.0.1` (`versionName` in `build.gradle.kts`)
- SDKs (compile/min/target) come from the version catalog (`gradle/libs.versions.toml`).

## Architecture

Layering — dependencies flow inward only:

```
blackbox SDK (shared/mobile-sdk)
  → stateless repositories            (shared/mobile-data .data)
    → usecases (combine/transform)    (shared/mobile-data .usecase)
      → one thin ViewModel per screen (this module)
        → Compose UI
```

- **ViewModels are thin** — per-screen + view-local state only; all combine/transform
  logic lives in shared usecases. A VM never touches the SDK or a repository directly.
- **A conversation is a route.** Top-level nav is a typed route graph
  (`navigation-compose`); changing the `sessionId` route arg rebuilds the screen + its
  VM. That recreation IS the per-screen cleanup boundary — never reset state in place.
- **Three scopes:** App (process-lived config/token) · **Connection** (the SDK + socket +
  usecase graph, alive while authenticated, survives navigation — `UserSessionManager`) ·
  Screen (the per-route VM).
- **DI = Koin** (runtime, no annotation processor — the build forbids KSP/codegen DI).
  The shared core stays framework-free (hand-written `ChatComponent` factory); Koin only
  manages Android VM/connection lifecycle. See `.claude/rules/android/android-di.md`.
- **Offline-first:** a send is optimistic — it enqueues to an in-memory outbox and returns
  immediately (`queued → sent`), flushed on connection-ready. Background keeps the socket;
  foreground sends a one-shot liveness probe and reconnects only if it's dead.

## Layout

```
android/src/main/kotlin/io/sentient/android/
  di/           Koin modules + UserSessionManager (connection scope)
  nav/          route graph (AppNavHost, ChatHost)
  presence/     PresenceCoordinator (ProcessLifecycle foreground/background relay)
  chat/         ChatViewModel + Compose (composer, message bubbles, banners, tool pills, voice)
  history/      HistoryViewModel + the side-drawer past-chats panel
  theme/        Dusk design tokens + typography
```

## Build & run

Source the project env first (provides `bun` + paths used by the gradle hooks):

```bash
source scripts/env.sh
./gradlew :android:assembleDebug          # build the debug APK
./gradlew :android:installDebug           # install to a connected device/emulator
./gradlew :android:testDebugUnitTest      # JVM unit tests (ViewModels, reducers, mappers)
```

Point the app at a gateway via the build config / in-app backend resolution; the default
is the dev gateway running on this host (see the root `deploy/` docs).

## Calendar V2 overlays

`settings/calendar/CalendarOverlays.kt` contains controlled preview, Add/Edit,
recurrence-scope, delete, conflict, offline, permission, and outcome sheets. The Compose
surface forwards exact shared `EffectiveOccurrence` and `CalendarMutationDraft` values;
it does not access storage or transport.

The V2 editor extends the reference Add sheet with the supported production fields:
description, all-day/timed start and end, UI-only input time zone, private/household
scope, visibility, importance, group, tags, and structured recurrence (frequency,
interval, weekdays, count/until). Identity, revision, recurrence mutation scopes,
conflict policy, and online write gates remain shared-owned. Unsupported prototype
place, reminder, member-owner, and color semantics are intentionally absent.

Visual review uses the exact served reference at
`sentient-design/design/mobile/calendar.html`, whose implementation is
`sentient-design/components/mobile/sentient-mobile.js`, at both 390×844 and 430×932.
Open `CalendarOverlayPreviews.kt` and compare preview, Add, timed/all-day Edit,
recurrence scope, delete confirmation, conflict, offline, permission/error, and
large-font previews directly against those viewports. The adapted native contract keeps
the Dusk paper surface, 26dp top corners, 42×4 handle, 84% maximum height, 48dp actions,
Terra primary action, internal IME-safe scrolling, safe-area padding, and tonal scrim.

## Testing

- **JVM unit** (`testDebugUnitTest`): thin VMs, reducers, pure usecases with fake transport
  — no Android framework, `runTest` + `TestDispatcher` for time.
- **Compose UI / Robolectric** for view tests; **Maestro** `.yaml` flows for agent-driven
  E2E against an emulator (login → chat → send → switch → logout). Faults are armed via an
  `adb` broadcast in debug builds.
- Fakes over mocks at boundaries; pass fakes through the same constructors production uses.

## Rules

Project conventions live in the repo root `.claude/rules/android/*.md` (Kotlin, Compose,
coroutines/Flow, DI, MVI architecture, testing) and the cross-platform `.claude/rules/mobile/*.md`
(navigation, lifecycle, offline). Read those before changing this module.
