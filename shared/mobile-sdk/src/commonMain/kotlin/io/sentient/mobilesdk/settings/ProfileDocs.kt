// ---------------------------------------------------------------------------
// ProfileDocs — SOUL / memory / personality document models + the ApplyResult
// type shared by every "slow save" mutation that blocks through a Hermes restart.
//
// Wire sources:
//   gateway/src/api/handlers/profile-edit.ts        (soul, memory, personalities)
//   gateway/src/api/handlers/profile.ts             (POST /profile/apply)
//   gateway/src/api/handlers/profile-edit-personalities.ts  (PersonalityList)
//
// The soul/memory PUTs and the personality mutations all invoke the restart
// orchestrator and return its outcome (`{state:"ready",elapsedMs}`); POST
// /profile/apply returns `{status:"ready",elapsedMs}` and can additionally 429
// with `{error:"apply-in-progress"}`. All of these collapse into [ApplyResult].
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.settings

import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.isSuccess
import io.sentient.mobilesdk.log.Log
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** GET /api/v1/profile/soul → {content, lastModified}. */
@Serializable
data class SoulDoc(val content: String, val lastModified: String? = null)

/** GET /api/v1/profile/soul/default → {content}. */
@Serializable
data class SoulDefaultDoc(val content: String)

/**
 * GET /api/v1/profile/memory/{slot} → {content, lastModified, charLimit}.
 * `charLimit` is the upstream Hermes cap the editor enforces as a hard textarea limit.
 */
@Serializable
data class MemoryDoc(val content: String, val lastModified: String? = null, val charLimit: Int)

/** Memory file slot — path segment on /profile/memory/{slot}. */
enum class MemorySlot(val slug: String) {
    MEMORY("memory"),
    USER("user"),
}

/** One entry in the personalities YAML map. */
@Serializable
data class Personality(val name: String, val body: String)

/** GET /api/v1/profile/personalities → {personalities, activeName}. */
@Serializable
data class PersonalityList(
    val personalities: List<Personality> = emptyList(),
    val activeName: String? = null,
)

/** Parsed elapsedMs from a restart/apply success body (accepts `state` or `status` key). */
@Serializable
private data class ApplyReadyBody(val elapsedMs: Long = 0L)

/**
 * Outcome of a mutation that triggers a Hermes restart (apply, soul/memory PUT,
 * personality CRUD). 429 apply-in-progress is a first-class product state, not
 * an error — the UI shows "already applying".
 */
sealed class ApplyResult {
    /** 2xx — the worker restarted and is ready. */
    data class Ready(val elapsedMs: Long) : ApplyResult()

    /** 429 — another apply is already running for this user. */
    data object InProgress : ApplyResult()

    /** Non-2xx (422 render/write/name-conflict, 502 docker-restart, 504 health-timeout, 500). */
    data class Failed(val status: Int, val code: String?) : ApplyResult()

    /** Transport failure — the request never reached the server. */
    class Network(@Suppress("UNUSED_PARAMETER") cause: String) : ApplyResult() {
        val cause: String = "transport-failure"
    }
}

private const val HTTP_TOO_MANY = 429

/** Maps a settled restart/apply response to an [ApplyResult]. Reads the body once. */
internal suspend fun mapApplyResponse(log: Log, response: HttpResponse, json: Json): ApplyResult {
    val status = response.status.value
    if (response.status.isSuccess()) {
        val body = runCatching { response.bodyAsText() }.getOrDefault("")
        val elapsedMs = runCatching { json.decodeFromString(ApplyReadyBody.serializer(), body).elapsedMs }
            .getOrDefault(0L)
        log.info("apply.ready", mapOf("status" to status, "elapsedMs" to elapsedMs))
        return ApplyResult.Ready(elapsedMs)
    }
    if (status == HTTP_TOO_MANY) {
        log.warn("apply.in-progress", mapOf("status" to status))
        return ApplyResult.InProgress
    }
    val code = runCatching {
        val body = response.bodyAsText()
        json.parseToJsonElement(body).jsonObject["error"]?.jsonPrimitive?.contentOrNull
    }.getOrNull()
    val safeCode = normalizeApplyFailureCode(code)
    log.warn("apply.failed", mapOf("status" to status, "code" to safeCode))
    return ApplyResult.Failed(status = status, code = safeCode)
}

private fun normalizeApplyFailureCode(code: String?): String? = when (code) {
    "name-conflict",
    "userId-mismatch",
    "invalid-input",
    "unauthorized",
    "forbidden",
    "not-found",
    "restart-timeout",
    -> code
    else -> if (code == null) null else "server-error"
}

/** Wraps an apply/restart call so a transport failure becomes ApplyResult.Network, never a throw. */
internal suspend fun safeApplyCall(log: Log, block: suspend () -> ApplyResult): ApplyResult =
    runCatching { block() }.getOrElse {
        log.warn("apply.network-error", mapOf("code" to "transport-failure"))
        ApplyResult.Network(cause = "transport-failure")
    }
