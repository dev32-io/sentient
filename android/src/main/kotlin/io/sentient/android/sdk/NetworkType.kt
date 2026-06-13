// ---------------------------------------------------------------------------
// NetworkType — derive the active transport label for the vitals session header.
//
// Returns one of "wifi" | "cellular" | "none" (matching SessionMeta.network's
// documented vocabulary), or "unknown" if ConnectivityManager is unavailable.
// Requires the ACCESS_NETWORK_STATE permission (declared in the manifest; a normal
// permission, no runtime prompt).
// ---------------------------------------------------------------------------
package io.sentient.android.sdk

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities

private const val NET_WIFI = "wifi"
private const val NET_CELLULAR = "cellular"
private const val NET_NONE = "none"
private const val NET_UNKNOWN = "unknown"

/** The active transport at the moment of capture. Best-effort; never throws. */
internal fun currentNetwork(context: Context): String {
    val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        ?: return NET_UNKNOWN
    val active = cm.activeNetwork ?: return NET_NONE
    val caps = cm.getNetworkCapabilities(active) ?: return NET_NONE
    return when {
        caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> NET_WIFI
        caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> NET_CELLULAR
        else -> NET_UNKNOWN
    }
}
