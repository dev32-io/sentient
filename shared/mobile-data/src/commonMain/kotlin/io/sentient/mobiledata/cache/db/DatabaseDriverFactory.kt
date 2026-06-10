// ---------------------------------------------------------------------------
// DatabaseDriverFactory — the boundary interface for opening the ChatDatabase
// SQLDelight driver.
//
// commonMain owns ONLY this interface (no platform DB types leak in). Each
// target supplies the concrete driver behind it: AndroidSqliteDriver
// (androidMain, needs a Context), NativeSqliteDriver (iosMain, no-arg), and a
// JdbcSqliteDriver(IN_MEMORY) test factory on the JVM host (androidUnitTest).
//
// Platform DI (UserSessionManager on Android, IosUserSession on iOS) constructs
// the platform factory and threads it into ChatComponent — mirroring how the SDK
// platform deps reach commonMain via createPlatformBundle(). The repository layer
// (Slice 4.5/4.6) calls create() once per connection scope and wraps the result
// in ChatDatabase(driver).
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.cache.db

import app.cash.sqldelight.db.SqlDriver

/**
 * Opens the platform SQLDelight [SqlDriver] for the ChatDatabase.
 *
 * Implementations create the on-disk (Android/iOS) or in-memory (test) driver and
 * are responsible for ensuring the schema exists. The native/Android drivers
 * create/migrate the schema automatically on first open; the JVM in-memory test
 * factory must call `ChatDatabase.Schema.create(driver)` explicitly.
 */
interface DatabaseDriverFactory {
    /** Open a ready-to-use [SqlDriver] with the ChatDatabase schema applied. */
    fun create(): SqlDriver
}
