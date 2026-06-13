package io.sentient.mobilesdk.vitals

import kotlin.test.Test
import kotlin.test.assertTrue

class SessionMetaTest {
    @Test fun header_has_all_fields_and_no_chat_content() {
        val m = SessionMeta(
            platform = "ios", device = "iPhone14,3", os = "iOS 26.5",
            appVersion = "0.1.1", build = "1", sdkVersion = "0.1.1",
            deviceId = "dev-1", userId = "u_abc", sessionStartMs = 1000,
            locale = "en", network = "wifi", freeMemBytes = 1, freeDiskBytes = 2,
        )
        val h = m.renderHeader()
        for (f in listOf("platform=ios","device=iPhone14,3","os=iOS 26.5","appVersion=0.1.1",
                         "deviceId=dev-1","userId=u_abc","network=wifi","sessionStartMs=1000")) {
            assertTrue(h.contains(f), "missing $f")
        }
        assertTrue(h.startsWith("=== SENTIENT VITALS SESSION ==="))
    }
}
