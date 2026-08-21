package io.sentient.mobiledata.cache.db

import app.cash.sqldelight.db.SqlDriver

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
    /** The generated typed database bound to [driver]. */
    val database: CalendarDatabase = CalendarDatabase(driver),
) {
    private var isClosed: Boolean = false

    /** The generated schema version used by this database build. */
    val schemaVersion: Long
        get() = CalendarDatabase.Schema.version

    /** Close the connection once; repeated disposal is harmless. */
    fun close() {
        if (!isClosed) {
            isClosed = true
            driver.close()
        }
    }
}

/**
 * Open a ready-to-use [CalendarDatabase] from a platform-owned driver factory.
 *
 * If generated database binding fails, the newly-created driver is closed before
 * the exception is rethrown so failed opens do not leak a protected connection.
 */
fun openCalendarDatabase(factory: CalendarDatabaseDriverFactory): CalendarDatabaseHandle {
    val driver = factory.create()
    return try {
        CalendarDatabaseHandle(driver)
    } catch (failure: Throwable) {
        driver.close()
        throw failure
    }
}

/** Fluent form for platform session wiring without exposing platform path types. */
fun CalendarDatabaseDriverFactory.open(): CalendarDatabaseHandle = openCalendarDatabase(this)

/** The current generated schema version, kept as a stable common contract. */
const val CALENDAR_DATABASE_SCHEMA_VERSION: Long = 2L
