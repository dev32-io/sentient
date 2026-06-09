# Mobile Backend Configurability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any clone point the mobile apps at their own gateway — a gitignored build-time default for debug, a runtime "backend setup" page (host/port/3-way TLS) forced when unconfigured, hot-swap on save — and stop committing the private host.

**Architecture:** Each native app owns config persistence + a precedence resolver (`runtime override → build-time default → unconfigured`). The resolver yields the SDK's existing two inputs `(gatewayWsUrl, allowSelfSignedDevHost)`; the KMP SDK is unchanged (its TLS bypass is already runtime-gated on `allowSelfSignedDevHost`, not `#if DEBUG`). Android exposes the SDK reactively (`SdkHolder.sdkFlow`) so a rebuild re-points the retained ViewModels; iOS rebuilds the single `SdkStore`-owned instance.

**Tech Stack:** Android (Kotlin/Compose, SharedPreferences, Gradle KTS), iOS (Swift/SwiftUI, UserDefaults, xcconfig/xcodegen), KMP `shared/mobile-sdk` (read-only here).

**Testing note (project test-lean doctrine, `.claude/rules/testing.md`):** the generic skill's "test everything TDD" is overridden. We write unit tests ONLY for the pieces that pin a real contract/invariant/security boundary: the gateway URL **path contract**, the **connection-security → `allowSelfSignedDevHost`** mapping, and the **force-setup precedence invariant**. Persistence plumbing, DI wiring, and UI are verified by build + the inline e2e matrix, not unit tests.

**Mapping reference (used by both platforms):**
| 3-way selector | scheme | `allowSelfSignedDevHost` |
|---|---|---|
| TLS — valid cert | `wss` | `false` |
| TLS — trust self-signed | `wss` | `true` |
| Plain ws | `ws` | n/a (`false`) |
URL = `{scheme}://{host}:{port}/api/v1/ws`.

---

## Phase 0 — De-hardcode + build-time default files

Removes the private host from committed source and wires the gitignored "one file the agent edits" per platform. No history rewrite (per spec).

### Task 0.1: Android — read default URL from `local.properties`

**Files:**
- Modify: `android/build.gradle.kts:20-43` (the `buildTypes` block)

- [ ] **Step 1: Replace the two `buildConfigField` literals with a `local.properties` read + safe fallback**

At the top of the `android { }` block (before `buildTypes`), add a helper that reads the gitignored `local.properties`:

```kotlin
// Debug gateway URL is sourced from local.properties (gitignored) so no private
// host is ever committed. Key: sentient.gatewayUrl. Absent → 10.0.2.2 emulator
// loopback fallback. See android/local.properties.example. Release bakes NO
// default ("") → the app forces the in-app backend-setup page on first launch.
val debugGatewayUrl: String = run {
    val props = java.util.Properties()
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { props.load(it) }
    props.getProperty("sentient.gatewayUrl") ?: "wss://10.0.2.2:8888/api/v1/ws"
}
```

Then replace the two `buildConfigField` lines:

```kotlin
        getByName("debug") {
            isDebuggable = true
            applicationIdSuffix = ".debug"
            // Sourced from local.properties (gitignored) — see debugGatewayUrl above.
            buildConfigField("String", "GATEWAY_WS_URL", "\"$debugGatewayUrl\"")
        }
        getByName("release") {
            // No baked default: empty ⇒ resolver returns Unconfigured ⇒ setup page.
            buildConfigField("String", "GATEWAY_WS_URL", "\"\"")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
```

Delete the stale `192.168.0.222` / `home.dev32.io` comments from this block; replace with the comment shown above.

- [ ] **Step 2: Verify the build config compiles**

Run: `cd android && ./gradlew :android:compileDebugKotlin -q` (from repo root, after `source scripts/env.sh`)
Expected: BUILD SUCCESSFUL. (If Gradle wrapper differs, use the repo's documented build command.)

### Task 0.2: Android — committed `local.properties.example`

**Files:**
- Create: `android/../local.properties.example` (repo root, next to the real `local.properties`)

> Note: `local.properties` is already gitignored (`.gitignore:18`). The example is committed.

- [ ] **Step 1: Create the example file**

Path: `local.properties.example` (repo root)

```properties
# Copy to local.properties (gitignored) and set your debug gateway.
# The Android debug build bakes this as BuildConfig.GATEWAY_WS_URL.
# Emulator → host loopback is 10.0.2.2; a physical device uses the Mac's LAN IP.
# Full WS URL including scheme + /api/v1/ws path.
sentient.gatewayUrl=wss://10.0.2.2:8888/api/v1/ws

# (Android Studio also writes sdk.dir here; leave that as-is in your real file.)
```

### Task 0.3: iOS — xcconfig → Info.plist wiring + strip literals

**Files:**
- Create: `ios/App/Local.xcconfig.example`
- Modify: `ios/project.yml` (add `configFiles` for Debug + an Info.plist property + strip the `home.dev32.io` comment)

- [ ] **Step 1: Create `ios/App/Local.xcconfig.example`**

```
// Copy to ios/App/Local.xcconfig (gitignored). Sets the DEBUG gateway URL.
// xcconfig GOTCHA: an unescaped `//` starts a comment, so a URL's `wss://`
// truncates. The `$()` between `:` and `//` expands to empty at build time and
// prevents that — the resolved value is wss://host:8888/api/v1/ws.
GATEWAY_WS_URL = wss:$()//localhost:8888/api/v1/ws
```

- [ ] **Step 2: Wire Local.xcconfig (Debug only) + an Info.plist key in `ios/project.yml`**

In `ios/project.yml`, under `targets.SentientApp`, add a `configFiles` map and an Info.plist property. Replace the existing `info.properties` block to add `GatewayWSURL`, and add `configFiles`:

```yaml
    info:
      path: App/Info.plist
      properties:
        UILaunchScreen: {}
        CFBundleDisplayName: Sentient
        NSMicrophoneUsageDescription: Sentient uses the microphone for voice conversations.
        # Build-time default gateway URL. Debug reads Local.xcconfig (gitignored);
        # Release leaves it unset → "" → app forces the in-app backend-setup page.
        GatewayWSURL: $(GATEWAY_WS_URL)
        NSAppTransportSecurity:
          NSAllowsLocalNetworking: true
          NSExceptionDomains:
            localhost:
              NSExceptionAllowsInsecureHTTPLoads: true
              NSIncludesSubdomains: true
    configFiles:
      Debug: App/Local.xcconfig
```

Edit the `NSAppTransportSecurity` comment (lines ~23-28) to drop the `home.dev32.io` reference — replace with: `# Prod hosts must serve a CA-trusted cert (strict ATS). NSAllowsLocalNetworking exempts LAN/private-IP hosts for the self-signed dev/self-host case.`

- [ ] **Step 3: Regenerate the Xcode project**

Run: `cd ios && xcodegen generate` (after `source scripts/env.sh`)
Expected: `Created project at ...SentientApp.xcodeproj`. A missing `Local.xcconfig` is fine — xcodegen references it; the build resolves `$(GATEWAY_WS_URL)` to empty when absent (Task 2.3 code provides the debug fallback).

### Task 0.4: Add `Local.xcconfig` to `.gitignore`

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Append the ignore rule**

Add to `.gitignore`:

```
# iOS per-machine debug backend (see ios/App/Local.xcconfig.example)
ios/App/Local.xcconfig
```

- [ ] **Step 2: Commit Phase 0**

```bash
git add android/build.gradle.kts local.properties.example ios/project.yml ios/App/Local.xcconfig.example .gitignore
git commit -m "chore(mobile): externalize debug gateway URL; strip private host from build config"
```

---

## Phase 1 — Android backend config

### Task 1.1: BackendConfig model + resolver (with tests)

**Files:**
- Create: `android/src/main/kotlin/io/sentient/android/backend/BackendConfig.kt`
- Test: `android/src/test/kotlin/io/sentient/android/backend/BackendConfigTest.kt`

- [ ] **Step 1: Write the failing test (path contract + security mapping + precedence invariant)**

```kotlin
package io.sentient.android.backend

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class BackendConfigTest {
    @Test fun `wss path contract for valid-cert`() {
        val c = BackendConfig("host.example", 8888, ConnectionSecurity.TLS_VALID)
        assertEquals("wss://host.example:8888/api/v1/ws", c.toGatewayWsUrl())
        assertEquals(false, c.allowSelfSigned())
    }
    @Test fun `trust-self-signed maps to allowSelfSigned true on wss`() {
        val c = BackendConfig("192.168.0.5", 8888, ConnectionSecurity.TLS_TRUST_SELF_SIGNED)
        assertEquals("wss://192.168.0.5:8888/api/v1/ws", c.toGatewayWsUrl())
        assertEquals(true, c.allowSelfSigned())
    }
    @Test fun `plain ws uses ws scheme and does not trust self-signed`() {
        val c = BackendConfig("10.0.0.2", 8888, ConnectionSecurity.PLAIN_WS)
        assertEquals("ws://10.0.0.2:8888/api/v1/ws", c.toGatewayWsUrl())
        assertEquals(false, c.allowSelfSigned())
    }
    @Test fun `override wins over build-time default`() {
        val override = BackendConfig("ov", 1, ConnectionSecurity.TLS_VALID)
        val r = resolveBackend(override, "wss://built:8888/api/v1/ws", true)
        assertTrue(r is ResolvedBackend.Configured)
        assertEquals("wss://ov:1/api/v1/ws", (r as ResolvedBackend.Configured).gatewayWsUrl)
    }
    @Test fun `build-time default used when no override`() {
        val r = resolveBackend(null, "wss://built:8888/api/v1/ws", true)
        assertEquals(ResolvedBackend.Configured("wss://built:8888/api/v1/ws", true), r)
    }
    @Test fun `empty build-time default and no override is Unconfigured`() {
        assertEquals(ResolvedBackend.Unconfigured, resolveBackend(null, "", false))
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && ./gradlew :android:testDebugUnitTest --tests "io.sentient.android.backend.BackendConfigTest" -q`
Expected: FAIL — unresolved references `BackendConfig`, `resolveBackend`.

- [ ] **Step 3: Implement `BackendConfig.kt`**

```kotlin
// ---------------------------------------------------------------------------
// BackendConfig — the user-entered backend descriptor + the pure resolution
// logic that turns it (or the build-time default) into the SDK's two transport
// inputs. Native-owned per the design (no KMP push). Pure + unit-tested:
// the /api/v1/ws path is the gateway contract, and the security→allowSelfSigned
// mapping is a security boundary.
// ---------------------------------------------------------------------------
package io.sentient.android.backend

/** Gateway WS path — the wire contract with the gateway. Not user-editable. */
private const val GATEWAY_WS_PATH = "/api/v1/ws"

/** How the client secures the connection. Maps to scheme + self-signed trust. */
enum class ConnectionSecurity { TLS_VALID, TLS_TRUST_SELF_SIGNED, PLAIN_WS }

/**
 * A user-entered backend. [port] is validated by the caller (1..65535); [host]
 * is a bare host or IP (no scheme, no path).
 */
data class BackendConfig(
    val host: String,
    val port: Int,
    val security: ConnectionSecurity,
) {
    fun toGatewayWsUrl(): String {
        val scheme = if (security == ConnectionSecurity.PLAIN_WS) "ws" else "wss"
        return "$scheme://$host:$port$GATEWAY_WS_PATH"
    }

    /** True only for the explicit trust-self-signed selection. */
    fun allowSelfSigned(): Boolean = security == ConnectionSecurity.TLS_TRUST_SELF_SIGNED
}

/** The resolved transport inputs, or the signal to force the setup page. */
sealed interface ResolvedBackend {
    data class Configured(
        val gatewayWsUrl: String,
        val allowSelfSignedDevHost: Boolean,
    ) : ResolvedBackend
    data object Unconfigured : ResolvedBackend
}

/**
 * Precedence: runtime [override] → non-empty [buildTimeDefaultUrl] → Unconfigured.
 * [buildTimeAllowSelfSigned] applies only to the build-time-default branch
 * (debug trusts the local dev cert); an override carries its own trust posture.
 */
fun resolveBackend(
    override: BackendConfig?,
    buildTimeDefaultUrl: String,
    buildTimeAllowSelfSigned: Boolean,
): ResolvedBackend {
    if (override != null) {
        return ResolvedBackend.Configured(override.toGatewayWsUrl(), override.allowSelfSigned())
    }
    if (buildTimeDefaultUrl.isNotEmpty()) {
        return ResolvedBackend.Configured(buildTimeDefaultUrl, buildTimeAllowSelfSigned)
    }
    return ResolvedBackend.Unconfigured
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd android && ./gradlew :android:testDebugUnitTest --tests "io.sentient.android.backend.BackendConfigTest" -q`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add android/src/main/kotlin/io/sentient/android/backend/BackendConfig.kt android/src/test/kotlin/io/sentient/android/backend/BackendConfigTest.kt
git commit -m "feat(android): backend config model + precedence resolver"
```

### Task 1.2: BackendConfigStore (SharedPreferences + StateFlow)

**Files:**
- Create: `android/src/main/kotlin/io/sentient/android/backend/BackendConfigStore.kt`

> Implementation note (spec said DataStore): we use **SharedPreferences** instead. The gate decision (configured vs not) must be known **synchronously on the first frame** to avoid a setup/login flicker; the URL is not a secret; and it avoids a new dependency. Same role as the spec's DataStore. A `StateFlow` seeded from the synchronous read keeps it observable for hot-swap.

- [ ] **Step 1: Implement the store + a process holder**

```kotlin
// ---------------------------------------------------------------------------
// BackendConfigStore — persists the user-entered BackendConfig (SharedPreferences)
// and exposes it as a StateFlow seeded synchronously so the app's first frame
// knows whether to force the setup page. save() updates both prefs and the flow.
// BackendConfigHolder is the process singleton, initialised in SentientApp.
// ---------------------------------------------------------------------------
package io.sentient.android.backend

import android.content.Context
import io.sentient.mobilesdk.log.createLogger
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

private const val PREFS = "backend_config"
private const val KEY_HOST = "host"
private const val KEY_PORT = "port"
private const val KEY_SECURITY = "security"

class BackendConfigStore(context: Context) {
    private val log = createLogger("android", "backend-config-store")
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val _config = MutableStateFlow(read())

    /** Current persisted override, or null if the user never set one. */
    val config: StateFlow<BackendConfig?> = _config.asStateFlow()

    fun save(config: BackendConfig) {
        log.info("save", mapOf("host" to config.host, "port" to config.port, "security" to config.security.name))
        prefs.edit()
            .putString(KEY_HOST, config.host)
            .putInt(KEY_PORT, config.port)
            .putString(KEY_SECURITY, config.security.name)
            .apply()
        _config.value = config
    }

    private fun read(): BackendConfig? {
        val host = prefs.getString(KEY_HOST, null) ?: return null
        val port = prefs.getInt(KEY_PORT, -1).takeIf { it in 1..65535 } ?: return null
        val security = prefs.getString(KEY_SECURITY, null)
            ?.let { runCatching { ConnectionSecurity.valueOf(it) }.getOrNull() } ?: return null
        return BackendConfig(host, port, security)
    }
}

/** Process singleton. [init] runs once in SentientApp.onCreate (has app context). */
object BackendConfigHolder {
    @Volatile private var instance: BackendConfigStore? = null
    fun init(context: Context) { if (instance == null) instance = BackendConfigStore(context) }
    val store: BackendConfigStore
        get() = instance ?: error("BackendConfigHolder.init not called (SentientApp.onCreate)")
}
```

- [ ] **Step 2: Initialise the holder in `SentientApp.onCreate`**

Modify `android/src/main/kotlin/io/sentient/android/SentientApp.kt`, after `MobileSdk.initAndroid(applicationContext)`:

```kotlin
        MobileSdk.initAndroid(applicationContext)
        io.sentient.android.backend.BackendConfigHolder.init(applicationContext)
```

- [ ] **Step 3: Verify compile**

Run: `cd android && ./gradlew :android:compileDebugKotlin -q`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 4: Commit**

```bash
git add android/src/main/kotlin/io/sentient/android/backend/BackendConfigStore.kt android/src/main/kotlin/io/sentient/android/SentientApp.kt
git commit -m "feat(android): persist backend config in SharedPreferences with observable flow"
```

### Task 1.3: SdkHolder — resolve config, expose SDK reactively, support rebuild

**Files:**
- Modify: `android/src/main/kotlin/io/sentient/android/sdk/SdkHolder.kt`

- [ ] **Step 1: Replace `config()` + add reactive SDK surface + `applyResolvedConfig()`**

Replace the bottom half of `SdkHolder` (from `val sdk` through `buildAuthClient()`). Add imports for `kotlinx.coroutines.flow.MutableStateFlow`, `StateFlow`, `asStateFlow`, and `io.sentient.android.backend.*`.

```kotlin
    // Reactive SDK surface: null until configured. SdkViewModel observes this so a
    // backend change (applyResolvedConfig) re-points the retained ViewModel at the
    // rebuilt instance without recreating the Activity/VM.
    private val _sdkFlow = MutableStateFlow<SentientSdk?>(null)
    val sdkFlow: StateFlow<SentientSdk?> = _sdkFlow.asStateFlow()

    /** Resolve the active backend from the persisted override + the build-time default. */
    private fun resolved(): ResolvedBackend = resolveBackend(
        override = BackendConfigHolder.store.config.value,
        buildTimeDefaultUrl = io.sentient.android.BuildConfig.GATEWAY_WS_URL,
        buildTimeAllowSelfSigned = io.sentient.android.BuildConfig.DEBUG,
    )

    /** True when a usable backend exists (override or non-empty build default). */
    fun isConfigured(): Boolean = resolved() is ResolvedBackend.Configured

    /** Build the SDK if configured + not yet built. No-op if unconfigured. */
    fun ensureBuilt() {
        if (instance != null) return
        val r = resolved()
        if (r is ResolvedBackend.Configured) synchronized(this) {
            if (instance == null) buildFrom(r)
        }
    }

    /**
     * Apply a newly-saved backend: tear down the current SDK + auth client and
     * rebuild from the freshly-resolved config. The rebuilt SDK starts
     * DISCONNECTED, so the host lands on the new backend's login. Idempotent.
     */
    fun applyResolvedConfig() = synchronized(this) {
        instance?.disconnect()
        authClientInstance = null
        val r = resolved()
        if (r is ResolvedBackend.Configured) buildFrom(r) else { instance = null; _sdkFlow.value = null }
    }

    private fun buildFrom(r: ResolvedBackend.Configured): SentientSdk {
        val config = SdkConfig(
            gatewayWsUrl = r.gatewayWsUrl,
            allowSelfSignedDevHost = r.allowSelfSignedDevHost,
            capabilities = capabilities,
        )
        log.info("build", mapOf(
            "gatewayWsUrl" to config.gatewayWsUrl,
            "allowSelfSignedDevHost" to config.allowSelfSignedDevHost,
            "capabilities" to capabilities.size,
        ))
        return SentientSdk(config = config, bundle = bundle, scope = scope)
            .also { instance = it; _sdkFlow.value = it }
    }
```

Replace the existing `val sdk` accessor with one that requires configuration (callers in the configured branch only):

```kotlin
    /** The current SDK. Requires a configured backend + ensureBuilt() first. */
    val sdk: SentientSdk
        get() = instance ?: synchronized(this) {
            instance ?: run {
                val r = resolved()
                require(r is ResolvedBackend.Configured) { "SDK accessed while backend unconfigured" }
                buildFrom(r)
            }
        }
```

Replace `buildAuthClient()` to resolve from config:

```kotlin
    private fun buildAuthClient(): AuthClient {
        val r = resolved()
        require(r is ResolvedBackend.Configured) { "AuthClient accessed while backend unconfigured" }
        log.info("build-auth-client", mapOf("gatewayWsUrl" to r.gatewayWsUrl))
        return AuthClient(
            gatewayWsUrl = r.gatewayWsUrl,
            httpClient = buildAuthHttpClient(r.allowSelfSignedDevHost),
        )
    }
```

Delete the old `private fun config(): SdkConfig` and old `build()`.

- [ ] **Step 2: Verify compile**

Run: `cd android && ./gradlew :android:compileDebugKotlin -q`
Expected: BUILD SUCCESSFUL (SdkViewModel/AuthViewModel updated next; if they error on `SdkHolder.sdk`, that's fixed in Task 1.4).

### Task 1.4: SdkViewModel + AuthViewModel — observe the reactive SDK / fresh auth client

**Files:**
- Modify: `android/src/main/kotlin/io/sentient/android/sdk/SdkViewModel.kt`
- Modify: `android/src/main/kotlin/io/sentient/android/auth/AuthViewModel.kt:68-72,104-105,130-131`

- [ ] **Step 1: SdkViewModel observes `SdkHolder.sdkFlow`**

Replace the class body's `sdk` capture + `state` + commands so they read the current instance reactively:

```kotlin
class SdkViewModel : ViewModel() {
    private val log = createLogger("android", "sdk-viewmodel")

    // Re-point on backend change: flatMapLatest cancels the old SDK's state
    // collection and collects the rebuilt instance. sdkFlow is non-null here
    // because the VM is only constructed in AppRoot's configured branch.
    val state: StateFlow<SdkState> =
        SdkHolder.sdkFlow.filterNotNull()
            .flatMapLatest { it.state }
            .stateIn(viewModelScope, SharingStarted.Eagerly, SdkHolder.sdk.state.value)

    private val sdk: SentientSdk? get() = SdkHolder.sdkFlow.value

    fun connect() { log.info("connect"); viewModelScope.launch { sdk?.connect() } }
    fun disconnect() { log.info("disconnect"); sdk?.disconnect() }
    fun sendText(text: String) { log.info("sendText", mapOf("len" to text.length)); sdk?.sendText(text) }
    fun interrupt() { log.info("interrupt"); sdk?.interrupt() }
    fun startMic() { log.info("startMic"); sdk?.startMic() }
    fun stopMic() { log.info("stopMic"); sdk?.stopMic() }
    fun setTtsEnabled(enabled: Boolean) { log.info("setTtsEnabled", mapOf("enabled" to enabled)); viewModelScope.launch { sdk?.setTtsEnabled(enabled) } }
    fun switchSession(sessionId: String) { log.info("switchSession", mapOf("sessionId" to sessionId)); viewModelScope.launch { sdk?.switchSession(sessionId) } }
    fun newChat() { log.info("newChat"); viewModelScope.launch { sdk?.newChat() } }
}
```

Add imports: `kotlinx.coroutines.flow.SharingStarted`, `kotlinx.coroutines.flow.filterNotNull`, `kotlinx.coroutines.flow.flatMapLatest`, `kotlinx.coroutines.flow.stateIn`, and `@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)` on the class (flatMapLatest).

- [ ] **Step 2: AuthViewModel reads a fresh auth client + token store per use**

In `AuthViewModel`, change the constructor defaults to providers so a rebuilt client is picked up after a backend change:

```kotlin
class AuthViewModel(
    private val authClientProvider: () -> AuthClient = { SdkHolder.authClient },
    private val tokenStore: SecureTokenStore = SdkHolder.tokenStore,
    private val sdkConnect: () -> Unit = { SdkHolder.sdk.connect() },
) : ViewModel() {
```

Replace `authClient.listUsers()` (in `loadUsers`) with `authClientProvider().listUsers()`, `authClient.login(...)` (in `submit`) with `authClientProvider().login(...)`, and `sdk.connect()` (in `submit`) with `sdkConnect()`. Remove the now-unused `sdk` import if present.

- [ ] **Step 3: SettingsViewModel reads the current SDK (not a captured one)**

`SettingsViewModel` captures `SdkHolder.sdk` at construction; after a hot-swap rebuild it would disconnect the stale instance. Change it to read the current SDK from the reactive flow. In `android/src/main/kotlin/io/sentient/android/settings/SettingsViewModel.kt`, replace the constructor + `logout()`:

```kotlin
class SettingsViewModel(
    private val sdkProvider: () -> SentientSdk? = { SdkHolder.sdkFlow.value },
    private val tokenStore: SecureTokenStore = SdkHolder.tokenStore,
) : ViewModel() {
    private val log = createLogger("android", "settings-viewmodel")

    fun logout() {
        log.info("logout.start")
        sdkProvider()?.disconnect()
        tokenStore.clear()
        log.info("logout.done")
    }
}
```

- [ ] **Step 4: Verify compile**

Run: `cd android && ./gradlew :android:compileDebugKotlin -q`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 5: Commit**

```bash
git add android/src/main/kotlin/io/sentient/android/sdk/SdkHolder.kt android/src/main/kotlin/io/sentient/android/sdk/SdkViewModel.kt android/src/main/kotlin/io/sentient/android/auth/AuthViewModel.kt android/src/main/kotlin/io/sentient/android/settings/SettingsViewModel.kt
git commit -m "feat(android): resolve SDK from backend config + reactive rebuild for hot-swap"
```

### Task 1.5: BackendSetupViewModel (validate + probe-on-save)

**Files:**
- Create: `android/src/main/kotlin/io/sentient/android/backend/BackendSetupViewModel.kt`

- [ ] **Step 1: Implement the MVI ViewModel**

```kotlin
// ---------------------------------------------------------------------------
// BackendSetupViewModel — drives the "Sentient backend setup" screen. Save folds
// in a reachability probe: build a throwaway AuthClient from the candidate config
// and call listUsers(); on success persist + applyResolvedConfig() (rebuild SDK)
// and signal success (UI shows a checkmark, then dismisses); on failure stay with
// an error. The token is cleared so a backend change never auto-resumes a stale
// session on a different backend.
// ---------------------------------------------------------------------------
package io.sentient.android.backend

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.android.sdk.SdkHolder
import io.sentient.android.sdk.buildAuthHttpClient
import io.sentient.mobilesdk.auth.AuthClient
import io.sentient.mobilesdk.auth.AuthError
import io.sentient.mobilesdk.auth.AuthResult
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.secure.SecureTokenStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

private const val DEFAULT_PORT = 8888

data class BackendSetupUiState(
    val host: String = "",
    val port: String = DEFAULT_PORT.toString(),
    val security: ConnectionSecurity = ConnectionSecurity.TLS_VALID,
    val saving: Boolean = false,
    val saved: Boolean = false,   // brief checkmark before dismiss
    val error: String? = null,
)

sealed interface BackendSetupIntent {
    data class SetHost(val v: String) : BackendSetupIntent
    data class SetPort(val v: String) : BackendSetupIntent
    data class SetSecurity(val v: ConnectionSecurity) : BackendSetupIntent
    data object Save : BackendSetupIntent
}

class BackendSetupViewModel(
    private val store: BackendConfigStore = BackendConfigHolder.store,
    private val tokenStore: SecureTokenStore = SdkHolder.tokenStore,
    private val probe: suspend (BackendConfig) -> AuthResult<*> = { c ->
        AuthClient(c.toGatewayWsUrl(), buildAuthHttpClient(c.allowSelfSigned())).listUsers()
    },
    private val onApplied: () -> Unit = { SdkHolder.applyResolvedConfig() },
) : ViewModel() {
    private val log = createLogger("android", "backend-setup-vm")
    private val _state = MutableStateFlow(BackendSetupUiState(prefill()))
    val state: StateFlow<BackendSetupUiState> = _state.asStateFlow()

    private fun prefill(): BackendSetupUiState {
        val c = store.config.value ?: return BackendSetupUiState()
        return BackendSetupUiState(c.host, c.port.toString(), c.security)
    }

    fun dispatch(intent: BackendSetupIntent) = when (intent) {
        is BackendSetupIntent.SetHost -> _state.update { it.copy(host = intent.v.trim(), error = null) }
        is BackendSetupIntent.SetPort -> _state.update { it.copy(port = intent.v.filter(Char::isDigit), error = null) }
        is BackendSetupIntent.SetSecurity -> _state.update { it.copy(security = intent.v, error = null) }
        BackendSetupIntent.Save -> save()
    }

    private fun save() {
        val s = _state.value
        val port = s.port.toIntOrNull()
        if (s.host.isBlank()) { _state.update { it.copy(error = "Enter a host or IP.") }; return }
        if (port == null || port !in 1..65535) { _state.update { it.copy(error = "Port must be 1–65535.") }; return }
        val candidate = BackendConfig(s.host, port, s.security)
        log.info("save.probe", mapOf("host" to s.host, "port" to port, "security" to s.security.name))
        _state.update { it.copy(saving = true, error = null) }
        viewModelScope.launch {
            when (val r = probe(candidate)) {
                is AuthResult.Success -> {
                    log.info("save.ok")
                    tokenStore.clear()
                    store.save(candidate)
                    onApplied()
                    _state.update { it.copy(saving = false, saved = true) }
                }
                is AuthResult.Failure -> {
                    log.warn("save.failed", mapOf("error" to r.error::class.simpleName))
                    _state.update { it.copy(saving = false, error = messageFor(r.error)) }
                }
            }
        }
    }

    private fun messageFor(error: AuthError): String = when (error) {
        is AuthError.Network -> "Can't reach that server. Check the host, port, and TLS option."
        is AuthError.Server -> "Server reachable but returned an error. Check the address."
        AuthError.InvalidCredentials, is AuthError.Unknown -> "Couldn't verify the server. Check the address and TLS option."
    }
}
```

> Note: `buildAuthHttpClient` is `internal` in `io.sentient.android.sdk` — same module, so importable. If the compiler rejects the cross-package `internal`, change its modifier to `internal` is already module-visible; no change needed (Android app is one module).

- [ ] **Step 2: Verify compile**

Run: `cd android && ./gradlew :android:compileDebugKotlin -q`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 3: Commit**

```bash
git add android/src/main/kotlin/io/sentient/android/backend/BackendSetupViewModel.kt
git commit -m "feat(android): backend setup view-model with probe-on-save"
```

### Task 1.6: BackendSetupScreen (Compose UI)

**Files:**
- Create: `android/src/main/kotlin/io/sentient/android/backend/BackendSetupScreen.kt`

- [ ] **Step 1: Implement the screen**

```kotlin
// ---------------------------------------------------------------------------
// BackendSetupScreen — "Sentient backend setup". Host + Port + 3-way security
// selector + a Save button that probes then dismisses on success (brief check),
// or shows an error and stays. Stateless body driven by BackendSetupUiState +
// dispatch; the host owns the VM + dismiss/onSaved navigation.
// testTags: backend-setup, backend-host, backend-port, backend-security-*,
// backend-save, backend-error.
// ---------------------------------------------------------------------------
package io.sentient.android.backend

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.sentient.android.theme.LocalTokens

@Composable
fun BackendSetupScreen(
    viewModel: BackendSetupViewModel,
    onSaved: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    LaunchedEffect(state.saved) { if (state.saved) onSaved() }
    BackendSetupBody(state = state, dispatch = viewModel::dispatch, modifier = modifier)
}

private val SECURITY_OPTIONS = listOf(
    ConnectionSecurity.TLS_VALID to "TLS",
    ConnectionSecurity.TLS_TRUST_SELF_SIGNED to "TLS · self-signed",
    ConnectionSecurity.PLAIN_WS to "Plain ws",
)

@Composable
private fun BackendSetupBody(
    state: BackendSetupUiState,
    dispatch: (BackendSetupIntent) -> Unit,
    modifier: Modifier = Modifier,
) {
    val tokens = LocalTokens.current
    Column(
        modifier = modifier.fillMaxSize().safeDrawingPadding()
            .padding(tokens.space.xl).testTag("backend-setup"),
        verticalArrangement = Arrangement.spacedBy(tokens.space.lg),
    ) {
        Text("Sentient backend", style = androidx.compose.material3.MaterialTheme.typography.headlineSmall)
        Text("Point the app at your Sentient gateway.", style = androidx.compose.material3.MaterialTheme.typography.bodyMedium)
        OutlinedTextField(
            value = state.host, onValueChange = { dispatch(BackendSetupIntent.SetHost(it)) },
            label = { Text("Host or IP") }, singleLine = true,
            modifier = Modifier.fillMaxWidth().testTag("backend-host"),
        )
        OutlinedTextField(
            value = state.port, onValueChange = { dispatch(BackendSetupIntent.SetPort(it)) },
            label = { Text("Port") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth().testTag("backend-port"),
        )
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            SECURITY_OPTIONS.forEachIndexed { i, (sec, label) ->
                SegmentedButton(
                    selected = state.security == sec,
                    onClick = { dispatch(BackendSetupIntent.SetSecurity(sec)) },
                    shape = SegmentedButtonDefaults.itemShape(i, SECURITY_OPTIONS.size),
                    modifier = Modifier.testTag("backend-security-${sec.name}"),
                ) { Text(label, maxLines = 1) }
            }
        }
        if (state.security == ConnectionSecurity.TLS_TRUST_SELF_SIGNED) {
            Text(
                "Trusts a self-signed certificate for this server only. Use for LAN/self-hosted gateways.",
                style = androidx.compose.material3.MaterialTheme.typography.bodySmall,
            )
        }
        state.error?.let {
            Text(it, modifier = Modifier.testTag("backend-error"),
                color = androidx.compose.material3.MaterialTheme.colorScheme.error)
        }
        Button(
            onClick = { dispatch(BackendSetupIntent.Save) },
            enabled = !state.saving,
            modifier = Modifier.fillMaxWidth().testTag("backend-save"),
        ) {
            when {
                state.saving -> CircularProgressIndicator(Modifier.padding(2.dp), strokeWidth = 2.dp)
                state.saved -> Text("✓")
                else -> Text("Save & connect")
            }
        }
    }
}
```

- [ ] **Step 2: Verify compile**

Run: `cd android && ./gradlew :android:compileDebugKotlin -q`
Expected: BUILD SUCCESSFUL. (If `SegmentedButton` API differs in the pinned Compose Material3 version, fall back to three `OutlinedButton`s with a selected-tint; verify against `gradle/libs.versions.toml` `compose-bom`.)

- [ ] **Step 3: Commit**

```bash
git add android/src/main/kotlin/io/sentient/android/backend/BackendSetupScreen.kt
git commit -m "feat(android): backend setup screen UI"
```

### Task 1.7: AppRoot 3-way gating + gear on login

**Files:**
- Modify: `android/src/main/kotlin/io/sentient/android/MainActivity.kt`
- Modify: `android/src/main/kotlin/io/sentient/android/auth/LoginScreen.kt` (add a gear affordance)

- [ ] **Step 1: Add a `BackendSetupViewModel` + gate in MainActivity**

In `MainActivity`, add the VM field:

```kotlin
    private val backendSetupViewModel: io.sentient.android.backend.BackendSetupViewModel by viewModels {
        viewModelFactory { initializer { io.sentient.android.backend.BackendSetupViewModel() } }
    }
```

Pass it into `AppRoot(...)` and update `AppRoot`'s signature + body. Replace the `AppRoot` body's top-level branch:

```kotlin
@OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)
@Composable
private fun AppRoot(
    sdkViewModel: SdkViewModel,
    authViewModel: AuthViewModel,
    historyViewModel: HistoryViewModel,
    settingsViewModel: SettingsViewModel,
    backendSetupViewModel: io.sentient.android.backend.BackendSetupViewModel,
) {
    val backendConfig by io.sentient.android.backend.BackendConfigHolder.store.config.collectAsStateWithLifecycle()
    // Forced setup: no override AND no build-time default ⇒ unconfigured. Derived
    // from the collected flow so a save (config flips non-null) recomposes the gate.
    var showSetupOverride by rememberSaveable { mutableStateOf(false) }
    val configured = backendConfig != null || io.sentient.android.BuildConfig.GATEWAY_WS_URL.isNotEmpty()
    Surface(Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }) {
        Box(Modifier.fillMaxSize()) {
            if (!configured || showSetupOverride) {
                io.sentient.android.backend.BackendSetupScreen(
                    viewModel = backendSetupViewModel,
                    onSaved = { showSetupOverride = false },
                )
            } else {
                io.sentient.android.sdk.SdkHolder.ensureBuilt()
                AppConfiguredRoot(
                    sdkViewModel, authViewModel, historyViewModel, settingsViewModel,
                    onOpenBackendSetup = { showSetupOverride = true },
                )
            }
        }
    }
}
```

Extract the existing READY/login swap into `AppConfiguredRoot(...)` (the previous `AppRoot` body from `val sdkState by ...` down), adding an `onOpenBackendSetup: () -> Unit` param and passing it to `LoginScreen`:

```kotlin
            } else {
                LoginScreen(viewModel = authViewModel, onOpenBackendSetup = onOpenBackendSetup)
            }
```

Update the `setContent { SentientTheme { AppRoot(... , backendSetupViewModel = backendSetupViewModel) } }` call.

- [ ] **Step 2: Add the gear to LoginScreen**

In `LoginScreen.kt`, add `onOpenBackendSetup: () -> Unit` param to `LoginScreen` and `LoginScreenBody`, and overlay a gear button (top-end) on the `Box`:

```kotlin
        // Gear → backend setup, top-end. Always available (debug + release).
        androidx.compose.material3.TextButton(
            onClick = onOpenBackendSetup,
            modifier = Modifier.align(Alignment.TopEnd).testTag("login-backend-setup"),
        ) { Text("⚙", color = MaterialTheme.colorScheme.onSurfaceVariant) }
```

Place it inside the outer `Box` (which already uses `contentAlignment = Center`; `align` on the child overrides for the gear).

- [ ] **Step 3: Verify compile + assemble debug**

Run: `cd android && ./gradlew :android:assembleDebug -q`
Expected: BUILD SUCCESSFUL; an APK is produced.

- [ ] **Step 4: Commit**

```bash
git add android/src/main/kotlin/io/sentient/android/MainActivity.kt android/src/main/kotlin/io/sentient/android/auth/LoginScreen.kt
git commit -m "feat(android): gate on backend config + gear entry to setup page"
```

---

## Phase 2 — iOS backend config

### Task 2.1: BackendConfig model + resolver (with tests)

**Files:**
- Create: `ios/App/SDK/BackendConfig.swift`
- Test: `ios/Tests/BackendConfigTests.swift` (Swift Testing; wire into the test target if one exists, else add a `SentientAppTests` target in `project.yml` — see note)

> Note: if `ios/project.yml` has no test target, add one (`SentientAppTests`, `type: bundle.unit-test`, `sources: [Tests]`, `dependencies: [target: SentientApp]`) and regenerate. If the project intentionally ships no unit-test target yet, instead place these assertions as a `#Preview`-adjacent `#expect` is not possible — in that case keep the pure functions and rely on the Android tests for the shared mapping contract, and verify iOS via the e2e matrix. Pick per the repo's current iOS test setup.

- [ ] **Step 1: Write the failing tests**

```swift
import Testing
@testable import SentientApp

struct BackendConfigTests {
    @Test func wssPathContractForValidCert() {
        let c = BackendConfig(host: "host.example", port: 8888, security: .tlsValid)
        #expect(c.gatewayWsURL == "wss://host.example:8888/api/v1/ws")
        #expect(c.allowSelfSigned == false)
    }
    @Test func trustSelfSignedMapsTrueOnWss() {
        let c = BackendConfig(host: "192.168.0.5", port: 8888, security: .tlsTrustSelfSigned)
        #expect(c.gatewayWsURL == "wss://192.168.0.5:8888/api/v1/ws")
        #expect(c.allowSelfSigned == true)
    }
    @Test func plainWsScheme() {
        let c = BackendConfig(host: "10.0.0.2", port: 8888, security: .plainWs)
        #expect(c.gatewayWsURL == "ws://10.0.0.2:8888/api/v1/ws")
        #expect(c.allowSelfSigned == false)
    }
    @Test func overrideWins() {
        let r = resolveBackend(override: BackendConfig(host: "ov", port: 1, security: .tlsValid),
                               buildTimeDefaultURL: "wss://built:8888/api/v1/ws", buildTimeAllowSelfSigned: true)
        #expect(r == .configured(gatewayWsURL: "wss://ov:1/api/v1/ws", allowSelfSignedDevHost: false))
    }
    @Test func buildTimeDefaultUsed() {
        let r = resolveBackend(override: nil, buildTimeDefaultURL: "wss://built:8888/api/v1/ws", buildTimeAllowSelfSigned: true)
        #expect(r == .configured(gatewayWsURL: "wss://built:8888/api/v1/ws", allowSelfSignedDevHost: true))
    }
    @Test func emptyDefaultIsUnconfigured() {
        #expect(resolveBackend(override: nil, buildTimeDefaultURL: "", buildTimeAllowSelfSigned: false) == .unconfigured)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ios && xcodebuild test -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16' -only-testing:SentientAppTests/BackendConfigTests 2>&1 | tail -20`
Expected: FAIL — cannot find `BackendConfig` / `resolveBackend`.

- [ ] **Step 3: Implement `BackendConfig.swift`**

```swift
// ---------------------------------------------------------------------------
// BackendConfig — user-entered backend descriptor + pure resolution to the SDK's
// two transport inputs. Native-owned (no KMP push). The /api/v1/ws path is the
// gateway contract; the security→allowSelfSigned mapping is a security boundary.
// Both are unit-tested.
// ---------------------------------------------------------------------------
import Foundation

/// Gateway WS path — the wire contract with the gateway. Not user-editable.
private let gatewayWSPath = "/api/v1/ws"

enum ConnectionSecurity: String, CaseIterable, Sendable {
    case tlsValid, tlsTrustSelfSigned, plainWs
}

struct BackendConfig: Equatable, Sendable {
    let host: String
    let port: Int
    let security: ConnectionSecurity

    var gatewayWsURL: String {
        let scheme = security == .plainWs ? "ws" : "wss"
        return "\(scheme)://\(host):\(port)\(gatewayWSPath)"
    }
    var allowSelfSigned: Bool { security == .tlsTrustSelfSigned }
}

enum ResolvedBackend: Equatable, Sendable {
    case configured(gatewayWsURL: String, allowSelfSignedDevHost: Bool)
    case unconfigured
}

/// Precedence: override → non-empty build-time default → unconfigured.
func resolveBackend(override: BackendConfig?, buildTimeDefaultURL: String, buildTimeAllowSelfSigned: Bool) -> ResolvedBackend {
    if let o = override { return .configured(gatewayWsURL: o.gatewayWsURL, allowSelfSignedDevHost: o.allowSelfSigned) }
    if !buildTimeDefaultURL.isEmpty { return .configured(gatewayWsURL: buildTimeDefaultURL, allowSelfSignedDevHost: buildTimeAllowSelfSigned) }
    return .unconfigured
}
```

- [ ] **Step 4: Run to verify pass**

Run the same `xcodebuild test` command from Step 2. Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add ios/App/SDK/BackendConfig.swift ios/Tests/BackendConfigTests.swift ios/project.yml
git commit -m "feat(ios): backend config model + precedence resolver"
```

### Task 2.2: BackendConfigStore (UserDefaults)

**Files:**
- Create: `ios/App/SDK/BackendConfigStore.swift`

- [ ] **Step 1: Implement the store**

```swift
// ---------------------------------------------------------------------------
// BackendConfigStore — persists the user-entered BackendConfig in UserDefaults.
// Synchronous read so the first frame knows whether to force the setup page.
// ---------------------------------------------------------------------------
import Foundation

struct BackendConfigStore {
    private let defaults: UserDefaults
    private let kHost = "backend.host"
    private let kPort = "backend.port"
    private let kSecurity = "backend.security"

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    func load() -> BackendConfig? {
        guard let host = defaults.string(forKey: kHost),
              let secRaw = defaults.string(forKey: kSecurity),
              let security = ConnectionSecurity(rawValue: secRaw) else { return nil }
        let port = defaults.integer(forKey: kPort)
        guard (1...65535).contains(port) else { return nil }
        return BackendConfig(host: host, port: port, security: security)
    }

    func save(_ config: BackendConfig) {
        defaults.set(config.host, forKey: kHost)
        defaults.set(config.port, forKey: kPort)
        defaults.set(config.security.rawValue, forKey: kSecurity)
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add ios/App/SDK/BackendConfigStore.swift
git commit -m "feat(ios): persist backend config in UserDefaults"
```

### Task 2.3: GatewayConfig — build-time default from Info.plist + strip literals

**Files:**
- Modify: `ios/App/SDK/GatewayConfig.swift` (full rewrite)

- [ ] **Step 1: Rewrite GatewayConfig**

```swift
// ---------------------------------------------------------------------------
// GatewayConfig — the BUILD-TIME default only. Debug reads GatewayWSURL from the
// bundle (set via Local.xcconfig → Info.plist); absent → localhost fallback.
// Release bakes nothing ("") → the resolver forces the in-app setup page. The
// runtime override (BackendConfigStore) takes precedence over this. No private
// host is hardcoded here.
// ---------------------------------------------------------------------------
import Foundation

enum GatewayConfig {
    /// Build-time default WS URL, or "" when none (release first-launch).
    static let buildTimeDefaultWsURL: String = {
        let fromBundle = (Bundle.main.object(forInfoDictionaryKey: "GatewayWSURL") as? String) ?? ""
        if !fromBundle.isEmpty { return fromBundle }
        #if DEBUG
        return "wss://localhost:8888/api/v1/ws"
        #else
        return ""
        #endif
    }()

    /// The build-time-default trust posture: debug trusts the local dev cert.
    static let buildTimeAllowSelfSigned: Bool = {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }()
}
```

- [ ] **Step 2: Commit**

```bash
git add ios/App/SDK/GatewayConfig.swift
git commit -m "feat(ios): GatewayConfig reads build-time default from bundle; strip private host"
```

### Task 2.4: SdkStore — defer build until configured + reconfigure; resolve in factories

**Files:**
- Modify: `ios/App/SDK/SdkStore.swift`
- Modify: `ios/App/Auth/AuthModel.swift:60-68,168-173`

- [ ] **Step 1: Make SdkStore optional-SDK + configured + reconfigure**

Replace the `init`, the `sdk` property, `makeSdk()`, and add resolution + `reconfigure`:

```swift
    private var sdk: SentientSdk?
    private let tokenStore: SecureTokenStore
    private let configStore = BackendConfigStore()
    private let log = AppLog("sdk", "store")
    private var collectTask: Task<Void, Never>?

    /// True when a usable backend exists (override or non-empty build default).
    @Published private(set) var isConfigured: Bool

    init(tokenStore: SecureTokenStore = createTokenStore()) {
        self.tokenStore = tokenStore
        let resolved = Self.resolve(configStore)
        switch resolved {
        case .configured(let url, let trust):
            let s = createSentientSdk(gatewayWsUrl: url, allowSelfSignedDevHost: trust, capabilities: [])
            self.sdk = s
            self.state = s.state.value
            self.isConfigured = true
            log.info("init configured status=\(self.state.status.name)")
            startCollecting()
        case .unconfigured:
            self.sdk = nil
            self.state = SdkStore.disconnectedState()   // see note
            self.isConfigured = false
            log.info("init unconfigured — forcing setup")
        }
    }

    private static func resolve(_ store: BackendConfigStore) -> ResolvedBackend {
        resolveBackend(override: store.load(),
                       buildTimeDefaultURL: GatewayConfig.buildTimeDefaultWsURL,
                       buildTimeAllowSelfSigned: GatewayConfig.buildTimeAllowSelfSigned)
    }

    /// Apply a saved backend: persist, tear down the old SDK, build the new one
    /// (DISCONNECTED → lands on the new backend's login), clear the stale token.
    func reconfigure(_ config: BackendConfig) {
        log.info("reconfigure host=\(config.host) port=\(config.port) security=\(config.security.rawValue)")
        configStore.save(config)
        tokenStore.clear()
        collectTask?.cancel()
        sdk?.disconnect()
        let s = createSentientSdk(gatewayWsUrl: config.gatewayWsURL,
                                  allowSelfSignedDevHost: config.allowSelfSigned, capabilities: [])
        sdk = s
        state = s.state.value
        isConfigured = true
        startCollecting()
    }
```

Update `startCollecting`, `connect`, `disconnect`, all command methods, and the session ops to guard `sdk` (e.g. `guard let sdk else { return }`). For the StateFlow loop:

```swift
    private func startCollecting() {
        guard let sdk else { return }
        collectTask = Task { [weak self] in
            for await next in sdk.state { self?.apply(next) }
        }
    }
```

> Note `disconnectedState()`: the SDK exposes its initial state via `sdk.state.value`, but with no SDK we need a placeholder. Add a tiny helper that constructs the SDK's initial state. Simplest: build a throwaway SDK is wasteful — instead expose the initial `SdkState` from the SDK. Check `MobileSdk` for a default/initial `SdkState` factory (e.g. `SdkState.companion` or an exported initial). If none is exported, the cleanest fix is: in the `.unconfigured` branch, do NOT render anything that reads `state` (RootView routes unconfigured → setup BEFORE touching `state`), and initialise `state` lazily. Concretely: make `state` a `SdkState?` published — RootView already branches on `isConfigured` first, so `state` is only read when configured. Update `RootView` (Task 2.7) and `ChatView`/`store.state` readers accordingly (force-unwrap is banned — use `if let`). If exporting an initial `SdkState` from the SDK is trivial, prefer that and keep `state` non-optional.

Delete the old `nonisolated static func makeSdk()`.

- [ ] **Step 2: AuthModel builds its client from the resolved config**

In `AuthModel`, the `authClient` default arg currently uses `GatewayConfig.wsUrl`. Since login only happens when configured, resolve from the same store:

```swift
    nonisolated static func makeAuthClient() -> AuthClient {
        let resolved = resolveBackend(override: BackendConfigStore().load(),
                                      buildTimeDefaultURL: GatewayConfig.buildTimeDefaultWsURL,
                                      buildTimeAllowSelfSigned: GatewayConfig.buildTimeAllowSelfSigned)
        guard case let .configured(url, trust) = resolved else {
            // Unreachable: login is only shown when configured. Fall back to the
            // build-time default URL string (possibly "") rather than crash.
            return createAuthClient(gatewayWsUrl: GatewayConfig.buildTimeDefaultWsURL, allowSelfSignedDevHost: false)
        }
        return createAuthClient(gatewayWsUrl: url, allowSelfSignedDevHost: trust)
    }
```

- [ ] **Step 3: Verify build**

Run: `cd ios && xcodebuild build -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16' 2>&1 | tail -20`
Expected: BUILD SUCCEEDED (after RootView update in Task 2.7 if `state` became optional — sequence Task 2.7 before this build if so).

- [ ] **Step 4: Commit**

```bash
git add ios/App/SDK/SdkStore.swift ios/App/Auth/AuthModel.swift
git commit -m "feat(ios): resolve SDK from backend config; defer build + reconfigure for hot-swap"
```

### Task 2.5: BackendSetupViewModel (validate + probe)

**Files:**
- Create: `ios/App/SDK/BackendSetupModel.swift`

- [ ] **Step 1: Implement**

```swift
// ---------------------------------------------------------------------------
// BackendSetupModel — drives the iOS backend setup view. Save folds in a probe
// (createAuthClient → listUsers); success persists + reconfigures the SdkStore
// and signals dismiss; failure shows an error and stays.
// ---------------------------------------------------------------------------
import Foundation
import MobileSdk

@MainActor
final class BackendSetupModel: ObservableObject {
    @Published var host: String
    @Published var port: String
    @Published var security: ConnectionSecurity
    @Published private(set) var isSaving = false
    @Published private(set) var didSave = false
    @Published private(set) var error: String?

    private let reconfigure: (BackendConfig) -> Void
    private let log = AppLog("backend", "setup")

    init(existing: BackendConfig?, reconfigure: @escaping (BackendConfig) -> Void) {
        self.host = existing?.host ?? ""
        self.port = existing.map { String($0.port) } ?? "8888"
        self.security = existing?.security ?? .tlsValid
        self.reconfigure = reconfigure
    }

    func save() {
        guard !host.trimmingCharacters(in: .whitespaces).isEmpty else { error = "Enter a host or IP."; return }
        guard let portInt = Int(port), (1...65535).contains(portInt) else { error = "Port must be 1–65535."; return }
        let candidate = BackendConfig(host: host.trimmingCharacters(in: .whitespaces), port: portInt, security: security)
        log.info("save.probe host=\(candidate.host) port=\(portInt) security=\(security.rawValue)")
        isSaving = true; error = nil
        Task { await probeThenApply(candidate) }
    }

    private func probeThenApply(_ candidate: BackendConfig) async {
        let client = createAuthClient(gatewayWsUrl: candidate.gatewayWsURL, allowSelfSignedDevHost: candidate.allowSelfSigned)
        do {
            let result = try await client.listUsers()
            switch onEnum(of: result) {
            case .success:
                log.info("save.ok")
                reconfigure(candidate)
                isSaving = false; didSave = true
            case .failure:
                log.warn("save.failed")
                isSaving = false; error = "Couldn't verify the server. Check the host, port, and TLS option."
            }
        } catch {
            log.warn("save.threw: \(error)")
            isSaving = false; self.error = "Can't reach that server. Check the host, port, and TLS option."
        }
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add ios/App/SDK/BackendSetupModel.swift
git commit -m "feat(ios): backend setup model with probe-on-save"
```

### Task 2.6: BackendSetupView (SwiftUI)

**Files:**
- Create: `ios/App/SDK/BackendSetupView.swift`

- [ ] **Step 1: Implement**

```swift
// ---------------------------------------------------------------------------
// BackendSetupView — "Sentient backend". Host + Port + 3-way security Picker +
// a Save button that probes then dismisses on success, or shows an error.
// accessibilityIdentifiers: backend-host, backend-port, backend-security,
// backend-save, backend-error.
// ---------------------------------------------------------------------------
import SwiftUI

struct BackendSetupView: View {
    @StateObject var model: BackendSetupModel
    var onSaved: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            Text("Sentient backend").font(.system(size: TypeScale.lg, weight: .semibold)).foregroundStyle(DuskColors.ink)
            Text("Point the app at your Sentient gateway.").font(.system(size: TypeScale.base)).foregroundStyle(DuskColors.ink3)

            TextField("Host or IP", text: $model.host)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .keyboardType(.URL).accessibilityIdentifier("backend-host")
            TextField("Port", text: $model.port)
                .keyboardType(.numberPad).accessibilityIdentifier("backend-port")

            Picker("Security", selection: $model.security) {
                Text("TLS").tag(ConnectionSecurity.tlsValid)
                Text("TLS · self-signed").tag(ConnectionSecurity.tlsTrustSelfSigned)
                Text("Plain ws").tag(ConnectionSecurity.plainWs)
            }
            .pickerStyle(.segmented).accessibilityIdentifier("backend-security")

            if model.security == .tlsTrustSelfSigned {
                Text("Trusts a self-signed certificate for this server only. Use for LAN/self-hosted gateways.")
                    .font(.system(size: TypeScale.xs)).foregroundStyle(DuskColors.ink3)
            }
            if let error = model.error {
                Text(error).foregroundStyle(DuskColors.stop).accessibilityIdentifier("backend-error")
            }

            Button(action: model.save) {
                Group {
                    if model.isSaving { ProgressView() }
                    else if model.didSave { Text("✓") }
                    else { Text("Save & connect") }
                }
                .frame(maxWidth: .infinity).padding(.vertical, Space.sm)
            }
            .buttonStyle(.borderedProminent).disabled(model.isSaving).accessibilityIdentifier("backend-save")
            Spacer()
        }
        .padding(Space.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(DuskColors.bg)
        .duskTheme()
        .onChange(of: model.didSave) { _, saved in if saved { onSaved() } }
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add ios/App/SDK/BackendSetupView.swift
git commit -m "feat(ios): backend setup view UI"
```

### Task 2.7: RootView 3-way gating + gear on login

**Files:**
- Modify: `ios/App/RootView.swift`
- Modify: `ios/App/Auth/LoginView.swift` (add a gear)

- [ ] **Step 1: Gate in RootView**

```swift
import SwiftUI
import MobileSdk

struct RootView: View {
    @EnvironmentObject private var store: SdkStore
    @State private var showSetupOverride = false

    var body: some View {
        Group {
            if !store.isConfigured || showSetupOverride {
                BackendSetupView(
                    model: BackendSetupModel(
                        existing: BackendConfigStore().load(),
                        reconfigure: { store.reconfigure($0) }
                    ),
                    onSaved: { showSetupOverride = false }
                )
            } else if store.state.status == .ready {
                ChatView()
            } else {
                LoginView(onConnect: { store.connect() },
                          onOpenBackendSetup: { showSetupOverride = true })
            }
        }
    }
}
```

> If Task 2.4 made `store.state` optional, branch `if let s = store.state, s.status == .ready`. Keep the `!store.isConfigured` branch first so `state` is never read while unconfigured.

- [ ] **Step 2: Add the gear to LoginView**

In `LoginView`, add `var onOpenBackendSetup: () -> Void` and overlay a gear in the top-trailing corner (e.g. `.overlay(alignment: .topTrailing) { Button { onOpenBackendSetup() } label: { Image(systemName: "gearshape") } .padding().accessibilityIdentifier("login-backend-setup") }`). Match the existing LoginView container.

- [ ] **Step 3: Verify build**

Run: `cd ios && xcodebuild build -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16' 2>&1 | tail -20`
Expected: BUILD SUCCEEDED.

- [ ] **Step 4: Commit**

```bash
git add ios/App/RootView.swift ios/App/Auth/LoginView.swift
git commit -m "feat(ios): gate on backend config + gear entry to setup page"
```

---

## Phase 3 — Verification (inline e2e matrix)

> Native mobile e2e is simulator/manual (Playwright can't drive native — `.claude/rules/e2e-testing.md`). Run the matrix from the design spec (`docs/superpowers/specs/2026-06-04-mobile-backend-configurability-design.md`). Gate before merge: unit tests green, both apps build, every matrix row checked on at least one platform, logs show the expected `force-setup` / `save.ok` / `reconfigure` / resolved-source trail.

- [ ] **Step 1: Android — `./gradlew :android:testDebugUnitTest -q` green; `assembleDebug` produces an APK.**
- [ ] **Step 2: iOS — `xcodebuild test` (BackendConfigTests) green; `xcodebuild build` succeeds.**
- [ ] **Step 3: Run the design-spec e2e matrix on a simulator/emulator** — at minimum: release-first-launch forces setup; save valid backend → checkmark → login; save unreachable → error + stay; debug fallback (no local file) → straight to login; change-backend-via-gear → rebuild → new backend login; persistence across relaunch. Capture screenshots + the log trail.
- [ ] **Step 4: Confirm no private host remains in the working tree:** `git grep -n 'home.dev32.io\|192.168.0.222' -- android ios` returns nothing.
- [ ] **Step 5: Final commit / open PR** per `.claude/rules/git-workflow.md` (feature branch → develop).

---

## Self-Review (completed during authoring)

- **Spec coverage:** build-time default file (0.1–0.3), de-hardcode (0.1, 0.3, P3 step 4), runtime setup UI + gear + forced (1.6/1.7, 2.6/2.7), host+port+3-way (1.6/2.6), probe-folded-into-save + checkmark + dismiss (1.5/2.5, 1.6/2.6), hot-swap no-restart (1.3/1.4 Android reactive, 2.4 iOS reconfigure), precedence + release-forces-setup (1.1/2.1 tests), trust-self-signed mapping (1.1/2.1 tests), keep bundle ID (untouched), no history rewrite (P0 forward-only). All covered.
- **Type consistency:** `ConnectionSecurity {tlsValid|tlsTrustSelfSigned|plainWs}` / `{TLS_VALID|TLS_TRUST_SELF_SIGNED|PLAIN_WS}`, `ResolvedBackend.{configured/Configured, unconfigured/Unconfigured}`, `resolveBackend(override, buildTimeDefault*, ...)`, `SdkHolder.{isConfigured, ensureBuilt, applyResolvedConfig, sdkFlow}`, `SdkStore.{isConfigured, reconfigure}` — used consistently across tasks.
- **Open risk flagged inline:** iOS `SdkStore.state` placeholder when unconfigured (Task 2.4 note); `SegmentedButton` API version check (Task 1.6); iOS test-target existence (Task 2.1). Each has a concrete fallback.
