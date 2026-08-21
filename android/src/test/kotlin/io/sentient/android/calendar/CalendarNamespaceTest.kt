package io.sentient.android.calendar

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class CalendarNamespaceTest {
    @Test
    fun `namespace uses explicit authenticated id and strips backend credentials and query`() {
        val namespace = calendarCacheNamespace(
            authenticatedUserId = "  server-user-a  ",
            gatewayWsUrl = "WSS://private:secret@Example.COM:443/api/v1/ws?token=do-not-store#fragment",
        )

        assertEquals("server-user-a", namespace.accountId)
        assertEquals("wss://example.com/api/v1/ws", namespace.backendId)
        assertFalse("secret" in namespace.backendId)
        assertFalse("token" in namespace.backendId)
    }

    @Test
    fun `backend identity normalizes default ports and endpoint casing`() {
        assertEquals(
            normalizedCalendarBackendIdentity("ws://EXAMPLE.test:80/api/v1/ws/"),
            normalizedCalendarBackendIdentity("ws://example.test/api/v1/ws"),
        )
        assertTrue(
            normalizedCalendarBackendIdentity("wss://example.test/api/v1/ws") !=
                normalizedCalendarBackendIdentity("ws://example.test/api/v1/ws"),
        )
    }

    @Test
    fun `blank authenticated identity fails closed`() {
        assertFailsWith<IllegalArgumentException> {
            calendarCacheNamespace("  ", "wss://example.test/api/v1/ws")
        }
    }

    @Test
    fun `production database filename contains no session or backend identity`() {
        assertEquals("calendar-cache.db", CALENDAR_DATABASE_NAME)
        assertFalse("server-user" in CALENDAR_DATABASE_NAME)
        assertFalse("example.test" in CALENDAR_DATABASE_NAME)
    }
}
