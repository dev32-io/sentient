// ---------------------------------------------------------------------------
// BinaryFrame — pure peel of the gateway's 9-byte binary audio header.
//
// Wire layout (Task 3.5+, gateway FrameSequencer.binary):
//   [8-byte BE u64 seq][1-byte type][payload…]
//   type 0x01 = audio
//
// The gateway stamps every outbound binary frame with this header so it can
// dedup replays on reconnect. The mobile client MUST peel it before handing the
// payload to the Opus pipeline — without the peel the first 9 bytes corrupt the
// OGG/Opus stream (the mobile audio break from Task 3.5). This restores audio.
//
// epoch is NOT in the binary header — the client learns it from JSON frames.
// Pure function: no platform types, no coroutines. Big-endian read mirrors the
// gateway's DataView.setBigUint64(0, seq) (littleEndian defaults to false) and
// web-sdk's getBigUint64(0, false).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.transport

/** Binary frame type byte for audio payloads (mirrors gateway BINARY_TYPE_AUDIO). */
const val BINARY_TYPE_AUDIO: Int = 0x01

/** Size of the binary frame header: 8-byte BE u64 seq + 1-byte type. */
const val BINARY_HEADER_BYTES: Int = 9

/**
 * One peeled binary frame: the decoded header [seq] + [type] and the [payload]
 * bytes that follow the 9-byte header (the actual Opus audio).
 */
data class ParsedBinaryFrame(
    val seq: Long,
    val type: Int,
    val payload: ByteArray,
) {
    // ByteArray needs structural equals/hashCode for value comparison in tests.
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is ParsedBinaryFrame) return false
        return seq == other.seq && type == other.type && payload.contentEquals(other.payload)
    }

    override fun hashCode(): Int {
        var result = seq.hashCode()
        result = 31 * result + type
        result = 31 * result + payload.contentHashCode()
        return result
    }
}

/**
 * Peel the 9-byte header from a gateway binary frame.
 *
 * @return the parsed [ParsedBinaryFrame], or null when [bytes] is shorter than
 *   the header (a malformed / truncated frame — caller logs + drops).
 */
fun parseBinaryFrame(bytes: ByteArray): ParsedBinaryFrame? {
    if (bytes.size < BINARY_HEADER_BYTES) return null

    // Read u64 BE seq from bytes 0..7. Practical seqs are well under 2^53, but
    // assemble all 8 bytes for byte-exact parity with the gateway header.
    var seq = 0L
    for (i in 0 until 8) {
        seq = (seq shl 8) or (bytes[i].toLong() and 0xFF)
    }
    val type = bytes[8].toInt() and 0xFF
    val payload = bytes.copyOfRange(BINARY_HEADER_BYTES, bytes.size)
    return ParsedBinaryFrame(seq = seq, type = type, payload = payload)
}
