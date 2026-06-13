package io.sentient.mobilesdk.vitals

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class VitalsFilesTest {
    private fun meta(ts: Long) = SessionMeta(
        "android", "Pixel", "Android 14", "0.1.1", "1", "0.1.1", "d", "u", ts, "en", "wifi", 1, 2
    )

    @Test fun rotates_a_new_file_per_launch_with_posix_suffix_and_header() {
        val p = FakeVitalsPlatform()
        val f = VitalsFiles(p, keepFiles = 5, fileMaxBytes = 1_000_000)
        val path = f.startSession(meta(1700000000000))
        assertTrue(path.startsWith("/vitals/vitals-1700000000000"))
        assertTrue(p.readFile(path)!!.contains("=== SENTIENT VITALS SESSION ==="))
    }

    @Test fun flush_appends_ring_lines_to_current_file() {
        val p = FakeVitalsPlatform()
        val f = VitalsFiles(p, keepFiles = 5, fileMaxBytes = 1_000_000)
        val path = f.startSession(meta(1))
        f.flush("line-x\nline-y\n")
        assertTrue(p.readFile(path)!!.contains("line-x"))
    }

    @Test fun retains_only_keepFiles_newest_sessions() {
        val p = FakeVitalsPlatform()
        val f = VitalsFiles(p, keepFiles = 3, fileMaxBytes = 1_000_000)
        for (ts in listOf(1L, 2L, 3L, 4L, 5L)) f.startSession(meta(ts))
        val remaining = p.listFiles("/vitals").size
        assertEquals(3, remaining)
        assertTrue(p.listFiles("/vitals").none { it.contains("vitals-1") || it.contains("vitals-2") })
    }

    @Test fun markCrash_appends_marker_to_current_file() {
        val p = FakeVitalsPlatform()
        val f = VitalsFiles(p, keepFiles = 5, fileMaxBytes = 1_000_000)
        val path = f.startSession(meta(1))
        f.markCrash()
        assertTrue(p.readFile(path)!!.contains("=== CRASH ==="))
        assertTrue(f.listSessions().single().crashed)
    }
}
