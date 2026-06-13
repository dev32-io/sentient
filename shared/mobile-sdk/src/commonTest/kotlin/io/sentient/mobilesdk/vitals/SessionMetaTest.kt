package io.sentient.mobilesdk.vitals

import kotlin.test.Test
import kotlin.test.assertTrue

class SessionMetaTest {
    private fun meta(userId: String?, device: String = "iPhone14,3") = SessionMeta(
        platform = "ios", device = device, os = "iOS 26.5",
        appVersion = "0.1.1", build = "1", sdkVersion = "0.1.1",
        deviceId = "dev-1", userId = userId, sessionStartMs = 1_718_000_000_000L,
        locale = "en_US@calendar=gregorian", network = "wifi", freeMemBytes = 1, freeDiskBytes = 2,
    )

    @Test fun header_has_all_fields_and_no_chat_content() {
        val h = meta(userId = "u_abc").renderHeader()
        for (f in listOf("platform=ios","device=iPhone14,3","os=iOS 26.5","appVersion=0.1.1",
                         "deviceId=dev-1","userId=u_abc","network=wifi","sessionStartMs=1718000000000")) {
            assertTrue(h.contains(f), "missing $f")
        }
        assertTrue(h.startsWith("=== SENTIENT VITALS SESSION ==="))
        assertTrue(h.contains("=== LOG ==="), "missing closing sentinel")
    }

    @Test fun null_userId_renders_dash() {
        assertTrue(meta(userId = null).renderHeader().contains("userId=-"))
    }

    @Test fun value_with_embedded_newline_cannot_inject_a_sentinel() {
        val h = meta(userId = "u", device = "Evil\n=== CRASH ===").renderHeader()
        // the injected text is flattened onto the device line; no standalone CRASH sentinel
        assertTrue(!h.lineSequence().any { it.trim() == "=== CRASH ===" }, "newline injected a sentinel line")
    }
}
