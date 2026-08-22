package io.sentient.mobiledata.cache.db

import app.cash.sqldelight.db.SqlDriver
import kotlin.coroutines.cancellation.CancellationException

/**
 * Platform-neutral seam for the calendar database driver.
 *
 * Implementations own platform path protection and driver construction. They must
 * return a driver that has [CalendarDatabase.Schema] applied (including any
 * required migration). No platform path or lifecycle type crosses commonMain.
 */
fun interface CalendarDatabaseDriverFactory {
    fun create(): SqlDriver
}

/** Content-free failure from a driver open/migration; the platform cause is not retained. */
class CalendarDatabaseOpenException : IllegalStateException()

/** Content-free failure from a driver close; the platform cause is not retained. */
class CalendarDatabaseCloseException : IllegalStateException()

/**
 * A connection-scoped generated database and its driver.
 *
 * The handle deliberately owns both objects so authenticated session disposal can
 * stop users of the generated queries before closing the underlying connection.
 * [close] is idempotent, which makes error cleanup safe at lifecycle boundaries.
 */
class CalendarDatabaseHandle internal constructor(
    /** The injected platform driver, exposed for transaction and listener seams. */
    val driver: SqlDriver,
    /** The generated typed database bound to [driver]. Kept internal behind the cache store. */
    internal val database: CalendarDatabase = CalendarDatabase(driver),
) {
    private var isClosed: Boolean = false

    /** The generated schema version used by this database build. */
    val schemaVersion: Long
        get() = CalendarDatabase.Schema.version

    /** Close the connection once; repeated disposal is harmless. */
    fun close() {
        if (!isClosed) {
            isClosed = true
            try {
                driver.close()
            } catch (failure: Throwable) {
                if (failure is CancellationException) throw failure
                throw CalendarDatabaseCloseException()
            }
        }
    }
}

/**
 * Open a ready-to-use [CalendarDatabase] from a platform-owned driver factory.
 *
 * If generated database binding fails, the newly-created driver is closed before
 * a content-free typed open failure is returned so failed opens do not leak a
 * protected connection.
 */
fun openCalendarDatabase(factory: CalendarDatabaseDriverFactory): CalendarDatabaseHandle {
    val driver = try {
        factory.create()
    } catch (failure: Throwable) {
        if (failure is CancellationException) throw failure
        throw CalendarDatabaseOpenException()
    }
    return try {
        CalendarDatabaseHandle(driver)
    } catch (failure: Throwable) {
        if (failure is CancellationException) throw failure
        try {
            driver.close()
        } catch (closeFailure: Throwable) {
            if (closeFailure is CancellationException) throw closeFailure
        }
        throw CalendarDatabaseOpenException()
    }
}

/** Fluent form for platform session wiring without exposing platform path types. */
fun CalendarDatabaseDriverFactory.open(): CalendarDatabaseHandle = openCalendarDatabase(this)

/** The current generated schema version, kept as a stable common contract. */
const val CALENDAR_DATABASE_SCHEMA_VERSION: Long = 2L
