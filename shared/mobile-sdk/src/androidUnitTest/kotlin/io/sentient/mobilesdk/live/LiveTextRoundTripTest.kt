// ---------------------------------------------------------------------------
// LiveTextRoundTripTest — the C8 @live harness (Phase-1 gate, S2).
//
// These tests reach the REAL local stack — they are NOT part of the default
// unit/contract suite. They live in androidUnitTest because the JVM host of
// testDebugUnitTest can open real HTTP / WS sockets through the OkHttp engine,
// which commonTest's MockEngine-only / network-less native targets cannot.
//
// GATING (the mechanism that keeps these OUT of `allTests` / a normal
// `testDebugUnitTest`):
//   - EVERY test early-returns (Assume-style) unless env `SENTIENT_LIVE == "1"`.
//     A normal `./gradlew :shared:mobile-sdk:allTests` (and the bun CI gate)
//     runs with SENTIENT_LIVE unset, so all three skip with zero network.
//   - Case 3 (the real round-trip) ADDITIONALLY early-returns unless the
//     operator supplies SENTIENT_PIN (a valid PIN is the operator's; the agent
//     does not have it). Cases 1 + 2 need no PIN and run on the no-PIN gate.
//
// HOW TO RUN
//   Cases 1 + 2 (no PIN — proves the live auth wire + 401 mapping):
//     SENTIENT_LIVE=1 ./gradlew :shared:mobile-sdk:testDebugUnitTest \
//       --tests "*LiveTextRoundTripTest*"
//
//   Case 3 (OPERATOR ONLY — needs the real PIN; makes Hermes call its LLM once):
//     SENTIENT_LIVE=1 SENTIENT_USER_ID=u_8c866990 SENTIENT_PIN=<kevins-pin> \
//       ./gradlew :shared:mobile-sdk:testDebugUnitTest \
//       --tests "*live_text_round_trip*"
//   Optional: SENTIENT_GW_URL=wss://localhost:8888/api/v1/ws (the default).
//
// SECURITY: allowSelfSignedDevHost=true is the DEV-ONLY localhost self-signed
// bypass — the same flag the app passes from a debug BuildConfig. The PIN and
// token values are never logged (AuthClient already redacts them).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.live

import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.serialization.kotlinx.json.json
import io.sentient.mobilesdk.auth.AuthClient
import io.sentient.mobilesdk.auth.AuthError
import io.sentient.mobilesdk.auth.AuthResponse
import io.sentient.mobilesdk.auth.AuthResult
import io.sentient.mobilesdk.auth.AuthUserLite
import io.sentient.mobilesdk.fakes.InMemoryDeviceIdStore
import io.sentient.mobilesdk.fakes.InMemoryTokenStore
import io.sentient.mobilesdk.sdk.PlatformBundle
import io.sentient.mobilesdk.sdk.SdkConfig
import io.sentient.mobilesdk.sdk.SentientSdk
import io.sentient.mobilesdk.transport.AndroidWebSocketEngine
import io.sentient.mobilesdk.transport.SdkStatus
import io.sentient.mobilesdk.util.Clock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import okhttp3.OkHttpClient
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

// ── Live-gate + endpoint constants ──

/** Master gate: every @live test no-ops unless this env equals "1". */
private const val ENV_LIVE = "SENTIENT_LIVE"
private const val ENV_USER_ID = "SENTIENT_USER_ID"
private const val ENV_PIN = "SENTIENT_PIN"
private const val ENV_GW_URL = "SENTIENT_GW_URL"

private const val DEFAULT_GW_URL = "wss://localhost:8888/api/v1/ws"
private const val SEEDED_USER_ID = "u_8c866990"
private const val OBVIOUSLY_WRONG_PIN = "0000"

/** Real-time budget for the full round-trip (login → READY → assistant reply). */
private const val ROUND_TRIP_TIMEOUT_MS = 30_000L
private const val READY_TIMEOUT_MS = 15_000L

private const val ROLE_ASSISTANT = "assistant"

/**
 * @live text round-trip + live auth-wire checks against the running local stack.
 *
 * Tagged `@live` by convention (name + KDoc); the env-gate — not a JUnit
 * category — is what excludes them from the default run, so no build wiring is
 * needed to keep `allTests` clean.
 */
class LiveTextRoundTripTest {

    private fun liveEnabled(): Boolean = System.getenv(ENV_LIVE) == "1"

    private fun gatewayWsUrl(): String = System.getenv(ENV_GW_URL) ?: DEFAULT_GW_URL

    /** Trust-all OkHttp HttpClient for the localhost self-signed REST endpoints (DEV ONLY). */
    private fun devHttpClient(): HttpClient {
        val trustAll = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = Unit
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) = Unit
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        val sslContext = SSLContext.getInstance("TLS").apply {
            init(null, arrayOf<TrustManager>(trustAll), SecureRandom())
        }
        val okHttp = OkHttpClient.Builder()
            .sslSocketFactory(sslContext.socketFactory, trustAll)
            .hostnameVerifier { _, _ -> true }
            .build()
        return HttpClient(OkHttp) {
            engine { preconfigured = okHttp }
            install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
        }
    }

    private fun authClient(): AuthClient =
        AuthClient(gatewayWsUrl = gatewayWsUrl(), httpClient = devHttpClient())

    // ── Case 1 — listUsers against the live gateway (NO PIN) ────────────────────

    /**
     * @live — proves AuthClient.listUsers() parses the live gateway's bare
     * PublicUser[] array and finds the seeded user. No PIN needed.
     */
    @Test
    fun live_list_users_returns_seeded_user() = runBlocking {
        if (!liveEnabled()) {
            println("[live] SKIP live_list_users_returns_seeded_user — $ENV_LIVE != 1")
            return@runBlocking
        }
        val result = authClient().listUsers()
        assertIs<AuthResult.Success<List<AuthUserLite>>>(
            result,
            "listUsers should succeed against the live gateway",
        )
        val users = result.value
        assertTrue(users.isNotEmpty(), "live gateway should return ≥1 seeded user")
        val ids = users.map { it.userId }
        assertTrue(
            ids.contains(SEEDED_USER_ID),
            "seeded user $SEEDED_USER_ID should be present; got $ids",
        )
        println("[live] list_users OK — ${users.size} user(s), contains $SEEDED_USER_ID")
    }

    // ── Case 2 — login with a wrong PIN → InvalidCredentials (NO PIN) ───────────

    /**
     * @live — proves the auth wire + the live 401 → AuthError.InvalidCredentials
     * mapping end-to-end. Uses ONE obviously-wrong PIN (no brute force).
     */
    @Test
    fun live_login_with_wrong_pin_returns_invalid_credentials() = runBlocking {
        if (!liveEnabled()) {
            println("[live] SKIP live_login_with_wrong_pin_returns_invalid_credentials — $ENV_LIVE != 1")
            return@runBlocking
        }
        val result = authClient().login(userId = SEEDED_USER_ID, pin = OBVIOUSLY_WRONG_PIN)
        assertIs<AuthResult.Failure>(result, "a wrong PIN must fail")
        assertEquals(
            AuthError.InvalidCredentials,
            result.error,
            "live 401 must map to AuthError.InvalidCredentials",
        )
        println("[live] wrong_pin OK — mapped to AuthError.InvalidCredentials")
    }

    // ── Case 3 — full text round-trip (OPERATOR ONLY — needs real PIN) ──────────

    /**
     * @live — login → save token → connect → READY → sendText("hello") → assert an
     * assistant reply lands in sdk.timeline within [ROUND_TRIP_TIMEOUT_MS].
     *
     * OPERATOR ONLY: gated behind SENTIENT_PIN (a valid PIN is the operator's).
     * Without it this early-returns. Running it makes Hermes call its configured
     * LLM once — the operator's spend decision.
     */
    @Test
    fun live_text_round_trip() = runBlocking {
        if (!liveEnabled()) {
            println("[live] SKIP live_text_round_trip — $ENV_LIVE != 1")
            return@runBlocking
        }
        val pin = System.getenv(ENV_PIN)
        if (pin.isNullOrBlank()) {
            println("[live] SKIP live_text_round_trip — $ENV_PIN unset (operator-run only)")
            return@runBlocking
        }
        val userId = System.getenv(ENV_USER_ID) ?: SEEDED_USER_ID
        runRoundTrip(userId = userId, pin = pin)
    }

    private suspend fun runRoundTrip(userId: String, pin: String) {
        // 1. login → token (PIN is never logged by AuthClient).
        val login = authClient().login(userId = userId, pin = pin)
        assertIs<AuthResult.Success<AuthResponse>>(login, "login should succeed with the operator PIN")
        val token = login.value.token

        // 2. save token + build the SDK over the REAL OkHttp WS engine.
        val tokenStore = InMemoryTokenStore().apply { save(token) }
        val scope = CoroutineScope(SupervisorJob())
        val sdk = SentientSdk(
            config = SdkConfig(
                gatewayWsUrl = gatewayWsUrl(),
                allowSelfSignedDevHost = true,
                capabilities = listOf("text.input", "conversation.history"),
            ),
            bundle = PlatformBundle(
                engine = AndroidWebSocketEngine(),
                tokenStore = tokenStore,
                deviceIdStore = InMemoryDeviceIdStore("dev-live-test"),
                clock = Clock { System.currentTimeMillis() },
            ),
            scope = scope,
            // Park idle far beyond the round-trip horizon.
            idleTickMs = 1_000_000_000L,
        )
        try {
            // 3. connect → READY.
            sdk.connect()
            val ready = withTimeoutOrNull(READY_TIMEOUT_MS) {
                sdk.connection.first { it.status == SdkStatus.READY }
            }
            assertTrue(ready != null, "SDK should reach READY within ${READY_TIMEOUT_MS}ms")
            println("[live] connected → READY")

            // 4. sendText → wait for a committed assistant message in the timeline.
            sdk.sendText("hello")
            val withReply = withTimeoutOrNull(ROUND_TRIP_TIMEOUT_MS) {
                sdk.timeline.first { msgs ->
                    msgs.any { it.role == ROLE_ASSISTANT && !it.streaming && it.content.isNotBlank() }
                }
            }
            assertTrue(
                withReply != null,
                "an assistant reply should arrive within ${ROUND_TRIP_TIMEOUT_MS}ms",
            )
            val reply = withReply.last { it.role == ROLE_ASSISTANT && !it.streaming }
            // cycleId correlation: the gateway stamps each cycle; the reply commit
            // is the cycle.done terminal. Log a short preview (≤120 chars) only.
            println(
                "[live] round_trip OK — assistant reply: \"" +
                    reply.content.take(120) + "\" (timeline=${withReply.size})",
            )
        } finally {
            sdk.disconnect()
            scope.cancel()
        }
    }
}
