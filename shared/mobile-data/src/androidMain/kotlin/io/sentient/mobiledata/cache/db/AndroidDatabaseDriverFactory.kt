// ---------------------------------------------------------------------------
// AndroidDatabaseDriverFactory — Android concrete behind DatabaseDriverFactory.
//
// AndroidSqliteDriver takes ChatDatabase.Schema + a Context + a db file name and
// creates/migrates the schema automatically on first open, so no explicit
// Schema.create() is needed here. The Context is the application Context, supplied
// by the platform DI (UserSessionManager).
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.cache.db

import android.content.Context
import app.cash.sqldelight.db.SqlDriver
import app.cash.sqldelight.driver.android.AndroidSqliteDriver

class AndroidDatabaseDriverFactory(
    private val context: Context,
) : DatabaseDriverFactory {
    override fun create(): SqlDriver =
        AndroidSqliteDriver(ChatDatabase.Schema, context, CHAT_DB_FILE_NAME)
}
