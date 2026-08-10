// ---------------------------------------------------------------------------
// PermissionConnector — the L3 `confirm` prompt seam (design §7.1).
//
//   permission.request  → open a prompt (keyed by requestId), fire a ONE-SHOT
//                         SdkEvent.PermissionRequested, publish the open list.
//   permission.response → outbound, carrying the user's Allow / Deny.
//   permission.resolved → the gateway resolved first (answered elsewhere, or the
//                         fail-closed 2-minute timeout) → dismiss + fire the outcome.
//
// FAIL-CLOSED: this connector never approves anything on its own. [reset] and a
// dropped socket drop the prompt locally; the gateway's own timer denies it server-side.
//
// PRIVACY: `args` and `description` are USER CONTENT (a message body, a file path).
// Log ids, tool name, and the argument-key COUNT only — never a value. Pinned by
// PrivacyGuardTest.permission_request_arguments_are_never_logged.
//
// Threading: single-threaded; the router drives handle() and the orchestrator drives
// respond() on the same dispatcher. The open map is owned here.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.protocol.ServerMessage
import kotlinx.serialization.json.JsonPrimitive

/**
 * One open permission prompt, projected for the UI. [args] is flattened to a String map
 * so Compose and SwiftUI (via SKIE) render it without touching kotlinx JSON types:
 * a primitive contributes its unquoted content, a nested object/array its compact JSON.
 */
data class PermissionPrompt(
    val requestId: String,
    val toolCallId: String,
    val toolName: String,
    val args: Map<String, String>,
    val description: String,
    val expiresAtMs: Long,
)

class PermissionConnector(
    private val send: (ClientMessage) -> Unit,
    private val onPending: ((List<PermissionPrompt>) -> Unit)? = null,
    private val onEvent: ((SdkEvent) -> Unit)? = null,
) : Connector {
    override val capability: String = CAPABILITY

    private val log = createLogger("connector", "permission")

    private val open = LinkedHashMap<String, PermissionPrompt>()

    /** Every still-open prompt, in arrival order. Safe to read synchronously. */
    fun pending(): List<PermissionPrompt> = open.values.toList()

    override fun handle(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.PermissionRequest -> onRequest(msg)
            is ServerMessage.PermissionResolved -> onResolved(msg.requestId, msg.outcome)
            else -> Unit // not owned by this connector
        }
    }

    /** User decision → permission.response. Dismisses locally; the gateway's
     *  permission.resolved echo is then a no-op (idempotent by requestId). */
    fun respond(requestId: String, approved: Boolean) {
        val known = open.remove(requestId) != null
        log.info(
            "respond",
            mapOf("requestId" to requestId, "approved" to approved, "known" to known, "open" to open.size),
        )
        send(ClientMessage.PermissionResponse(requestId = requestId, approved = approved))
        onPending?.invoke(pending())
    }

    /** Drop every open prompt (session switch / interrupt / logout). Fail-closed:
     *  nothing is auto-approved — the gateway denies on its own 2-minute timeout. */
    fun reset() {
        if (open.isEmpty()) return
        log.info("reset", mapOf("dropped" to open.size, "reason" to "session-scope-cleared"))
        open.clear()
        onPending?.invoke(pending())
    }

    private fun onRequest(msg: ServerMessage.PermissionRequest) {
        val prompt = PermissionPrompt(
            requestId = msg.requestId,
            toolCallId = msg.toolCallId,
            toolName = msg.toolName,
            args = msg.args.mapValues { (_, v) -> if (v is JsonPrimitive) v.content else v.toString() },
            description = msg.description,
            expiresAtMs = msg.expiresAtMs,
        )
        // argKeys COUNT only — argument values + the rendered description are user content.
        log.info(
            "request",
            mapOf(
                "requestId" to prompt.requestId,
                "toolCallId" to prompt.toolCallId,
                "toolName" to prompt.toolName,
                "argKeys" to prompt.args.size,
                "expiresAtMs" to prompt.expiresAtMs,
                "open" to open.size + 1,
            ),
        )
        open[prompt.requestId] = prompt
        onPending?.invoke(pending())
        onEvent?.invoke(SdkEvent.PermissionRequested(prompt))
    }

    private fun onResolved(requestId: String, outcome: String) {
        val known = open.remove(requestId) != null
        log.info(
            "resolved",
            mapOf("requestId" to requestId, "outcome" to outcome, "known" to known, "open" to open.size),
        )
        onPending?.invoke(pending())
        onEvent?.invoke(SdkEvent.PermissionResolved(requestId = requestId, outcome = outcome))
    }

    companion object {
        const val CAPABILITY: String = "permission.prompt"
    }
}
