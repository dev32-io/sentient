// ---------------------------------------------------------------------------
// Calendar namespace derivation.
//
// Namespace identity is deliberately derived from the server-authenticated user
// id and a canonical backend endpoint. URL user-info, query, and fragment data
// are discarded before the endpoint is used as a cache key. The canonical value
// is stored only as an app-private SQL namespace; it is never used as a filename
// or emitted in diagnostics.
// ---------------------------------------------------------------------------
package io.sentient.android.calendar

import io.sentient.mobiledata.cache.CalendarCacheNamespace
import java.net.URI
import java.util.Locale

/**
 * Returns the stable, credential-free identity of a configured gateway endpoint.
 *
 * Scheme and effective port remain part of the identity because changing TLS
 * posture or routing to another port may select a different backend. Credentials,
 * query parameters, and fragments are never part of the result.
 */
fun normalizedCalendarBackendIdentity(gatewayWsUrl: String): String {
    val uri = URI(gatewayWsUrl)
    val scheme = uri.scheme?.lowercase(Locale.ROOT)?.takeIf { it == "ws" || it == "wss" }
        ?: throw IllegalArgumentException("calendar backend scheme is invalid")
    val host = uri.host?.lowercase(Locale.ROOT)?.takeIf { it.isNotBlank() }
        ?: throw IllegalArgumentException("calendar backend host is invalid")
    val port = when {
        uri.port == -1 -> ""
        uri.port == defaultPort(scheme) -> ""
        uri.port in 1..65535 -> ":${uri.port}"
        else -> throw IllegalArgumentException("calendar backend port is invalid")
    }
    val path = uri.rawPath.orEmpty().trim().trimEnd('/').ifEmpty { "/" }
    return "$scheme://$host$port$path"
}

/** Build the SQL namespace from the explicit server identity, never a display name or token. */
fun calendarCacheNamespace(
    authenticatedUserId: String,
    gatewayWsUrl: String,
): CalendarCacheNamespace {
    val accountId = authenticatedUserId.trim()
    require(accountId.isNotEmpty()) { "authenticated calendar user id is missing" }
    return CalendarCacheNamespace(
        accountId = accountId,
        backendId = normalizedCalendarBackendIdentity(gatewayWsUrl),
    )
}

private fun defaultPort(scheme: String): Int = if (scheme == "wss") 443 else 80
