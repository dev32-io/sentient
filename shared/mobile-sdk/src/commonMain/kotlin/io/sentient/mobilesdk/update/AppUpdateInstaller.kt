package io.sentient.mobilesdk.update

sealed interface InstallResult {
    data object Launched : InstallResult
    data object NeedsInstallPermission : InstallResult
    data class Failed(val reason: String) : InstallResult
}

/** Hands an update [UpdateTarget] to the platform installer. Android downloads
 *  the apk + opens the system PackageInstaller; the system shows its own
 *  confirm UI (one-tap ceiling). iOS opens the itms-services URL in the UI layer. */
interface AppUpdateInstaller {
    suspend fun start(target: UpdateTarget): InstallResult
}
