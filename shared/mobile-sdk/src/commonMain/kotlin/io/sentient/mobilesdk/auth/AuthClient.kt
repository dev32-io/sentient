package io.sentient.mobilesdk.auth

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
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
            log.info("login.result", mapOf("userId" to userId, "status" to response.status.value))
            if (response.status == HttpStatusCode.Unauthorized) {
                log.warn("login.rejected", mapOf("userId" to userId, "reason" to "invalid-credentials"))
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

    // ── Internal helpers ───────────────────────────────────────────────────────

    private suspend fun <T> mapResponse(
        response: HttpResponse,
        parse: suspend (HttpResponse) -> T,
    ): AuthResult<T> {
        if (!response.status.value.toString().startsWith("2")) {
            val body = runCatching { response.bodyAsText() }.getOrDefault("")
            log.warn("http.error", mapOf("status" to response.status.value))
            return AuthResult.Failure(AuthError.Server(status = response.status.value, body = body))
        }
        return runCatching { AuthResult.Success(parse(response)) }
            .getOrElse { e ->
                log.warn("parse.error", mapOf("cause" to (e.message ?: "unknown")))
                AuthResult.Failure(AuthError.Unknown(cause = e.message ?: "parse error"))
            }
    }

    private suspend fun <T> safeCall(block: suspend () -> AuthResult<T>): AuthResult<T> =
        runCatching { block() }.getOrElse { e ->
            log.warn("network.error", mapOf("cause" to (e.message ?: "unknown")))
            AuthResult.Failure(AuthError.Network(cause = e.message ?: "network error"))
        }
}
