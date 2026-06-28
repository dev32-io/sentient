package io.sentient.mobilesdk.update

import kotlinx.serialization.Serializable

@Serializable
data class AndroidRelease(
    val versionCode: Int,
    val versionName: String,
    val minSupportedBuild: Int = 0,
    val url: String,
    val notes: String = "",
)

@Serializable
data class IosRelease(
    val bundleVersion: Int,
    val shortVersion: String,
    val minSupportedBuild: Int = 0,
    val bundleId: String,
    val url: String,
    val manifestUrl: String,
    val notes: String = "",
)

@Serializable
data class UpdateManifest(
    val android: AndroidRelease? = null,
    val ios: IosRelease? = null,
)

enum class UpdatePlatform { ANDROID, IOS }

data class InstalledVersion(val build: Int, val versionName: String)

sealed interface UpdateTarget {
    data class AndroidApk(val apkUrl: String) : UpdateTarget
    data class IosItms(val itmsUrl: String) : UpdateTarget
}

sealed interface UpdateStatus {
    data object UpToDate : UpdateStatus
    data class Available(
        val latestBuild: Int,
        val versionName: String,
        val notes: String,
        val mandatory: Boolean,
        val target: UpdateTarget,
    ) : UpdateStatus
    data class CheckFailed(val reason: String) : UpdateStatus
}

data class ReleaseInfo(
    val build: Int,
    val versionName: String,
    val minSupportedBuild: Int,
    val downloadPath: String,
    val itmsPath: String?,
)

fun UpdateManifest.forPlatform(p: UpdatePlatform): ReleaseInfo? = when (p) {
    UpdatePlatform.ANDROID -> android?.let {
        ReleaseInfo(
            build = it.versionCode,
            versionName = it.versionName,
            minSupportedBuild = it.minSupportedBuild,
            downloadPath = it.url,
            itmsPath = null,
        )
    }
    UpdatePlatform.IOS -> ios?.let {
        ReleaseInfo(
            build = it.bundleVersion,
            versionName = it.shortVersion,
            minSupportedBuild = it.minSupportedBuild,
            downloadPath = it.url,
            itmsPath = it.manifestUrl,
        )
    }
}
