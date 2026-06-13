package io.sentient.mobilesdk.vitals

import io.sentient.mobilesdk.log.createLogger
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertTrue

class SentientMobileVitalsTest {
    @AfterTest fun reset() { VitalsLogTap.clear() }   // don't leak this facade's ring sink into other tests

    private fun cfg() = VitalsConfig(appVersion = "0.1.1", build = "1")

    @Test fun init_rotates_file_and_registers_crash_hook() {
        val p = FakeVitalsPlatform()
        val v = SentientMobileVitals()
        v.initForTest(cfg(), p, deviceId = "d", userId = "u", nowMs = 100, network = "wifi", uploader = null)
        assertTrue(p.files.keys.any { it.contains("vitals-100") })
        assertTrue(p.crashHook != null)
    }

    @Test fun crash_hook_flushes_and_marks() {
        val p = FakeVitalsPlatform()
        val v = SentientMobileVitals()
        v.initForTest(cfg(), p, "d", "u", 1, "wifi", uploader = null)
        createLogger("x").info("before-crash")
        p.crashHook!!.invoke()
        val file = p.files.entries.single { it.key.contains("vitals-") }.value
        assertTrue(file.contains("before-crash"))
        assertTrue(file.contains("=== CRASH ==="))
    }

    @Test fun onAppBackground_flushes_ring_to_file() {
        val p = FakeVitalsPlatform()
        val v = SentientMobileVitals()
        v.initForTest(cfg(), p, "d", "u", 1, "wifi", uploader = null)
        createLogger("x").info("hello-bg")
        v.onAppBackground()
        assertTrue(p.files.entries.single { it.key.contains("vitals-") }.value.contains("hello-bg"))
    }

    @Test fun onAppBackground_before_init_is_a_noop() {
        val v = SentientMobileVitals()
        v.onAppBackground()                 // must not throw
        assertTrue(v.listSessions().isEmpty())
    }
}
