// ---------------------------------------------------------------------------
// ChatDatabaseRoundTripTest — proves the DatabaseDriverFactory boundary actually
// works against a real (in-memory) SQLite DB on the JVM host.
//
// This pins the persistence boundary for Slice 4: the in-memory factory opens a
// driver, ChatDatabase wraps it, and an upsertMessage write round-trips back out
// of messagesFor with every column intact. If the schema-create, the driver, or a
// generated query drifts, this fails on the JVM unit suite — no emulator/device.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.cache.db

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ChatDatabaseRoundTripTest {
    @Test
    fun `upsertMessage row round-trips through messagesFor on a real in-memory DB`() {
        val driver = InMemoryDatabaseDriverFactory().create()
        val db = ChatDatabase(driver)
        val queries = db.chatDatabaseQueries

        queries.upsertMessage(
            entry_id = "entry-1",
            conversation_id = "conv-1",
            seq = 0L,
            role = "user",
            content = "hello world",
            ts = 1_700_000_000_000L,
            cutoff_kind = null,
        )

        val rows = queries.messagesFor("conv-1").executeAsList()

        assertEquals(1, rows.size)
        val row = rows.single()
        assertEquals("entry-1", row.entry_id)
        assertEquals("conv-1", row.conversation_id)
        assertEquals(0L, row.seq)
        assertEquals("user", row.role)
        assertEquals("hello world", row.content)
        assertEquals(1_700_000_000_000L, row.ts)
        assertNull(row.cutoff_kind)

        driver.close()
    }
}
