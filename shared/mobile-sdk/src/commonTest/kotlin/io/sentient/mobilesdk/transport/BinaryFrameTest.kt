// ---------------------------------------------------------------------------
// BinaryFrameTest — wire-contract test for the 9-byte binary header peel.
//
// Pins the process-boundary contract with the gateway FrameSequencer.binary:
//   [8B BE u64 seq][1B type][payload]  →  (seq, type, payload bytes 9+)
// The header MUST be stripped before the payload reaches the Opus pipeline —
// without this peel the leading 9 bytes corrupt the stream (mobile audio break,
// Task 3.5). Keeper per .claude/rules/testing.md (wire contract).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.transport

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class BinaryFrameTest {

    /** Frame seq big-endian into the first 8 bytes (mirrors gateway setBigUint64). */
    private fun frame(seq: Long, type: Int, payload: ByteArray): ByteArray {
        val out = ByteArray(BINARY_HEADER_BYTES + payload.size)
        for (i in 0 until 8) out[i] = ((seq shr (8 * (7 - i))) and 0xFF).toByte()
        out[8] = type.toByte()
        payload.copyInto(out, BINARY_HEADER_BYTES)
        return out
    }

    @Test
    fun peels_seq_type_and_payload_from_bytes_9_onward() {
        val payload = byteArrayOf(10, 20, 30, 40)
        val parsed = parseBinaryFrame(frame(seq = 7, type = BINARY_TYPE_AUDIO, payload = payload))
        assertEquals(7L, parsed!!.seq)
        assertEquals(BINARY_TYPE_AUDIO, parsed.type)
        assertTrue(parsed.payload.contentEquals(payload), "payload=${parsed.payload.toList()}")
    }

    @Test
    fun reads_large_be_u64_seq_correctly() {
        // 0x0000000100000002 = 4294967298 — exercises bytes beyond the low word.
        val seq = 4_294_967_298L
        val parsed = parseBinaryFrame(frame(seq = seq, type = BINARY_TYPE_AUDIO, payload = byteArrayOf(1)))
        assertEquals(seq, parsed!!.seq)
    }

    @Test
    fun empty_payload_after_header_is_valid() {
        val parsed = parseBinaryFrame(frame(seq = 3, type = BINARY_TYPE_AUDIO, payload = ByteArray(0)))
        assertEquals(3L, parsed!!.seq)
        assertEquals(0, parsed.payload.size)
    }

    @Test
    fun frame_shorter_than_header_returns_null() {
        assertNull(parseBinaryFrame(byteArrayOf(1, 2, 3, 4)))
        assertNull(parseBinaryFrame(ByteArray(8))) // 8 bytes < 9-byte header
    }

    @Test
    fun preserves_unknown_type_byte_for_caller_to_drop() {
        val parsed = parseBinaryFrame(frame(seq = 1, type = 0x99, payload = byteArrayOf(5)))
        assertEquals(0x99, parsed!!.type)
    }
}
