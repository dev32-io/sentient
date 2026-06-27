# Mobile Reconnect & Auth Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two mobile reconnect/auth bugs — (1) expired-token auth failure must route to the login screen instead of looping "reconnecting…" forever; (2) a network-path change (VPN→WiFi) must trigger a reconnect so a queued message is not stuck on a dead socket showing a useless "Retry".

**Architecture:** Both fixes live in the KMP `shared/mobile-sdk` classifier and the two native app shells; the SDK already exposes the right reconnect entry (`ensureConnected()`). Bug 1 splits the auth-error classifier so the **handshake auth.error frame** defaults to *terminal* (route to login) while the **sessions REST error** path keeps its allow-list (never spuriously logs out). Bug 2 adds a persistent OS network-path observer in each app shell (iOS `NWPathMonitor`, Android `registerDefaultNetworkCallback`) that calls `component.ensureConnected()` on a meaningful path change, and hardens `retry()` to verify the socket instead of trusting a stale `READY`.

**Tech Stack:** Kotlin Multiplatform (`shared/mobile-sdk`, commonMain + commonTest), Swift/SwiftUI (`ios/`), Kotlin/Compose (`android/`), Apple Network framework (`NWPathMonitor`), Android `ConnectivityManager`.

## Global Constraints

- commonMain MUST NOT import platform APIs (`android.*`, `platform.*`, Foundation, `java.*`). Network observers live in the app shells (`ios/`, `android/`), never commonMain. — `.claude/rules/mobile-sdk/commonMain-purity.md`
- Wire-frame `type`/`code` strings are the gateway contract — mirror exactly, never invent. Gateway `TokenError` codes are `expired | malformed | signature-invalid | wrong-purpose` (`gateway/src/user-auth/types.ts:18`); gateway auth-gate also emits `auth-required | user-not-found | session-limit | auth-timeout` (`gateway/src/session-handlers/ws-auth-gate.ts`). — `.claude/rules/mobile-sdk/web-sdk-mirror-contract.md`
- Every new file imports and uses a tagged logger (`createLogger([...])` / `AppLog(...)`). No bare console/print. Log every state transition + every classifier decision with the value that triggered it. — `.claude/rules/logging.md`
- NEVER log user/chat content at any level. Mobile DEBUG is captured into the uploaded vitals ring; log ids/types/lengths only. — `.claude/rules/logging.md`
- Tunable values (timeouts, debounce) belong in config, not magic numbers. The reconnect/probe timeouts are existing tuned constants — do NOT change them. — `.claude/rules/config.md`, project memory `feedback_tuned_constants`.
- Test bar is defensive-only: keep the Bug-1 classifier test (wire-contract + security boundary). Do NOT add unit tests for the platform network-observer glue (DI/adapter plumbing) — validate it via E2E smoke. — `.claude/rules/testing.md`
- Kotlin: no `!!`; `val` over `var`; sealed/`when` exhaustive. Swift: no force-unwrap `!`; `let` over `var`; `@MainActor` for UI-touching; Swift 6 strict concurrency.
- Work on this `feature/mobile-reconnect-auth-fixes` branch. Atomic commits, `type(scope): description`.

---

## Root Cause Summary (evidence)

**Bug 1 — infinite "reconnecting" on token expiry.** On reconnect with an expired token, the gateway sends `auth.error` frame with `code:"expired"` then closes 1008 (`ws-auth-gate.ts:44,99-101`). The SDK classifier `isTerminalAuthError(code)` only treats `{auth-required, token-validation-failed, user-not-found}` as terminal (`AuthErrorClass.kt:7`). `"expired"` (and `malformed`/`signature-invalid`/`wrong-purpose`) are **not** in the set → classified `NETWORK` → reconnect path, never `authExpired` → never routes to login. Web-sdk does not have this bug — it treats any auth-phase error as terminal and ignores the `code` (`sdk-message-router.ts:165-170`).

**Bug 2 — queued message stuck on "Retry" after a network change.** There is **no** persistent network-path observer in the SDK or either app (only one-shot vitals snapshots: `ios/App/SDK/NetworkProbe.swift`, `android/.../sdk/NetworkType.kt`). When the path changes (VPN→WiFi) under a half-open socket, nothing invalidates it; the SDK sits at `READY` on a dead socket. The only recovery is the foreground probe (`SentientSdk.onForeground()` :547), which fires only on background→foreground and races the send. A send into the dead socket is `markSent` (stays `QUEUED`), and 10 s later `sweepTimeouts()` flips it to `FAILED` → "Retry" chip (`OutboundCache.kt:90-96`). `retry()` then re-sends to the same dead socket because it only reconnects `if !isReady` and the stale socket still reports `READY` (`ios/App/Chat/ChatViewModel.swift:90-93`). Fix: detect the path change and `ensureConnected()` (which probes/reconnects), and make `retry()` verify the socket.

---

## File Structure

- `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/AuthErrorClass.kt` — **modify**: split frame-path (invert default) from Throwable-path (allow-list).
- `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/sdk/AuthErrorClassTest.kt` — **modify**: pin new expectations.
- `ios/App/Session/NetworkPathMonitor.swift` — **create**: persistent `NWPathMonitor` → callback on meaningful path change.
- `ios/App/Session/UserSession.swift` — **modify**: own the monitor; start in `init`, cancel in `shutdown`; callback → `component.ensureConnected()`.
- `ios/App/Chat/ChatViewModel.swift` — **modify**: `retry()` → `component.ensureConnected()`.
- `android/src/main/kotlin/io/sentient/android/presence/NetworkChangeObserver.kt` — **create**: `registerDefaultNetworkCallback` → callback on default-network change.
- `android/src/main/kotlin/io/sentient/android/di/UserSessionManager.kt` — **modify**: own the observer; register on build, unregister in `shutdown`; callback → `component.ensureConnected()`.
- `android/src/main/kotlin/io/sentient/android/chat/ChatViewModel.kt` — **modify**: `retry()` → `component.ensureConnected()`.
- `agents/docs/testing-knowledge.md` — **modify** (Task 6): add the two reusable E2E cases.

---

## Task 1: Bug 1 — split the auth-error classifier (frame inverts to terminal; Throwable stays allow-list)

**Files:**
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/AuthErrorClass.kt`
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/sdk/AuthErrorClassTest.kt`

**Interfaces:**
- Consumes: `SessionsRequestException(val code: String, …)` from `connectors/SessionsConnector.kt:62`.
- Produces (signatures unchanged — only semantics change, so callers `Handshake.kt:95` and `UserSessionManager.kt:78,109` keep compiling):
  - `fun isTerminalAuthError(code: String?): Boolean` — **frame path**: terminal unless code is explicitly retryable.
  - `fun isTerminalAuthError(error: Throwable): Boolean` — **Throwable path**: terminal only for a known credential-invalid code (allow-list).

**Why split:** the same `code` classifier is shared by the handshake `auth.error` frame (an auth rejection — unknown code should route to login) and by `SessionsRequestException` from a `sessions.error` (usually NOT an auth failure — e.g. `not-found`, `rate-limited`; inverting here would log users out on benign session errors). The two need opposite safe-defaults.

- [ ] **Step 1: Write the failing tests**

Replace the body of `AuthErrorClassTest.kt` with (keep the existing package + imports; add any missing):

```kotlin
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.connectors.SessionsRequestException
import io.sentient.mobilesdk.connectors.SessionsTimeoutException
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class AuthErrorClassTest {
    // ── Frame path: auth.error code → terminal unless explicitly retryable ──
    @Test fun frame_known_terminal_codes_are_terminal() {
        assertTrue(isTerminalAuthError("auth-required"))
        assertTrue(isTerminalAuthError("user-not-found"))
        assertTrue(isTerminalAuthError("token-validation-failed"))
    }

    @Test fun frame_gateway_token_error_codes_are_terminal() {
        // The actual bug: gateway sends these on token expiry/tamper; must route to login.
        assertTrue(isTerminalAuthError("expired"))
        assertTrue(isTerminalAuthError("malformed"))
        assertTrue(isTerminalAuthError("signature-invalid"))
        assertTrue(isTerminalAuthError("wrong-purpose"))
    }

    @Test fun frame_unknown_code_defaults_terminal() {
        // Inverted default: an auth rejection we do not recognise must surface re-login,
        // never loop forever.
        assertTrue(isTerminalAuthError("some-future-auth-code"))
    }

    @Test fun frame_explicitly_retryable_codes_are_not_terminal() {
        assertFalse(isTerminalAuthError("auth-timeout"))
        assertFalse(isTerminalAuthError("session-limit"))
        assertFalse(isTerminalAuthError("rate-limited"))
    }

    @Test fun frame_null_code_is_not_terminal() {
        assertFalse(isTerminalAuthError(null))
    }

    // ── Throwable path: sessions.error → terminal ONLY for a known credential code ──
    @Test fun throwable_known_auth_codes_are_terminal() {
        assertTrue(isTerminalAuthError(SessionsRequestException("auth-required", "no token")))
        assertTrue(isTerminalAuthError(SessionsRequestException("user-not-found", "gone")))
        assertTrue(isTerminalAuthError(SessionsRequestException("expired", "token expired")))
    }

    @Test fun throwable_non_auth_codes_are_not_terminal() {
        // A sessions error that is not an auth failure must NOT log the user out.
        assertFalse(isTerminalAuthError(SessionsRequestException("rate-limited", "slow down")))
        assertFalse(isTerminalAuthError(SessionsRequestException("not-found", "no such session")))
        assertFalse(isTerminalAuthError(SessionsTimeoutException("session.switched")))
        assertFalse(isTerminalAuthError(RuntimeException("socket closed")))
    }
}
```

> Note: verify `SessionsTimeoutException` exists / its constructor — it is referenced in the current test (`AuthErrorClassTest.kt:24`). Keep whatever import the original test used.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
source scripts/env.sh
cd shared/mobile-sdk && ../../gradlew :shared:mobile-sdk:commonTest --tests "io.sentient.mobilesdk.sdk.AuthErrorClassTest" 2>&1 | tail -20
```
Expected: FAIL — `frame_gateway_token_error_codes_are_terminal` and `frame_unknown_code_defaults_terminal` fail (current code returns false for `"expired"`).

> If the exact gradle task path differs, discover it: `./gradlew tasks --all | grep -i "mobile-sdk" | grep -i test`. The KMP common tests usually run under `:shared:mobile-sdk:jvmTest` or `:shared:mobile-sdk:iosSimulatorArm64Test` / `:shared:mobile-sdk:testDebugUnitTest` depending on targets — use whichever the repo already uses for commonTest (check `agents/docs/mobile-sdk/` or existing CI).

- [ ] **Step 3: Implement the split classifier**

Replace `AuthErrorClass.kt` body (keep package + the `SessionsRequestException` import):

```kotlin
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.connectors.SessionsRequestException

/**
 * Auth-error classification. Two callers, two opposite safe-defaults:
 *
 *  - The connect-handshake `auth.error` FRAME ([isTerminalAuthError] String overload):
 *    a frame IS an auth rejection, so the safe default is TERMINAL (route to login).
 *    Only a short, explicit allow-list of transient auth codes stays on the reconnect
 *    path. An unrecognised / future code routes to login rather than looping forever.
 *
 *  - A `sessions.error` surfaced as a [Throwable] ([isTerminalAuthError] Throwable
 *    overload): a sessions error is usually NOT an auth failure (e.g. not-found,
 *    rate-limited), so the safe default is NON-terminal. Only a known credential-invalid
 *    code logs the user out (allow-list).
 */

/** auth.error frame codes that are RETRYABLE — a reconnect may clear them. Everything
 *  else on an auth.error frame is terminal. Mirrors the gateway's transient auth-gate
 *  codes (ws-auth-gate.ts: session-limit, auth-timeout) plus rate-limited. */
private val RETRYABLE_AUTH_CODES = setOf("auth-timeout", "session-limit", "rate-limited")

/** Credential-invalid codes that mean "re-login" wherever they appear (sessions errors).
 *  Mirrors gateway TokenError (expired/malformed/signature-invalid/wrong-purpose) +
 *  auth-gate terminal codes (auth-required, user-not-found) + the SDK's legacy
 *  token-validation-failed. */
private val TERMINAL_AUTH_CODES = setOf(
    "auth-required",
    "user-not-found",
    "token-validation-failed",
    "expired",
    "malformed",
    "signature-invalid",
    "wrong-purpose",
)

/**
 * Classify an `auth.error` HANDSHAKE frame code. Terminal (→ route to login) unless the
 * code is explicitly retryable. A null code (malformed frame) is treated as non-terminal
 * so the bounded reconnect loop still runs rather than logging out on a wire glitch.
 */
fun isTerminalAuthError(code: String?): Boolean = code != null && code !in RETRYABLE_AUTH_CODES

/**
 * Classify an uncaught [Throwable] on a connection scope. Only a [SessionsRequestException]
 * carrying a KNOWN credential-invalid code is terminal; every other throw (transport drops,
 * timeouts, generic throws, non-auth sessions errors) is transient → the reconnect
 * supervisor recovers.
 */
fun isTerminalAuthError(error: Throwable): Boolean =
    error is SessionsRequestException && error.code in TERMINAL_AUTH_CODES
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
source scripts/env.sh
cd shared/mobile-sdk && ../../gradlew :shared:mobile-sdk:<commonTestTask> --tests "io.sentient.mobilesdk.sdk.AuthErrorClassTest" 2>&1 | tail -20
```
Expected: PASS (all cases).

- [ ] **Step 5: Confirm callers still compile (no signature change)**

```bash
source scripts/env.sh
./gradlew :shared:mobile-sdk:compileKotlinMetadata 2>&1 | tail -15   # or the repo's common compile task
```
Expected: BUILD SUCCESSFUL. `Handshake.kt:95` (`isTerminalAuthError(msg.code)`) and `UserSessionManager.kt:78,109` (`isTerminalAuthError(e)`) bind to the same signatures.

- [ ] **Step 6: Commit**

```bash
git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/AuthErrorClass.kt \
        shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/sdk/AuthErrorClassTest.kt
git commit -m "fix(mobile-sdk): route expired-token auth.error to login (split frame vs sessions classifier)"
```

---

## Task 2: Bug 2 (iOS) — persistent network-path observer → ensureConnected

**Files:**
- Create: `ios/App/Session/NetworkPathMonitor.swift`
- Modify: `ios/App/Session/UserSession.swift`

**Interfaces:**
- Produces: `final class NetworkPathMonitor` with `init(onChange: @escaping @Sendable () -> Void)`, `func start()`, `func cancel()`. Calls `onChange` on each meaningful path change after the first (initial) path.
- Consumes: `UserSession.component.ensureConnected()` (already used by `UserSession.resume()` :82).

**Design:** `NWPathMonitor` fires `pathUpdateHandler` on every path change (including VPN→WiFi, which both stay `.satisfied` but change interfaces). Skip the very first callback (that's the path at startup — the SDK is already connecting). On every subsequent update, hop to the main actor and call `onChange`. `ensureConnected()` is idempotent (READY → one probe; in-flight → no-op), so no debounce is required for correctness; a light skip-first guard avoids a redundant startup probe.

- [ ] **Step 1: Create the monitor**

```swift
// ---------------------------------------------------------------------------
// NetworkPathMonitor — persistent NWPathMonitor that fires `onChange` whenever the
// active network path changes (e.g. VPN→WiFi, WiFi→cellular, satisfied↔unsatisfied).
//
// Why: when the path changes under a half-open socket the OS keeps the TCP socket
// nominally "open", so the SDK sits at READY on a dead socket and a queued send is
// stuck on "Retry". This observer notifies the session so it can probe/reconnect.
// The FIRST path callback (the path at startup) is skipped — the SDK is already
// connecting; only a genuine change warrants a re-check.
// ---------------------------------------------------------------------------
import Foundation
import Network

final class NetworkPathMonitor: @unchecked Sendable {
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "io.sentient.app.net-path-monitor")
    private let onChange: @Sendable () -> Void
    private let log = AppLog("net-path-monitor")
    /// Single-writer (the monitor queue) flag: skip the initial path snapshot.
    private var sawFirstPath = false

    init(onChange: @escaping @Sendable () -> Void) {
        self.onChange = onChange
    }

    func start() {
        log.info("start")
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            let status = path.status == .satisfied ? "satisfied" : "unsatisfied"
            if !self.sawFirstPath {
                self.sawFirstPath = true
                self.log.info("initial-path status=\(status) (skip)")
                return
            }
            self.log.info("path-changed → ensureConnected status=\(status)")
            self.onChange()
        }
        monitor.start(queue: queue)
    }

    func cancel() {
        log.info("cancel")
        monitor.cancel()
    }
}
```

- [ ] **Step 2: Own the monitor in UserSession**

In `ios/App/Session/UserSession.swift`, add a stored property and lifecycle wiring. The `onChange` closure routes to `component.ensureConnected()` on the main actor (UserSession is `@MainActor`).

Add the property (near `inner`/`log`):
```swift
    /// Persistent network-path observer: a path change (VPN→WiFi, etc.) re-checks the
    /// socket so a queued send is never stranded on a dead-but-"READY" connection.
    private var networkMonitor: NetworkPathMonitor?
```

In `init`, after `inner.open()`:
```swift
        // Start the network-path observer: on a path change, verify the socket.
        let monitor = NetworkPathMonitor(onChange: { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.log.info("network-changed → ensureConnected")
                self.component.ensureConnected()
            }
        })
        monitor.start()
        self.networkMonitor = monitor
```

In `shutdown()`, before/after `inner.close()`:
```swift
        networkMonitor?.cancel()
        networkMonitor = nil
```

- [ ] **Step 3: Build the iOS app (compile-check)**

```bash
source scripts/env.sh
./scripts/ios-setup.sh   # rebuild debug XCFramework + regenerate project (no SDK API change here, but keeps project fresh)
xcodebuild -project ios/SentientApp.xcodeproj -scheme SentientApp -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -20
```
Expected: BUILD SUCCEEDED. (If `xcodebuild` scheme/destination differs, use the one `scripts/build-ios.sh` uses.)

- [ ] **Step 4: Commit**

```bash
git add ios/App/Session/NetworkPathMonitor.swift ios/App/Session/UserSession.swift
git commit -m "fix(ios): reconnect on network-path change (NWPathMonitor → ensureConnected)"
```

---

## Task 3: Bug 2 (Android) — default-network callback → ensureConnected

**Files:**
- Create: `android/src/main/kotlin/io/sentient/android/presence/NetworkChangeObserver.kt`
- Modify: `android/src/main/kotlin/io/sentient/android/di/UserSessionManager.kt`

**Interfaces:**
- Produces: `class NetworkChangeObserver(appContext: Context, onChange: () -> Unit)` with `fun start()` / `fun stop()`. Calls `onChange` on each default-network change after the first `onAvailable`.
- Consumes: `UserSessionManager.component().ensureConnected()` (the shared `ChatComponent` engagement entry; `iOS UserSession.resume()` uses the same passthrough).

> Verify `ChatComponent` exposes `ensureConnected()` (it does on iOS via `UserSession.resume`). If the Android `ChatComponent` only exposes `onForeground()`/`forceReconnect()`, add an `ensureConnected()` passthrough to `ChatComponent` (one-line delegate to `sdk.ensureConnected()`) — that is the correct shared entry. Do NOT call the SDK directly from the app (layering rule).

**Design:** `registerDefaultNetworkCallback` fires `onAvailable` when the default network changes (VPN→WiFi flips the default network), and `onLost` when it drops. Skip the first `onAvailable` (current network at registration — already connected). On each subsequent `onAvailable`/`onLost`, post `onChange` to the main thread. Requires `ACCESS_NETWORK_STATE` (already declared — `NetworkType.kt` uses it).

- [ ] **Step 1: Create the observer**

```kotlin
// ---------------------------------------------------------------------------
// NetworkChangeObserver — persistent default-network callback. Fires `onChange`
// whenever the active default network changes (VPN→WiFi, WiFi→cellular, loss/regain).
//
// Why: a path change under a half-open socket leaves the SDK at READY on a dead
// socket, so a queued send is stuck on "Retry". This re-checks the socket on change.
// The FIRST onAvailable (the network at registration) is skipped — the SDK is already
// connecting. Requires ACCESS_NETWORK_STATE (declared in the manifest).
// ---------------------------------------------------------------------------
package io.sentient.android.presence

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Handler
import android.os.Looper
import io.sentient.mobilesdk.log.createLogger

class NetworkChangeObserver(
    appContext: Context,
    private val onChange: () -> Unit,
) {
    private val log = createLogger("android", "net-change")
    private val cm =
        appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    private val main = Handler(Looper.getMainLooper())
    private var sawFirst = false
    private var started = false

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            if (!sawFirst) {
                sawFirst = true
                log.info("initial-network (skip)")
                return
            }
            log.info("network-available → ensureConnected")
            main.post { onChange() }
        }

        override fun onLost(network: Network) {
            log.info("network-lost → ensureConnected")
            main.post { onChange() }
        }
    }

    fun start() {
        if (started) return
        val manager = cm ?: run {
            log.warn("start.skip", mapOf("reason" to "no-ConnectivityManager"))
            return
        }
        started = true
        manager.registerDefaultNetworkCallback(callback)
        log.info("start")
    }

    fun stop() {
        if (!started) return
        started = false
        cm?.unregisterNetworkCallback(callback)
        log.info("stop")
    }
}
```

- [ ] **Step 2: Own the observer in UserSessionManager**

In `android/.../di/UserSessionManager.kt`:

Add imports:
```kotlin
import io.sentient.android.presence.NetworkChangeObserver
```

Add a field (next to `scope`/`chatComponent`):
```kotlin
    private var networkObserver: NetworkChangeObserver? = null
```

At the end of `component()` build (just before `return component`), start the observer:
```kotlin
        // Reconnect on a network-path change (VPN→WiFi, etc.): verify the socket so a
        // queued send is never stranded on a dead-but-"READY" connection.
        networkObserver = NetworkChangeObserver(appContext) {
            chatComponent?.let {
                log.info("network-changed → ensureConnected")
                it.ensureConnected()
            }
        }.also { it.start() }
```

In `shutdown()`, before `chatComponent = null`:
```kotlin
        networkObserver?.stop()
        networkObserver = null
```

> If `ChatComponent` has no `ensureConnected()` passthrough on Android, add it (delegate to `sdk.ensureConnected()`) in the same commit. Confirm the symbol before building.

- [ ] **Step 3: Build the Android app (compile-check)**

```bash
source scripts/env.sh
./gradlew :android:assembleDebug 2>&1 | tail -20
```
Expected: BUILD SUCCESSFUL.

- [ ] **Step 4: Commit**

```bash
git add android/src/main/kotlin/io/sentient/android/presence/NetworkChangeObserver.kt \
        android/src/main/kotlin/io/sentient/android/di/UserSessionManager.kt
# include ChatComponent.kt if an ensureConnected() passthrough was added
git commit -m "fix(android): reconnect on network-path change (default-network callback → ensureConnected)"
```

---

## Task 4: Bug 2 — harden retry() to verify the socket (both apps)

**Files:**
- Modify: `ios/App/Chat/ChatViewModel.swift:90-93`
- Modify: `android/src/main/kotlin/io/sentient/android/chat/ChatViewModel.kt:119-125`

**Interfaces:**
- Consumes: `component.ensureConnected()` (verified in Tasks 2/3).

**Why:** today `retry()` only reconnects `if !isReady`; a stale-but-dead socket still reports `READY`, so retry re-sends to the same dead socket → stays "Retry". Routing retry through `ensureConnected()` actively probes (READY → liveness ping → reconnect on timeout; not-ready → reconnect) so retry recovers even before the network observer fires (closes the path-change↔send race).

- [ ] **Step 1: iOS — route retry through ensureConnected**

In `ios/App/Chat/ChatViewModel.swift`, change `retry(_:)` from:
```swift
    func retry(_ pendingId: String) {
        log.info("retry pendingId=\(pendingId)")
        cache.retry(id: pendingId)
        if !isReady { component.forceReconnect() }
    }
```
to:
```swift
    func retry(_ pendingId: String) {
        log.info("retry pendingId=\(pendingId)")
        cache.retry(id: pendingId)
        // Verify the socket rather than trusting a possibly-stale READY: a dead socket
        // after a silent path change still reports READY, so a bare re-send would fail
        // again. ensureConnected() probes (READY→ping→reconnect-if-dead) or reconnects.
        component.ensureConnected()
    }
```

> The re-queued message re-flushes automatically when the connection reaches READY (the SDK flushes `queued()` on ready; gateway dedups by `pendingId`). Keep any existing post-retry `flushIfReady()` call if present — it covers the already-healthy case.

- [ ] **Step 2: Android — route retry through ensureConnected**

In `android/.../chat/ChatViewModel.kt`, change `retry(...)` from the current shape (re-queue, then `if (!isReady) component.forceReconnect()`, then `flushIfReady()`) to call `component.ensureConnected()` instead of the `if (!isReady) forceReconnect()` line:
```kotlin
    fun retry(pendingId: String) {
        log.info("retry", mapOf("pendingId" to pendingId))
        cache.retry(pendingId)
        // Verify the socket rather than trusting a possibly-stale READY (see iOS note).
        component.ensureConnected()
        flushIfReady()
    }
```
> Preserve the existing method's exact surrounding logic; only swap the `if (!isReady) forceReconnect()` for `ensureConnected()`. Keep `flushIfReady()` if it was there.

- [ ] **Step 3: Build both apps**

```bash
source scripts/env.sh
./gradlew :android:assembleDebug 2>&1 | tail -10
xcodebuild -project ios/SentientApp.xcodeproj -scheme SentientApp -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -10
```
Expected: both BUILD SUCCEEDED/SUCCESSFUL.

- [ ] **Step 4: Commit**

```bash
git add ios/App/Chat/ChatViewModel.swift android/src/main/kotlin/io/sentient/android/chat/ChatViewModel.kt
git commit -m "fix(mobile): retry verifies the socket via ensureConnected (not stale READY)"
```

---

## Task 5: Quality gate (lint + typecheck + unit) and SDK consumers

**Files:** none (verification).

- [ ] **Step 1: Run the mobile-sdk common tests**

```bash
source scripts/env.sh
./gradlew :shared:mobile-sdk:<commonTestTask> 2>&1 | tail -25
```
Expected: PASS — including `AuthErrorClassTest` and the existing `SentientSdkReconnectTest`, `ForegroundProbeTest`, `EnsureConnectedTest`, `AuthErrorClassTest`.

- [ ] **Step 2: Build both apps release-debug to confirm no app-layer break**

```bash
source scripts/env.sh
./gradlew :android:assembleDebug 2>&1 | tail -10
xcodebuild -project ios/SentientApp.xcodeproj -scheme SentientApp -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -10
```
Expected: both succeed.

- [ ] **Step 3: Gateway side is untouched — confirm no gateway change crept in**

```bash
git diff --name-only develop... | grep -E '^gateway/' || echo "no gateway changes (correct — fix is mobile-only)"
```
Expected: prints the "no gateway changes" line.

---

## Task 6: E2E smoke + reusable case capture

> Native mobile E2E = Maestro + `adb`/`simctl`, agent-driven (project memory `feedback_mobile_e2e_maestro`). Smoke against the **local** Docker stack (`deploy/macos/`), never prod. Evidence under the mobile QA dir; a case is green only when user-visible behavior AND the log trail match.

### Inline E2E matrix

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|------|----------|-----------|--------|------------------------|--------------------|
| **auth-expiry-routes-to-login (Android)** | Android emulator | Logged in, chat open, local stack up | `adb shell am broadcast -a io.sentient.debug.FAULT -p io.dev32.sentient.debug --es kind expired` → background→foreground (forces a reconnect with the expired token) | App routes to **login screen** (NOT a stuck "Reconnecting…" banner) | logcat: `fault.arm kind=expired-token` → `handshake` auth.error code=`expired` → terminal-auth → `signalAuthExpired`/`scope.auth-failure → login` → no `transport.reconnect attempt` loop |
| **auth-expiry-routes-to-login (iOS)** | iOS simulator | Logged in, chat open | *No iOS fault-arming channel (ios-testing rule).* | — | — — **FLAG: real-device/manual only** (no `adb`-broadcast equivalent on iOS; drive via a short-TTL token on the local gateway or a real expired token, then foreground). Capture os_log: auth.error code=`expired` → `onAuthFailed`/authExpired → routes to login. |
| **network-change-recovers-send (Android)** | Android emulator | Logged in, chat open, message typed | `adb shell svc wifi disable` (kills the socket) → tap Send → wait → `adb shell svc wifi enable` | Message leaves "Retry": flushes and gets a reply after WiFi returns (no permanently-stuck Retry) | logcat: `net-change network-lost`/`network-available → ensureConnected` → `foreground.not-ready → reconnect` or probe-timeout → `transport.reconnect success` → `send-message flush count=1` → committed echo |
| **network-change-recovers-send (iOS)** | iOS real device | Logged in, message typed, on VPN | Background app → switch VPN→WiFi → foreground → Send | Message flushes / recovers; Retry (if shown) recovers on tap | os_log: `net-path-monitor path-changed → ensureConnected` → reconnect → flush. **FLAG: real-device/manual only** (simulator shares Mac network; VPN half-open not deterministically reproducible) |
| **retry-button-recovers (Android)** | Android emulator | A message already in FAILED/"Retry" (from the network-change case) on a dead-then-revived socket | Tap **Retry** | Message re-sends and is delivered | logcat: `ChatViewModel retry pendingId=…` → `ensureConnected` → (`reconnect success` if needed) → `flush count=1` → echo |
| **no-regression: clean reconnect still works** | Android emulator + iOS sim | Logged in, healthy | Background→foreground (clean) | Stays connected, no bounce to login, no stuck banner | logs: `foreground.probe-pong (socket alive)` — NO `authExpired`, NO reconnect storm |
| **no-regression: sessions error does not log out** | Android emulator | Logged in | Trigger a benign `sessions.error` (e.g. switch to a non-existent session id if reachable) | Error surfaces in-place; user stays logged in (NOT bounced to login) | logs: sessions error code (e.g. `not-found`) → NO `authExpired` / no login route |

- [ ] **Step 1: Bring up the local stack**

```bash
docker compose -f deploy/macos/docker-compose.yml ps   # check; bring up if needed per deploy/macos
```
Verify gateway healthy before driving any client.

- [ ] **Step 2: Android E2E — auth-expiry case**

Install the debug apk on the emulator, log in (reusable login subflow), then run the broadcast + foreground sequence above. Capture `logcat` (filter tag `sentient`) + emulator screenshot under the mobile QA dir. Assert: routes to login; no reconnect loop.

- [ ] **Step 3: Android E2E — network-change + retry cases**

Drive the `svc wifi disable/enable` sequence. Capture logcat + screenshots. Assert the message recovers (no permanent Retry) and the `net-change → ensureConnected → reconnect → flush` trail is present.

- [ ] **Step 4: iOS E2E — what is reachable**

Run the **no-regression clean reconnect** case on the simulator (background/foreground) and capture os_log. **Flag the auth-expiry and network-change iOS cases as real-device/manual** in the handover (no fault channel; non-deterministic network) — do NOT silently skip.

- [ ] **Step 5: Capture the two reusable cases in the library**

Add to `agents/docs/testing-knowledge.md` (mobile section), indexed by surface:
- `mobile-auth-expiry-routes-to-login` — arm expired-token fault (Android `adb` broadcast) → reconnect → assert login route; iOS manual.
- `mobile-network-change-recovers-send` — flip transport (`svc wifi` / VPN) → assert `ensureConnected`→reconnect→flush, no stuck Retry; iOS manual.

```bash
git add agents/docs/testing-knowledge.md
git commit -m "docs(testing): add mobile auth-expiry + network-change reconnect e2e cases"
```

---

## Pre-handover gate

- [ ] Task 1 classifier tests green; `SentientSdkReconnectTest`/`ForegroundProbeTest`/`EnsureConnectedTest` still green.
- [ ] iOS + Android debug builds succeed.
- [ ] Lint/format clean for touched modules.
- [ ] Android E2E cases green with log trail captured; iOS reachable case green; iOS unreachable cases explicitly flagged in handover (real-device/manual).
- [ ] No gateway changes (fix is mobile-only).
- [ ] Branch ready for review; NOT merged.

---

## Self-Review notes

- **Spec coverage:** Bug 1 → Task 1 (frame inverts, sessions allow-list expanded). Bug 2 → Tasks 2 (iOS observer), 3 (Android observer), 4 (retry hardening). E2E → Task 6. KMP-parity scope honored (both platforms in Tasks 2+3+4).
- **Regression guard:** the `SessionsRequestException` path is explicitly kept as an allow-list (Task 1) so benign sessions errors never log users out (pinned by `throwable_non_auth_codes_are_not_terminal`). The clean-reconnect + sessions-error no-regression E2E rows guard the inverted default.
- **Tuned constants untouched:** reuses existing `ensureConnected()`/`onForeground()` probe timeout; no constant changes.
- **Open verification at execution:** (a) exact gradle commonTest task name; (b) `ChatComponent.ensureConnected()` passthrough exists on Android (add if missing); (c) Android `ChatViewModel.retry` exact surrounding lines.
