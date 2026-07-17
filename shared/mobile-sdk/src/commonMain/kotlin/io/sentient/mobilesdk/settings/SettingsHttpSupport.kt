// ---------------------------------------------------------------------------
// SettingsHttpSupport — shared helpers for the settings REST clients.
//
// The settings clients mirror the AuthClient / SessionsHttpClient conventions:
//   - HttpClient injected by the platform caller (OkHttp / Darwin engine).
//   - Gateway WS URL derived to the HTTP base via auth.deriveBaseUrl.
//   - PASETO bearer token supplied per call by a () -> String provider.
//   - Every op returns a typed result — NEVER throws across the KMP boundary.
//
// Result envelope: reuses the module's existing AuthResult<T> / AuthError sealed
// types (io.sentient.mobilesdk.auth) rather than inventing a new one. All
// non-2xx statuses map to AuthError.Server(status, body) so the repository
// layer can branch on the status code (422 userId-mismatch, 409 name-conflict,
// 401 expired-token, …). Apply / restart mutations use the dedicated
// [ApplyResult] type instead, because 429 apply-in-progress is a first-class
// product state, not an error.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.settings

import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.isSuccess
import io.sentient.mobilesdk.auth.AuthError
import io.sentient.mobilesdk.auth.AuthResult
import io.sentient.mobilesdk.log.Log
import kotlinx.serialization.json.Json

/**
 * JSON used for REQUEST bodies. `explicitNulls = false` guarantees that a
 * nullable-defaulted Kotlin property (e.g. ProfileTools.toolsets, ProfileV1.devices)
 * is OMITTED rather than emitted as `null` — the gateway's zod `.optional()`
 * fields reject an explicit `null`, so omission is the only round-trip-safe shape.
 */
internal val settingsBodyJson: Json = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
    explicitNulls = false
}

/**
 * Maps a settled [HttpResponse] to an [AuthResult]. 2xx → parse via [parse];
 * any other status → [AuthError.Server] carrying the status + raw body; a parse
 * failure → [AuthError.Unknown]. Never reads the body twice.
 */
internal suspend fun <T> mapSettingsResponse(
    log: Log,
    response: HttpResponse,
    parse: suspend (HttpResponse) -> T,
): AuthResult<T> {
    if (!response.status.isSuccess()) {
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

/** Wraps a client call so a transport failure becomes AuthError.Network, never a throw. */
internal suspend fun <T> safeSettingsCall(log: Log, block: suspend () -> AuthResult<T>): AuthResult<T> =
    runCatching { block() }.getOrElse { e ->
        log.warn("network.error", mapOf("cause" to (e.message ?: "unknown")))
        AuthResult.Failure(AuthError.Network(cause = e.message ?: "network error"))
    }
