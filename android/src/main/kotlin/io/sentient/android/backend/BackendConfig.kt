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
