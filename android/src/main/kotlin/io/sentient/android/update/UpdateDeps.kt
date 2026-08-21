// ---------------------------------------------------------------------------
// UpdateDeps — the connection-scoped OTA dependency pair + its factory.
//
// Co-locates update construction with the update package; UserSessionManager
// orchestrates the call (supplying the resolved gateway host + http client),
// analogous to how it calls buildAuthHttpClient from the sdk package. Keeps the
// session manager focused on session lifecycle.
// ---------------------------------------------------------------------------
package io.sentient.android.update

import android.content.Context
import io.ktor.client.HttpClient
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.update.AppUpdateInstaller
import io.sentient.mobilesdk.update.InstalledVersion
import io.sentient.mobilesdk.update.UpdateChecker
import io.sentient.mobilesdk.update.UpdatePlatform
import io.sentient.mobilesdk.update.deriveHostRoot

private val log = createLogger("android", "update-deps")

/** The OTA pair: the manifest [checker] (B2) + the platform apk [installer] (B4). */
data class UpdateDeps(val checker: UpdateChecker, val installer: AppUpdateInstaller)

/**
 * Build the OTA deps from a resolved gateway host. [httpClient] is reused for BOTH
 * the manifest fetch (needs JSON ContentNegotiation) and the apk download — same
 * engine/TLS policy. Installed build/name are passed in to keep this module
 * BuildConfig-free (the caller owns BuildConfig).
 */
fun buildUpdateDeps(
    appContext: Context,
    gatewayWsUrl: String,
    httpClient: HttpClient,
    installedBuild: Int,
    installedVersionName: String,
): UpdateDeps {
    val hostRoot = deriveHostRoot(gatewayWsUrl)
    // The configured URL may contain sensitive user-info; do not echo the host
    // root into durable diagnostics.
    log.info("build", mapOf("configured" to true))
    return UpdateDeps(
        checker = UpdateChecker(
            hostRootUrl = hostRoot,
            httpClient = httpClient,
            platform = UpdatePlatform.ANDROID,
            installed = InstalledVersion(installedBuild, installedVersionName),
        ),
        installer = AndroidUpdateInstaller(appContext, httpClient),
    )
}
