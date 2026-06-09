// ---------------------------------------------------------------------------
// LazyOpusDecoderPortTest — pins the decoder-survives-reconnect invariant.
//
// KEEPER (per .claude/rules/testing.md): guards a documented bug. The downlink
// opus decoder is a long-lived singleton; the pipeline used to close() it on
// EVERY disconnect (including a transient reconnect) and never rebuild it, so:
//   - decode() after close silently returned empty → TTS went dead, and
//   - reset() after close ran ctl() on the freed native decoder → SIGABRT.
// The fix: close() drops the reference so the NEXT decode() rebuilds a fresh
// decoder, and reset() after close is a no-op. This test pins both.
//
// The real OpusDownlinkDecoder loads native libopus (absent on the host JVM), so
// we exercise the lazy port over a counting fake OpusDecoderPort.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.audio.opus

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class LazyOpusDecoderPortTest {

    /** Records calls + closed state so the test can assert the rebuild contract. */
    private class FakeDecoder : OpusDecoderPort {
        var resets = 0
        var closed = false
        override fun decode(oggChunk: ByteArray): List<ByteArray> {
            check(!closed) { "decode() on a closed decoder — the port must rebuild instead" }
            return listOf(oggChunk)
        }
        override fun reset() {
            check(!closed) { "reset() on a closed decoder — would abort native ctl()" }
            resets += 1
        }
        override fun close() { closed = true }
    }

    @Test
    fun reset_before_first_decode_does_not_build_a_decoder() {
        var built = 0
        val port = LazyOpusDecoderPort { built += 1; FakeDecoder() }

        port.reset()
        port.close()

        assertEquals(0, built, "no decode() yet → no native decoder constructed")
    }

    @Test
    fun decode_after_close_rebuilds_a_fresh_decoder() {
        var built = 0
        val created = mutableListOf<FakeDecoder>()
        val port = LazyOpusDecoderPort { built += 1; FakeDecoder().also { created += it } }

        port.decode(byteArrayOf(1))          // builds #1
        port.close()                          // frees #1, drops the reference
        port.decode(byteArrayOf(2))          // must build #2, NOT reuse the closed #1

        assertEquals(2, built, "decode after close must rebuild a fresh decoder")
        assertTrue(created[0].closed, "the first decoder was closed")
        assertFalse(created[1].closed, "the rebuilt decoder is live")
    }

    @Test
    fun reset_after_close_is_a_noop_not_a_crash() {
        val created = mutableListOf<FakeDecoder>()
        val port = LazyOpusDecoderPort { FakeDecoder().also { created += it } }

        port.decode(byteArrayOf(1))          // builds #1
        port.close()                          // #1 closed, reference dropped
        port.reset()                          // must NOT touch the closed #1 (no crash)

        assertEquals(1, created.size, "reset after close builds nothing")
        // FakeDecoder.reset() would throw if called while closed; reaching here = no-op held.
    }
}
