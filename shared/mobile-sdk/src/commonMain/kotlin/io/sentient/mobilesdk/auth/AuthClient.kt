package io.sentient.mobilesdk.auth

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.sentient.mobilesdk.log.Log
import io.sentient.mobilesdk.log.createLogger

// ── Named path constants relative to the /api/v1 base URL ──
// baseUrl already ends at /api/v1 (derived from wss://host/api/v1/ws).

private const val PATH_LIST_USERS = "/auth/users"
private const val PATH_LOGIN = "/auth/login"
private const val PATH_ME = "/auth/me"
private const val PATH_CHANGE_PIN = "/auth/me/pin"
private const val PATH_LOGOUT = "/auth/logout"

/**
 * Derives the HTTPS/HTTP base URL from the gateway WebSocket URL.
 *
 * Examples:
 *   wss://host:3000/api/v1/ws → https://host:3000/api/v1
 *   ws://localhost:3000/api/v1/ws  → http://localhost:3000/api/v1
 */
fun deriveBaseUrl(gatewayWsUrl: String): String {
    val http = when {
        gatewayWsUrl.startsWith("wss://") ->
            "https://" + gatewayWsUrl.removePrefix("wss://")
        gatewayWsUrl.startsWith("ws://") ->
            "http://" + gatewayWsUrl.removePrefix("ws://")
        else -> gatewayWsUrl
    }
    return http.removeSuffix("/ws")
}

/**
 * HTTP client for the gateway REST auth endpoints.
 *
 * [httpClient] is injected so tests can supply a MockEngine-backed client and
 * production code can supply the platform OkHttp/Darwin client configured with
 * ContentNegotiation(Json). The caller owns the client lifecycle.
 *
 * [log] is injected so tests can supply a no-op logger; defaults to the
 * platform logger for production use.
 *
 * All operations return a typed [AuthResult] — never throw from business logic.
 * The pin and token values are NEVER logged.
 */
class AuthClient(
    gatewayWsUrl: String,
    private val httpClient: HttpClient,
    private val log: Log = createLogger("auth", "client"),
) {
    private val baseUrl = deriveBaseUrl(gatewayWsUrl)

    // ── listUsers ──────────────────────────────────────────────────────────────

    /**
     * GET /api/v1/auth/users
     *
     * Returns a bare JSON array of [AuthUserLite] (userId, displayName, avatarTint).
     * NOTE: the gateway returns a bare array, NOT {users:[...]}. See
     * handleListUsers in auth.ts: Response.json(r.value) where r.value is PublicUser[].
     */
    suspend fun listUsers(): AuthResult<List<AuthUserLite>> {
        log.info("listUsers.start")
        return safeCall {
            val response = httpClient.get("$baseUrl$PATH_LIST_USERS")
            log.info("listUsers.result", mapOf("status" to response.status.value))
            mapResponse(response) { it.body<List<AuthUserLite>>() }
        }
    }

    // ── login ──────────────────────────────────────────────────────────────────

    /**
     * POST /api/v1/auth/login
     *
     * Body: {userId, pin}. On 200 returns {token, user}. On 401 returns
     * [AuthError.InvalidCredentials] (gateway error code "invalid-credentials").
     * The pin value is NEVER logged.
     */
    suspend fun login(userId: String, pin: String): AuthResult<AuthResponse> {
        log.info("login.start", mapOf("userId" to userId))
        return safeCall {
            val response = httpClient.post("$baseUrl$PATH_LOGIN") {
                contentType(ContentType.Application.Json)
                setBody(LoginRequest(userId = userId, pin = pin))
            }
            log.info("login.result", mapOf("userIdLength" to userId.length, "status" to response.status.value))
            if (response.status == HttpStatusCode.Unauthorized) {
                log.warn("login.rejected", mapOf("userIdLength" to userId.length, "code" to "invalid-credentials"))
                return@safeCall AuthResult.Failure(AuthError.InvalidCredentials)
            }
            mapResponse(response) { it.body<AuthResponse>() }
        }
    }

    // ── me ─────────────────────────────────────────────────────────────────────

    /**
     * GET /api/v1/auth/me
     *
     * Validates the token and returns a refreshed [AuthResponse]. The gateway
     * calls tokens.refresh(token) so the returned token is always a new one.
     * Sends Authorization: Bearer <token>. Token value is NEVER logged.
     * On any 401 returns [AuthError.InvalidCredentials].
     */
    suspend fun me(token: String): AuthResult<AuthResponse> {
        log.info("me.start")
        return safeCall {
            val response = httpClient.get("$baseUrl$PATH_ME") {
                header(HttpHeaders.Authorization, "Bearer $token")
            }
            log.info("me.result", mapOf("status" to response.status.value))
            if (response.status == HttpStatusCode.Unauthorized) {
                log.warn("me.rejected", mapOf("reason" to "auth-failure"))
                return@safeCall AuthResult.Failure(AuthError.InvalidCredentials)
            }
            mapResponse(response) { it.body<AuthResponse>() }
        }
    }

    // ── updateMe ─────────────────────────────────────────────────────────────

    /**
     * PUT /api/v1/auth/me  body {displayName}. Returns a refreshed [AuthResponse]
     * (same shape as [me]). On 401 → [AuthError.InvalidCredentials] (token expired).
     * Sends Authorization: Bearer <token>. Token value is NEVER logged.
     */
    suspend fun updateMe(token: String, displayName: String): AuthResult<AuthResponse> {
        log.info("updateMe.start", mapOf("displayNameLen" to displayName.length))
        return safeCall {
            val response = httpClient.put("$baseUrl$PATH_ME") {
                header(HttpHeaders.Authorization, "Bearer $token")
                contentType(ContentType.Application.Json)
                setBody(UpdateMeRequest(displayName = displayName))
            }
            log.info("updateMe.result", mapOf("status" to response.status.value))
            if (response.status == HttpStatusCode.Unauthorized) {
                return@safeCall AuthResult.Failure(AuthError.InvalidCredentials)
            }
            mapResponse(response) { it.body<AuthResponse>() }
        }
    }

    // ── changePin ────────────────────────────────────────────────────────────

    /**
     * PUT /api/v1/auth/me/pin  body {currentPin, newPin} → 200 {ok:true}.
     * Wrong current pin → gateway 401 invalid-credentials → [AuthError.InvalidCredentials]
     * (no token drop; the caller shows an inline error). Pin values are NEVER logged.
     */
    suspend fun changePin(token: String, currentPin: String, newPin: String): AuthResult<Unit> {
        log.info("changePin.start")
        return safeCall {
            val response = httpClient.put("$baseUrl$PATH_CHANGE_PIN") {
                header(HttpHeaders.Authorization, "Bearer $token")
                contentType(ContentType.Application.Json)
                setBody(ChangePinRequest(currentPin = currentPin, newPin = newPin))
            }
            log.info("changePin.result", mapOf("status" to response.status.value))
            if (response.status == HttpStatusCode.Unauthorized) {
                return@safeCall AuthResult.Failure(AuthError.InvalidCredentials)
            }
            mapResponse(response) { }
        }
    }

    // ── logout ───────────────────────────────────────────────────────────────

    /**
     * POST /api/v1/auth/logout → 200 {ok:true}. Server-side logout is a noop today
     * (token revocation deferred); the client still clears its stored token on success.
     */
    suspend fun logout(token: String): AuthResult<Unit> {
        log.info("logout.start")
        return safeCall {
            val response = httpClient.post("$baseUrl$PATH_LOGOUT") {
                header(HttpHeaders.Authorization, "Bearer $token")
            }
            log.info("logout.result", mapOf("status" to response.status.value))
            mapResponse(response) { }
        }
    }

    // ── Internal helpers ───────────────────────────────────────────────────────

    private suspend fun <T> mapResponse(
        response: HttpResponse,
        parse: suspend (HttpResponse) -> T,
    ): AuthResult<T> {
        if (!response.status.value.toString().startsWith("2")) {
            val body = runCatching { response.bodyAsText() }.getOrDefault("")
            log.warn("http.error", mapOf("status" to response.status.value, "code" to "server-response"))
            return AuthResult.Failure(AuthError.Server(status = response.status.value, body = body))
        }
        return runCatching { AuthResult.Success(parse(response)) }
            .getOrElse {
                log.warn("parse.error", mapOf("code" to "decode-failure"))
                AuthResult.Failure(AuthError.Unknown(cause = "decode-failure"))
            }
    }

    private suspend fun <T> safeCall(block: suspend () -> AuthResult<T>): AuthResult<T> =
        runCatching { block() }.getOrElse {
            log.warn("network.error", mapOf("code" to "transport-failure"))
            AuthResult.Failure(AuthError.Network(cause = "transport-failure"))
        }
}
