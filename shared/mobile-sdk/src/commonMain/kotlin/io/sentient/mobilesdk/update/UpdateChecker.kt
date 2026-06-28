package io.sentient.mobilesdk.update

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.statement.HttpResponse
import io.ktor.http.isSuccess
import io.sentient.mobilesdk.auth.deriveBaseUrl
import io.sentient.mobilesdk.log.Log
import io.sentient.mobilesdk.log.createLogger

private const val MANIFEST_PATH = "/download/manifest.json"
private const val ITMS_PREFIX = "itms-services://?action=download-manifest&url="

/** wss://host/api/v1/ws → https://host (strips /ws and /api/v1). */
fun deriveHostRoot(gatewayWsUrl: String): String =
    deriveBaseUrl(gatewayWsUrl).removeSuffix("/api/v1")

/**
 * Fetches `/download/manifest.json` UNAUTHENTICATED and compares the installed
 * build number against the manifest to determine update status.
 *
 * [hostRootUrl] is the gateway root without path (e.g. `https://host:3000`).
 * [httpClient] is injected — caller owns lifecycle; must have ContentNegotiation(Json).
 * All operations return a typed [UpdateStatus]; never throws to caller.
 */
class UpdateChecker(
    private val hostRootUrl: String,
    private val httpClient: HttpClient,
    private val platform: UpdatePlatform,
    private val installed: InstalledVersion,
    private val log: Log = createLogger("update", "checker"),
) {
    suspend fun check(): UpdateStatus {
        val release = fetchRelease() ?: return UpdateStatus.CheckFailed("fetch-failed")
        val mandatory = installed.build < release.minSupportedBuild
        val available = release.build > installed.build
        log.info(
            "check.result",
            mapOf("installed" to installed.build, "latest" to release.build, "mandatory" to mandatory),
        )
        if (!available) return UpdateStatus.UpToDate
        return UpdateStatus.Available(
            latestBuild = release.build,
            versionName = release.versionName,
            notes = "",
            mandatory = mandatory,
            target = targetFor(release),
        )
    }

    private suspend fun fetchRelease(): ReleaseInfo? = try {
        val resp: HttpResponse = httpClient.get("$hostRootUrl$MANIFEST_PATH")
        if (!resp.status.isSuccess()) {
            log.warn("check.http", mapOf("status" to resp.status.value))
            null
        } else {
            resp.body<UpdateManifest>().forPlatform(platform)
        }
    } catch (e: Exception) {
        log.warn("check.error", mapOf("type" to (e::class.simpleName ?: "Exception")))
        null
    }

    private fun targetFor(release: ReleaseInfo): UpdateTarget = when (platform) {
        UpdatePlatform.ANDROID ->
            UpdateTarget.AndroidApk("$hostRootUrl${release.downloadPath}")
        UpdatePlatform.IOS ->
            UpdateTarget.IosItms("$ITMS_PREFIX$hostRootUrl${release.itmsPath.orEmpty()}")
    }
}
