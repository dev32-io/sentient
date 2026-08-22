package io.sentient.mobiledata.calendar

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respondOk
import io.sentient.mobiledata.cache.CalendarCacheNamespace
import io.sentient.mobiledata.cache.CalendarCacheResult
import io.sentient.mobiledata.cache.CalendarCacheSnapshot
import io.sentient.mobiledata.cache.CalendarCacheWindow
import io.sentient.mobiledata.cache.SqlDelightCalendarCacheStore
import io.sentient.mobiledata.cache.db.CalendarDatabase
import io.sentient.mobiledata.data.calendar.SdkCalendarRepository
import io.sentient.mobilesdk.auth.AuthResult
import io.sentient.mobilesdk.calendar.CalendarEvent
import io.sentient.mobilesdk.calendar.CalendarEventPage
import io.sentient.mobilesdk.calendar.CalendarHttpClient
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.CalendarTime
import io.sentient.mobilesdk.calendar.Importance
import io.sentient.mobilesdk.calendar.Visibility
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * Uses the real SDK repository adapter and a real SQLDelight transaction with
 * the disposable fixture's exact scope/window/cursor semantics. The transport
 * client is deterministic so the stale registration can be held at the edge.
 */
class CalendarRecoveryIntegrationTest {
    @Test
    fun `deferred fixture occurrence survives paginated recovery and publishes from SQLDelight`() = runBlocking {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        CalendarDatabase.Schema.create(driver)
        val namespace = CalendarCacheNamespace("fixture-account", "fixture-backend")
        val store = SqlDelightCalendarCacheStore(CalendarDatabase(driver), namespace, Dispatchers.IO)
        val window = CalendarCacheWindow("2026-07-26", "2026-09-06", "America/Vancouver")
        val cached = event("event-cache", "occ-cache", "2026-08-22T07:00:00.000Z")
        val recovery = event("event-recovery", "occ-recovery", "2026-08-22T08:00:00.000Z")
        val client = FixtureCalendarClient(window, cached, recovery)
        val experienceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val experience = CalendarExperience(
            repository = SdkCalendarRepository(client),
            cacheStore = store,
            scope = experienceScope,
            initialWindow = window,
            initialAnchorDate = "2026-08-22",
            initialLocale = CalendarLocale(timeZoneId = window.timezoneInput),
            nowMillis = { 100L + client.activeWindowCalls },
            todayDate = { "2026-08-22" },
        )
        val visibleCounts = mutableListOf<Int>()
        val collector = launch { experience.state.collect { visibleCounts += it.authorizedOccurrences.size } }
        try {
            experience.observe(window)
            withTimeout(5_000) { experience.state.filter { it.freshness == CalendarFreshness.FRESH }.first() }
            // Fresh state can publish at the transaction boundary just before
            // the owning revalidation job returns. Join that exact owner so the
            // deliberately stale request below is a new registered attempt.
            withTimeout(5_000) { experience.refresh()?.join() }
            assertEquals(listOf(cached.occurrenceId), experience.state.value.authorizedOccurrences.map { it.occurrenceId })

            experience.onConnectivityUnavailable()
            client.mode = Mode.STALE
            experience.refresh()
            withTimeout(5_000) { client.staleEntered.await() }
            val callsBeforeRecovery = client.activeWindowCalls

            client.mode = Mode.RECOVERY
            val firstRecovery = experience.onConnectivityRecovered()
            val duplicateRecovery = experience.onConnectivityRecovered()
            assertTrue(firstRecovery === duplicateRecovery)
            try {
                withTimeout(5_000) { experience.state.filter { it.recoveryReady }.first() }
            } catch (failure: kotlinx.coroutines.TimeoutCancellationException) {
                error(
                    "recovery did not settle: phase=${experience.state.value.recovery.phase} " +
                        "freshness=${experience.state.value.freshness} calls=${client.activeWindowCalls} " +
                        "cursors=${client.requestedCursors}",
                )
            }

            val state = experience.state.value
            assertEquals(callsBeforeRecovery + 2, client.activeWindowCalls) // exactly two pages, one active revalidation
            assertEquals(listOf(null, "fixture-next"), client.requestedCursors.takeLast(2))
            assertTrue(client.scopes.all { it == CalendarScope.ALL })
            assertTrue(client.windows.all { it == window.windowStart to window.windowEnd })
            assertEquals(CalendarRecoveryPhase.UP_TO_DATE, state.recovery.phase)
            assertEquals(CalendarFreshness.FRESH, state.freshness)
            assertEquals(CalendarLoadingPhase.IDLE, state.loading.phase)
            assertTrue(state.authorizedOccurrences.any { it.occurrenceId == recovery.occurrenceId })
            assertTrue(state.projection?.visibleEvents.orEmpty().any { it.occurrenceId == recovery.occurrenceId })

            val persisted = assertIs<CalendarCacheResult.Success<CalendarCacheSnapshot?>>(store.readSnapshot(window)).value
            assertTrue(persisted?.occurrences.orEmpty().any { it.occurrenceId == recovery.occurrenceId })
            val firstContent = visibleCounts.indexOfFirst { it > 0 }
            assertTrue(firstContent >= 0 && visibleCounts.drop(firstContent).all { it > 0 })
        } finally {
            collector.cancel()
            experience.close()
            experienceScope.cancel()
            client.dispose()
            store.close()
            driver.close()
        }
    }

    private enum class Mode { PRIME, STALE, RECOVERY }

    private class FixtureCalendarClient private constructor(
        private val http: HttpClient,
        private val activeWindow: CalendarCacheWindow,
        private val cached: CalendarEvent,
        private val recovery: CalendarEvent,
    ) : CalendarHttpClient(http, "wss://fixture.test/api/v1/ws", { "fixture-token" }) {
        constructor(
            activeWindow: CalendarCacheWindow,
            cached: CalendarEvent,
            recovery: CalendarEvent,
        ) : this(HttpClient(MockEngine { respondOk() }), activeWindow, cached, recovery)

        fun dispose() = http.close()
        var mode = Mode.PRIME
        var activeWindowCalls = 0
        val staleEntered = CompletableDeferred<Unit>()
        val requestedCursors = mutableListOf<String?>()
        val scopes = mutableListOf<CalendarScope?>()
        val windows = mutableListOf<Pair<String, String>>()

        override suspend fun list(
            from: String,
            to: String,
            scope: CalendarScope?,
            group: String?,
            tags: List<String>?,
            importance: Importance?,
            cursor: String?,
            query: String?,
            limit: Int?,
        ): AuthResult<CalendarEventPage> {
            if (from != activeWindow.windowStart || to != activeWindow.windowEnd) {
                return AuthResult.Success(CalendarEventPage(emptyList()))
            }
            activeWindowCalls += 1
            requestedCursors += cursor
            scopes += scope
            windows += from to to
            if (mode == Mode.STALE) {
                staleEntered.complete(Unit)
                try {
                    CompletableDeferred<Unit>().await()
                } catch (cancelled: CancellationException) {
                    throw cancelled
                }
            }
            return if (cursor == null) {
                AuthResult.Success(CalendarEventPage(listOf(cached), nextCursor = "fixture-next"))
            } else {
                AuthResult.Success(CalendarEventPage(if (mode == Mode.RECOVERY) listOf(recovery) else emptyList()))
            }
        }
    }

    private fun event(eventId: String, occurrenceId: String, originalStart: String) = CalendarEvent(
        id = eventId,
        scope = CalendarScope.HOUSEHOLD,
        title = "synthetic fixture",
        start = CalendarTime.Timed(originalStart, "America/Vancouver"),
        visibility = Visibility.EVERYONE,
        importance = Importance.NORMAL,
        group = "evidence",
        tags = listOf("calendar-evidence"),
        occurrenceId = occurrenceId,
        originalStart = CalendarTime.Timed(originalStart, "America/Vancouver"),
        recurring = false,
        revision = 1,
    )
}
