// ---------------------------------------------------------------------------
// InMemoryDatabaseDriverFactory — JVM-host test factory behind DatabaseDriverFactory.
//
// Spins a real SQLite database in memory via JdbcSqliteDriver so the Slice 4
// repository tests (4.5/4.6) exercise the actual driver + schema + generated
// queries on the JVM host (androidUnitTest) — not a mock.
//
// Unlike AndroidSqliteDriver / NativeSqliteDriver (which create+migrate the schema
// on first open), the JDBC in-memory driver has NO schema-create callback, so we
// MUST call ChatDatabase.Schema.create(driver) explicitly before returning it.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.cache.db

import app.cash.sqldelight.db.SqlDriver
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver

class InMemoryDatabaseDriverFactory : DatabaseDriverFactory {
    override fun create(): SqlDriver {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        ChatDatabase.Schema.create(driver)
        return driver
    }
}
