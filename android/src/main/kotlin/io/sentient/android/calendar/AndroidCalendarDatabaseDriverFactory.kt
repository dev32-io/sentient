// ---------------------------------------------------------------------------
// Android calendar database driver.
//
// The shared layer owns the schema, migrations, cache policy, and query flows.
// This file is the only Android-owned part of that seam: SQLDelight receives the
// application Context and a fixed, sanitized database name, so SQLite remains in
// the app-private database directory. No identity, token, URL, or calendar data
// is used in the path.
// ---------------------------------------------------------------------------
package io.sentient.android.calendar

import android.content.Context
import app.cash.sqldelight.driver.android.AndroidSqliteDriver
import app.cash.sqldelight.db.SqlDriver
import io.sentient.mobiledata.cache.db.CalendarDatabase
import io.sentient.mobiledata.cache.db.CalendarDatabaseDriverFactory
import kotlinx.coroutines.CancellationException

/** Stable app-private filename; namespace isolation lives in the shared schema. */
const val CALENDAR_DATABASE_NAME: String = "calendar-cache.db"

/** Content-free driver failure; the original platform exception is intentionally not retained. */
class AndroidCalendarDatabaseException : IllegalStateException()

/**
 * Context-backed SQLDelight driver factory for the authenticated calendar store.
 * AndroidSqliteDriver creates or migrates [CalendarDatabase.Schema] in the
 * Context-owned database directory; it never falls back to external storage.
 */
class AndroidCalendarDatabaseDriverFactory(
    context: Context,
    private val databaseName: String = CALENDAR_DATABASE_NAME,
) : CalendarDatabaseDriverFactory {
    private val appContext = context.applicationContext

    init {
        require(databaseName.matches(Regex("[A-Za-z0-9._-]+"))) {
            "calendar database name must be a simple app-private filename"
        }
    }

    override fun create(): SqlDriver = try {
        AndroidSqliteDriver(
            schema = CalendarDatabase.Schema,
            context = appContext,
            name = databaseName,
        )
    } catch (failure: Throwable) {
        if (failure is CancellationException) throw failure
        throw AndroidCalendarDatabaseException()
    }
}
