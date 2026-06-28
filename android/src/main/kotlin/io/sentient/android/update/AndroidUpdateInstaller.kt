package io.sentient.android.update

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.update.AppUpdateInstaller
import io.sentient.mobilesdk.update.InstallResult
import io.sentient.mobilesdk.update.UpdateTarget
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private val log = createLogger("android", "update-installer")
private const val SESSION_NAME = "sentient-update"

/** Downloads an APK via [httpClient] and hands it to the system [PackageInstaller].
 *  The system shows a one-tap confirm UI; no launcher activity is needed.
 *  DI wiring (Context + HttpClient injection) is B5's responsibility. */
class AndroidUpdateInstaller(
    private val context: Context,
    private val httpClient: HttpClient,
) : AppUpdateInstaller {

    override suspend fun start(target: UpdateTarget): InstallResult {
        if (target !is UpdateTarget.AndroidApk) return InstallResult.Failed("wrong-target")
        if (!context.packageManager.canRequestPackageInstalls()) {
            routeToUnknownSources()
            log.info("install.needs-permission")
            return InstallResult.NeedsInstallPermission
        }
        return try {
            val bytes = download(target.apkUrl)
            commitSession(bytes)
            log.info("install.launched", mapOf("bytes" to bytes.size))
            InstallResult.Launched
        } catch (e: Exception) {
            log.warn("install.failed", mapOf("type" to (e::class.simpleName ?: "Exception")))
            InstallResult.Failed(e::class.simpleName ?: "error")
        }
    }

    private suspend fun download(url: String): ByteArray = withContext(Dispatchers.IO) {
        val t0 = System.currentTimeMillis()
        val bytes: ByteArray = httpClient.get(url).body()
        log.debug("download.done", mapOf("bytes" to bytes.size, "elapsedMs" to (System.currentTimeMillis() - t0)))
        bytes
    }

    private fun commitSession(apk: ByteArray) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(context.packageName)
        val sessionId = installer.createSession(params)
        val session = installer.openSession(sessionId)
        try {
            session.openWrite(SESSION_NAME, 0, apk.size.toLong()).use { out ->
                out.write(apk)
                session.fsync(out)
            }
            log.debug("session.commit", mapOf("sessionId" to sessionId, "bytes" to apk.size))
            session.commit(buildStatusPendingIntent(sessionId).intentSender)
            session.close()
        } catch (e: Exception) {
            session.abandon()
            throw e
        }
    }

    // FLAG_MUTABLE is required on API 31+ for system-filled PendingIntents (PackageInstaller
    // writes EXTRA_STATUS back into the intent). On API < 31 the flag is not defined — use 0.
    private fun buildStatusPendingIntent(sessionId: Int): PendingIntent {
        val intent = Intent(context, UpdateInstallReceiver::class.java)
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        return PendingIntent.getBroadcast(context, sessionId, intent, flags)
    }

    private fun routeToUnknownSources() {
        // ACTION_MANAGE_UNKNOWN_APP_SOURCES + package URI opens the per-app toggle (API 26+).
        val intent = Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${context.packageName}"),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        log.info("install.route-to-unknown-sources", mapOf("pkg" to context.packageName))
        context.startActivity(intent)
    }
}
