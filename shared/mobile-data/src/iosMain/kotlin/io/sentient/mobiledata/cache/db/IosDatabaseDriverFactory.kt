// ---------------------------------------------------------------------------
// IosDatabaseDriverFactory — iOS concrete behind DatabaseDriverFactory.
//
// NativeSqliteDriver takes ChatDatabase.Schema + a db file name and
// creates/migrates the schema automatically on first open, so no explicit
// Schema.create() is needed here. No Context on iOS — the factory is no-arg and is
// constructed directly by the platform DI (IosUserSession / createUserSession).
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.cache.db

import app.cash.sqldelight.db.SqlDriver
import app.cash.sqldelight.driver.native.NativeSqliteDriver

class IosDatabaseDriverFactory : DatabaseDriverFactory {
    override fun create(): SqlDriver =
        NativeSqliteDriver(ChatDatabase.Schema, CHAT_DB_FILE_NAME)
}
