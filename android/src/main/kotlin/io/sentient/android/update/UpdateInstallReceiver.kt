package io.sentient.android.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import io.sentient.mobilesdk.log.createLogger

private val log = createLogger("android", "update-install-receiver")

/**
 * Receives PackageInstaller status callbacks for OTA APK installations initiated by
 * [AndroidUpdateInstaller]. The PendingIntent passed to [PackageInstaller.Session.commit]
 * targets this receiver; the system fills in [PackageInstaller.EXTRA_STATUS].
 *
 * On STATUS_PENDING_USER_ACTION the receiver launches the system confirm activity so the
 * user sees the one-tap install dialog. All other paths are logged only (v1).
 */
class UpdateInstallReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "no-message"
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> launchConfirm(context, intent)
            PackageInstaller.STATUS_SUCCESS -> log.info("install.status.success")
            else -> log.warn("install.status.failed", mapOf("status" to status, "msg" to message))
        }
    }

    private fun launchConfirm(context: Context, intent: Intent) {
        val confirmIntent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(Intent.EXTRA_INTENT)
        }
        if (confirmIntent == null) {
            log.warn("install.status.pending-user-action.no-intent")
            return
        }
        log.info("install.status.pending-user-action")
        context.startActivity(confirmIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
