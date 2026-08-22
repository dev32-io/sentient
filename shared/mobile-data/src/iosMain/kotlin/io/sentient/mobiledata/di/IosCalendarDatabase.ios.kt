// ---------------------------------------------------------------------------
// iOS calendar persistence.
//
// This is the only platform-owned part of the calendar database. Shared
// mobile-data owns the schema, migrations, cache rows, namespace checks, and
// observation policy; iOS owns the protected app-private location and driver.
// ---------------------------------------------------------------------------
@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package io.sentient.mobiledata.di

import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.db.SqlDriver
import app.cash.sqldelight.driver.native.NativeSqliteDriver
import io.sentient.mobiledata.cache.CalendarCacheNamespace
import io.sentient.mobiledata.cache.db.CalendarDatabase
import io.sentient.mobiledata.cache.db.CalendarDatabaseDriverFactory
import platform.Foundation.NSApplicationSupportDirectory
import platform.Foundation.NSFileManager
import platform.Foundation.NSFileProtectionCompleteUntilFirstUserAuthentication
import platform.Foundation.NSFileProtectionKey
import platform.Foundation.NSProcessInfo
import platform.Foundation.NSURL
import platform.Foundation.NSURLIsExcludedFromBackupKey
import platform.Foundation.NSUserDomainMask

/** The protection class used for the authenticated calendar cache. */
val IOS_CALENDAR_FILE_PROTECTION: String =
    NSFileProtectionCompleteUntilFirstUserAuthentication
        ?: "NSFileProtectionCompleteUntilFirstUserAuthentication"

private val IOS_CALENDAR_BACKUP_KEY: String =
    NSURLIsExcludedFromBackupKey ?: "NSURLIsExcludedFromBackupKey"

/** A structural, typed reason for an unavailable iOS calendar boundary. */
enum class IosCalendarUnavailableReason {
    INITIALIZING,
    CLOSED,
    MISSING_AUTHENTICATED_USER_ID,
    INVALID_BACKEND_IDENTITY,
    APPLICATION_SUPPORT_UNAVAILABLE,
    PROTECTION_UNAVAILABLE,
    MIGRATION_FAILED,
    DRIVER_OPEN_FAILED,
    STORE_OPEN_FAILED,
}

/**
 * State exposed by [IosUserSession].  An unavailable calendar never exposes a
 * partially-open store or a remote fallback through the session's calendar
 * boundary.
 */
data class IosCalendarAvailability(
    val isAvailable: Boolean,
    val unavailableReason: IosCalendarUnavailableReason? = null,
) {
    init {
        require(isAvailable == (unavailableReason == null))
    }

    companion object {
        fun available(): IosCalendarAvailability = IosCalendarAvailability(true)

        fun unavailable(reason: IosCalendarUnavailableReason): IosCalendarAvailability =
            IosCalendarAvailability(false, reason)
    }
}

/** Structural storage facts used by platform tests and diagnostics. */
data class IosCalendarStorageStatus(
    val inApplicationSupport: Boolean,
    val protectionClass: String?,
    val excludedFromBackup: Boolean,
)

internal class IosCalendarDatabaseFailure(
    val reason: IosCalendarUnavailableReason,
) : IllegalStateException()

/**
 * Normalizes only the non-secret backend identity. Credentials, query strings,
 * fragments, and the WebSocket route are rejected rather than copied into a
 * namespace or a filesystem path.
 */
fun normalizeIosBackendIdentity(gatewayWsUrl: String): String {
    val url = NSURL(string = gatewayWsUrl)
    val scheme = url.scheme?.lowercase()
    val host = url.host?.lowercase()
    if (scheme !in setOf("ws", "wss") || host.isNullOrBlank()) {
        throw IosCalendarDatabaseFailure(IosCalendarUnavailableReason.INVALID_BACKEND_IDENTITY)
    }
    if (url.user != null || url.password != null || url.query != null || url.fragment != null) {
        throw IosCalendarDatabaseFailure(IosCalendarUnavailableReason.INVALID_BACKEND_IDENTITY)
    }

    val port = url.port?.intValue ?: if (scheme == "wss") 443 else 80
    val path = url.path.orEmpty()
        .removeSuffix("/ws")
        .trim('/')
        .split('/')
        .filter(String::isNotBlank)
        .joinToString("/")
    // Deliberately not URL-shaped: this value is a database namespace, never a
    // credential-bearing URL and never a filename.
    return listOf(scheme, host, port.toString(), path).joinToString("|")
}

/**
 * App-private Application Support storage for the one calendar database.
 * Application Support is created before the SQLDelight driver is opened; a
 * missing or non-directory location fails closed.
 */
class IosCalendarDatabaseDriverFactory : CalendarDatabaseDriverFactory {
    override fun create(): SqlDriver {
        val fileManager = NSFileManager.defaultManager
        val directory = applicationSupportDirectory(fileManager)
            ?: throw IosCalendarDatabaseFailure(IosCalendarUnavailableReason.APPLICATION_SUPPORT_UNAVAILABLE)
        val calendarDirectory = "$directory/SentientCalendar"
        if (!fileManager.createDirectoryAtPath(
                path = calendarDirectory,
                withIntermediateDirectories = true,
                attributes = null,
                error = null,
            ) || !fileManager.fileExistsAtPath(calendarDirectory, isDirectory = null)
        ) {
            throw IosCalendarDatabaseFailure(IosCalendarUnavailableReason.APPLICATION_SUPPORT_UNAVAILABLE)
        }

        val path = "$calendarDirectory/calendar.sqlite"
        val existed = fileManager.fileExistsAtPath(path)
        val driver = try {
            // NativeSqliteDriver applies Schema.create/migrate using the
            // generated schema version. No SQLCipher or application key is
            // introduced; the OS file-protection boundary is authoritative.
            NativeSqliteDriver(
                schema = CalendarDatabase.Schema,
                // SQLiter accepts a filename in `name`; the protected
                // Application Support directory is supplied through basePath.
                name = "calendar.sqlite",
                onConfiguration = { configuration ->
                    configuration.copy(
                        extendedConfig = configuration.extendedConfig.copy(
                            basePath = calendarDirectory,
                            foreignKeyConstraints = true,
                        ),
                    )
                },
            )
        } catch (_: Throwable) {
            throw IosCalendarDatabaseFailure(
                if (existed) IosCalendarUnavailableReason.MIGRATION_FAILED
                else IosCalendarUnavailableReason.DRIVER_OPEN_FAILED,
            )
        }

        try {
            // NativeSqliteDriver opens lazily. Touch the connection so schema
            // creation/migration and the database file exist before applying
            // and verifying file protection attributes.
            driver.executeQuery(
                identifier = null,
                sql = "SELECT 1",
                mapper = { QueryResult.Value(Unit) },
                parameters = 0,
            )
            applyProtection(fileManager, path)
            verifyProtection(fileManager, path)
        } catch (_: Throwable) {
            driver.close()
            throw IosCalendarDatabaseFailure(IosCalendarUnavailableReason.PROTECTION_UNAVAILABLE)
        }
        return driver
    }

    /** The stable app-private database location, without any auth material. */
    fun databasePath(): String = applicationSupportDirectory(NSFileManager.defaultManager)
        ?.let { "$it/SentientCalendar/calendar.sqlite" }
        ?: throw IosCalendarDatabaseFailure(IosCalendarUnavailableReason.APPLICATION_SUPPORT_UNAVAILABLE)

    /** Structural protection check; no database content is read. */
    fun storageStatus(): IosCalendarStorageStatus {
        val manager = NSFileManager.defaultManager
        val path = databasePath()
        val attributes = manager.attributesOfItemAtPath(path, error = null)
        val protection = attributes?.get(NSFileProtectionKey) as? String
        val excluded = NSURL(fileURLWithPath = path)
            .resourceValuesForKeys(listOf(IOS_CALENDAR_BACKUP_KEY), error = null)
            ?.get(IOS_CALENDAR_BACKUP_KEY) as? Boolean ?: false
        return IosCalendarStorageStatus(
            inApplicationSupport = path.contains("/Library/Application Support/"),
            protectionClass = protection,
            excludedFromBackup = excluded,
        )
    }

    private fun applicationSupportDirectory(fileManager: NSFileManager): String? {
        val paths = fileManager
            .URLsForDirectory(NSApplicationSupportDirectory, NSUserDomainMask)
            .mapNotNull { (it as? NSURL)?.path }
        val directory = paths.firstOrNull()?.takeIf(String::isNotBlank) ?: return null
        if (!fileManager.createDirectoryAtPath(
                path = directory,
                withIntermediateDirectories = true,
                attributes = null,
                error = null,
            )
        ) {
            return null
        }
        return directory
    }

    private fun applyProtection(fileManager: NSFileManager, path: String) {
        listOf(path, "$path-wal", "$path-shm").forEach { candidate ->
            if (!fileManager.fileExistsAtPath(candidate)) return@forEach
            check(
                fileManager.setAttributes(
                    attributes = mapOf(NSFileProtectionKey to IOS_CALENDAR_FILE_PROTECTION),
                    ofItemAtPath = candidate,
                    error = null,
                ),
            )
            // This cache is disposable, so exclude it from backup when the
            // OS accepts the resource value. Backup metadata is policy
            // hygiene, not a reason to hide an otherwise protected database
            // when a simulator/OS version declines the optional attribute.
            NSURL(fileURLWithPath = candidate).setResourceValue(
                value = true,
                forKey = IOS_CALENDAR_BACKUP_KEY,
                error = null,
            )
        }
    }

    private fun verifyProtection(fileManager: NSFileManager, path: String) {
        check(fileManager.fileExistsAtPath(path))
        val attributes = fileManager.attributesOfItemAtPath(path, error = null)
        val protection = attributes?.get(NSFileProtectionKey)
        if (protection == IOS_CALENDAR_FILE_PROTECTION) return
        // iOS Simulator stores the file on the host filesystem and does not
        // expose NSFileProtectionKey even when setAttributes succeeds. Keep
        // simulator XCFramework tests usable while retaining fail-closed
        // verification on real iOS devices.
        if (isIosSimulator()) return
        error("file protection attribute unavailable")
    }

    private fun isIosSimulator(): Boolean =
        NSProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"] != null ||
            NSProcessInfo.processInfo.environment["SIMULATOR_ROOT"] != null
}

fun createIosCalendarDatabaseDriverFactory(): CalendarDatabaseDriverFactory =
    IosCalendarDatabaseDriverFactory()

fun iosCalendarNamespace(
    authenticatedUserId: String,
    gatewayWsUrl: String,
): CalendarCacheNamespace {
    val userId = authenticatedUserId.trim()
    if (userId.isBlank()) {
        throw IosCalendarDatabaseFailure(IosCalendarUnavailableReason.MISSING_AUTHENTICATED_USER_ID)
    }
    return CalendarCacheNamespace(
        accountId = userId,
        backendId = normalizeIosBackendIdentity(gatewayWsUrl),
    )
}
