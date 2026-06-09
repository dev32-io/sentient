package io.sentient.mobilesdk.audio.opus

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

// ---------------------------------------------------------------------------
// OggOpusDemuxer tests — synthetic OGG-page framing.
//
// The demuxer treats packet payloads as opaque bytes, so no real opus data is
// needed: we build deterministic OggS pages in-test and assert the framing
// state machine (page parse, lacing-table packet boundaries, cross-page
// reassembly, resync, reset) emits exactly the expected audio packets.
//
// OpusHead/OpusTags are header packets the demuxer consumes; only audio packets
// (packet index >= 2 across the whole stream) come back from push().
// ---------------------------------------------------------------------------

// ----- synthetic page builders ---------------------------------------------

private const val FLAG_CONTINUED = 0x01
private const val FLAG_BOS = 0x02
private const val FLAG_EOS = 0x04

/** Build the lacing table for one complete packet of length [len] (255-runs + closer). */
private fun lacingForPacket(len: Int): List<Int> {
    val out = mutableListOf<Int>()
    var remaining = len
    while (remaining >= 255) {
        out.add(255)
        remaining -= 255
    }
    out.add(remaining) // closer < 255 (may be 0), ends the packet
    return out
}

/**
 * Assemble a valid OggS page from a list of WHOLE packets plus an optional
 * trailing continuation fragment. Each whole packet contributes a proper
 * lacing run terminated by a byte < 255. A non-null [continues] fragment is
 * appended with a lacing run of all-255 (no closer), so it spills to the next
 * page; the caller is responsible for setting FLAG_CONTINUED on that page.
 */
private fun buildOggPage(
    flags: Int,
    serial: Int,
    seq: Int,
    packets: List<ByteArray>,
    continues: ByteArray? = null,
): ByteArray {
    val lacing = mutableListOf<Int>()
    val payload = mutableListOf<Byte>()
    for (p in packets) {
        lacing.addAll(lacingForPacket(p.size))
        payload.addAll(p.toList())
    }
    if (continues != null) {
        require(continues.size % 255 == 0 && continues.isNotEmpty()) {
            "continuation fragment must be a positive multiple of 255 so its lacing run has no closer"
        }
        repeat(continues.size / 255) { lacing.add(255) }
        payload.addAll(continues.toList())
    }
    return frame(flags, serial, seq, lacing, payload.toByteArray())
}

/** Low-level OggS frame: 27-byte header + lacing table + payload. CRC left zero. */
private fun frame(flags: Int, serial: Int, seq: Int, lacing: List<Int>, payload: ByteArray): ByteArray {
    val header = ByteArray(27)
    "OggS".encodeToByteArray().copyInto(header, 0)
    header[4] = 0 // version
    header[5] = flags.toByte()
    // granule (6..13), CRC (22..25) left zero — demuxer ignores both.
    writeLe(header, 14, serial, 4)
    writeLe(header, 18, seq, 4)
    header[26] = lacing.size.toByte()
    val lacingBytes = ByteArray(lacing.size) { lacing[it].toByte() }
    return header + lacingBytes + payload
}

private fun writeLe(b: ByteArray, off: Int, value: Int, bytes: Int) {
    for (i in 0 until bytes) b[off + i] = ((value ushr (8 * i)) and 0xFF).toByte()
}

/** A canonical OpusHead packet: mono, preSkip=312, 48000 Hz input rate. */
private fun opusHead(channels: Int = 1, preSkip: Int = 312, rate: Int = 48000): ByteArray {
    val b = ByteArray(19)
    "OpusHead".encodeToByteArray().copyInto(b, 0)
    b[8] = 1 // version
    b[9] = channels.toByte()
    writeLe(b, 10, preSkip, 2)
    writeLe(b, 12, rate, 4)
    // output gain (16..17) + mapping family (18) left zero.
    return b
}

/** A minimal OpusTags packet (magic + zero vendor + zero comment count). */
private fun opusTags(): ByteArray {
    val b = ByteArray(16)
    "OpusTags".encodeToByteArray().copyInto(b, 0)
    // vendor length (8..11) = 0, comment count (12..15) = 0.
    return b
}

/**
 * A large OpusTags packet with a [vendorSize]-byte vendor string. Total packet
 * size = 8 (magic) + 4 (vendor length u32-LE) + vendorSize + 4 (comment count = 0).
 * [vendorSize] should be chosen so the packet spans multiple pages in tests.
 */
private fun opusTagsLong(vendorSize: Int): ByteArray {
    val total = 8 + 4 + vendorSize + 4
    val b = ByteArray(total)
    "OpusTags".encodeToByteArray().copyInto(b, 0)
    writeLe(b, 8, vendorSize, 4)
    // Fill vendor string with 'x' bytes; comment count u32-LE = 0 (already zero).
    for (i in 12 until 12 + vendorSize) b[i] = 'x'.code.toByte()
    return b
}

private fun bytes(vararg v: Int): ByteArray = ByteArray(v.size) { v[it].toByte() }

private fun filledPacket(size: Int, seed: Int): ByteArray = ByteArray(size) { ((it + seed) and 0xFF).toByte() }

// ----- tests ----------------------------------------------------------------

class OggOpusDemuxerTest {

    private fun headerPage(serial: Int = 1): ByteArray =
        buildOggPage(FLAG_BOS, serial, 0, listOf(opusHead())) +
            buildOggPage(0, serial, 1, listOf(opusTags()))

    @Test
    fun single_audio_packet_after_headers() {
        val demux = OggOpusDemuxer()
        val audio = bytes(10, 20, 30, 40, 50)
        val stream = headerPage() + buildOggPage(FLAG_EOS, 1, 2, listOf(audio))

        val out = demux.push(stream)

        assertEquals(1, out.size)
        assertContentEquals(audio, out[0])
        assertEquals(1, demux.channelCount)
        assertEquals(312, demux.preSkip)
        assertEquals(48000, demux.inputSampleRate)
    }

    @Test
    fun multiple_audio_packets_in_one_page_returned_in_order() {
        val demux = OggOpusDemuxer()
        val p1 = bytes(1, 2, 3)
        val p2 = bytes(4, 5)
        val p3 = bytes(6, 7, 8, 9)
        val stream = headerPage() + buildOggPage(0, 1, 2, listOf(p1, p2, p3))

        val out = demux.push(stream)

        assertEquals(3, out.size)
        assertContentEquals(p1, out[0])
        assertContentEquals(p2, out[1])
        assertContentEquals(p3, out[2])
    }

    @Test
    fun packet_split_across_two_pages_is_reassembled() {
        val demux = OggOpusDemuxer()
        // 255-byte head spills (lacing run of one 255, no closer) onto page 3.
        val head = filledPacket(255, seed = 7)
        val tail = bytes(99, 98, 97)
        val whole = head + tail

        val stream = headerPage() +
            buildOggPage(0, 1, 2, packets = emptyList(), continues = head) +
            buildOggPage(FLAG_CONTINUED or FLAG_EOS, 1, 3, listOf(tail))

        val out = demux.push(stream)

        assertEquals(1, out.size)
        assertContentEquals(whole, out[0])
    }

    @Test
    fun packet_length_exact_multiple_of_255_boundary() {
        val demux = OggOpusDemuxer()
        // 510-byte packet → lacing [255, 255, 0]; the closing 0 ends it on this page.
        val big = filledPacket(510, seed = 3)
        val next = bytes(1, 1, 1)
        val stream = headerPage() + buildOggPage(0, 1, 2, listOf(big, next))

        val out = demux.push(stream)

        assertEquals(2, out.size)
        assertContentEquals(big, out[0])
        assertContentEquals(next, out[1])
    }

    @Test
    fun byte_by_byte_feed_yields_same_packets_as_whole_feed() {
        val audio1 = filledPacket(300, seed = 1) // crosses a 255 lacing boundary
        val audio2 = bytes(42, 43, 44)
        val stream = headerPage() +
            buildOggPage(0, 1, 2, listOf(audio1)) +
            buildOggPage(FLAG_EOS, 1, 3, listOf(audio2))

        val whole = OggOpusDemuxer().push(stream)

        val split = OggOpusDemuxer()
        val collected = mutableListOf<ByteArray>()
        for (b in stream) collected.addAll(split.push(byteArrayOf(b)))

        assertEquals(whole.size, collected.size)
        for (i in whole.indices) assertContentEquals(whole[i], collected[i])
        assertEquals(2, collected.size)
        assertContentEquals(audio1, collected[0])
        assertContentEquals(audio2, collected[1])
    }

    @Test
    fun split_mid_header_and_mid_payload_matches_whole_feed() {
        val demux = OggOpusDemuxer()
        val audio = filledPacket(120, seed = 9)
        val stream = headerPage() + buildOggPage(FLAG_EOS, 1, 2, listOf(audio))

        // Split points chosen to land inside a header, inside the lacing table,
        // and inside the payload of the audio page.
        val cuts = listOf(3, 20, 35, stream.size - 5)
        val out = mutableListOf<ByteArray>()
        var start = 0
        for (cut in cuts + stream.size) {
            out.addAll(demux.push(stream.copyOfRange(start, cut)))
            start = cut
        }

        assertEquals(1, out.size)
        assertContentEquals(audio, out[0])
    }

    @Test
    fun garbage_prefix_before_first_oggs_resyncs() {
        val demux = OggOpusDemuxer()
        val audio = bytes(5, 6, 7)
        val garbage = bytes(0xDE, 0xAD, 0xBE, 0xEF, 0x4F, 0x67) // includes partial "Og"
        val stream = garbage + headerPage() + buildOggPage(FLAG_EOS, 1, 2, listOf(audio))

        val out = demux.push(stream)

        assertEquals(1, out.size)
        assertContentEquals(audio, out[0])
    }

    @Test
    fun reset_clears_partial_page_state() {
        val demux = OggOpusDemuxer()
        val full = headerPage() + buildOggPage(FLAG_EOS, 1, 2, listOf(bytes(1, 2, 3)))
        // Feed only part of the stream (mid-page), then reset.
        demux.push(full.copyOfRange(0, full.size - 4))
        assertEquals(312, demux.preSkip) // header page parsed before reset
        demux.reset()
        assertEquals(0, demux.preSkip)
        assertEquals(0, demux.channelCount)
        assertEquals(0, demux.inputSampleRate)

        // A fresh, complete stream after reset parses cleanly with no bleed.
        val audio = bytes(8, 9)
        val out = demux.push(headerPage() + buildOggPage(FLAG_EOS, 1, 2, listOf(audio)))
        assertEquals(1, out.size)
        assertContentEquals(audio, out[0])
    }

    @Test
    fun reset_clears_cross_page_partial_accumulator() {
        val demux = OggOpusDemuxer()
        val head = filledPacket(255, seed = 2)
        // Feed headers + a page whose packet continues; the tail page never arrives.
        demux.push(headerPage() + buildOggPage(0, 1, 2, packets = emptyList(), continues = head))
        demux.reset()

        // After reset, the dangling partial must not prepend to a fresh stream.
        val audio = bytes(70, 71)
        val out = demux.push(headerPage() + buildOggPage(FLAG_EOS, 1, 2, listOf(audio)))
        assertEquals(1, out.size)
        assertContentEquals(audio, out[0])
    }

    @Test
    fun empty_push_returns_empty_list() {
        val demux = OggOpusDemuxer()
        assertTrue(demux.push(ByteArray(0)).isEmpty())
    }

    @Test
    fun truncated_final_page_emits_nothing_no_crash() {
        val demux = OggOpusDemuxer()
        val audio = filledPacket(80, seed = 4)
        val full = headerPage() + buildOggPage(FLAG_EOS, 1, 2, listOf(audio))
        // Drop the last 10 bytes of the audio page payload.
        val out = demux.push(full.copyOfRange(0, full.size - 10))

        assertTrue(out.isEmpty())
        // Headers in the complete leading pages were still parsed.
        assertEquals(312, demux.preSkip)
    }

    @Test
    fun headers_split_across_pushes_then_audio() {
        val demux = OggOpusDemuxer()
        val headPage = buildOggPage(FLAG_BOS, 1, 0, listOf(opusHead(channels = 2, preSkip = 156, rate = 48000)))
        val tagsPage = buildOggPage(0, 1, 1, listOf(opusTags()))
        val audio = bytes(11, 22, 33)
        val audioPage = buildOggPage(FLAG_EOS, 1, 2, listOf(audio))

        assertTrue(demux.push(headPage).isEmpty())
        assertEquals(2, demux.channelCount)
        assertEquals(156, demux.preSkip)
        assertTrue(demux.push(tagsPage).isEmpty())
        val out = demux.push(audioPage)

        assertEquals(1, out.size)
        assertContentEquals(audio, out[0])
    }

    @Test
    fun opus_tags_spanning_two_pages_headers_parse_audio_follows() {
        // OpusTags packet = 271 bytes (8 magic + 4 vendor-len + 255 vendor + 4 comment-count).
        // First 255 bytes spill onto page 1 as a continuation fragment (all-255 lacing).
        // Remaining 16 bytes land on page 2 (FLAG_CONTINUED) as the completing whole packet.
        val demux = OggOpusDemuxer()
        val longTags = opusTagsLong(vendorSize = 255) // total = 271 bytes
        val first255 = longTags.copyOfRange(0, 255)
        val remaining = longTags.copyOfRange(255, longTags.size)
        val audio = bytes(7, 8, 9)

        val stream =
            buildOggPage(FLAG_BOS, 1, 0, listOf(opusHead())) +
                buildOggPage(0, 1, 1, packets = emptyList(), continues = first255) +
                buildOggPage(FLAG_CONTINUED, 1, 2, listOf(remaining)) +
                buildOggPage(FLAG_EOS, 1, 3, listOf(audio))

        val out = demux.push(stream)

        assertEquals(1, out.size, "exactly one audio packet after the two-page tags header")
        assertContentEquals(audio, out[0])
        assertEquals(312, demux.preSkip)
        assertEquals(1, demux.channelCount)
    }

    @Test
    fun audio_packet_spanning_three_pages_is_reassembled() {
        // 765-byte audio packet split as: 255 on page 1 | 255 on page 2 | 255 on page 3.
        // Pages 1 and 2 carry only the continuation fragment (all-255 lacing, no closer).
        // Page 3 (FLAG_CONTINUED) closes with a lacing run [255, 0].
        val demux = OggOpusDemuxer()
        val audio = filledPacket(765, seed = 42)
        val part1 = audio.copyOfRange(0, 255)
        val part2 = audio.copyOfRange(255, 510)
        val part3 = audio.copyOfRange(510, 765)

        val stream =
            headerPage() +
                buildOggPage(0, 1, 2, packets = emptyList(), continues = part1) +
                buildOggPage(FLAG_CONTINUED, 1, 3, packets = emptyList(), continues = part2) +
                buildOggPage(FLAG_CONTINUED or FLAG_EOS, 1, 4, listOf(part3))

        val out = demux.push(stream)

        assertEquals(1, out.size, "three-page audio packet reassembles to one packet")
        assertContentEquals(audio, out[0])
    }

    @Test
    fun orphan_continuation_page_is_dropped_and_subsequent_audio_still_emits() {
        // Send headers, then a page flagged FLAG_CONTINUED with no pending partial.
        // The orphan first-fragment must be dropped; the well-formed audio page that
        // follows must still produce its packet.
        val demux = OggOpusDemuxer()
        val orphanPayload = bytes(0xDE, 0xAD, 0xBE, 0xEF)
        val audio = bytes(55, 66, 77)

        // Build an orphan page: FLAG_CONTINUED set, one whole packet (closing lacing < 255).
        // This simulates a head-less tail fragment arriving without a preceding partial.
        val orphanPage = buildOggPage(FLAG_CONTINUED, 1, 2, listOf(orphanPayload))
        val audioPage = buildOggPage(FLAG_EOS, 1, 3, listOf(audio))

        val stream = headerPage() + orphanPage + audioPage
        val out = demux.push(stream)

        assertEquals(1, out.size, "orphan fragment dropped; audio page still emits one packet")
        assertContentEquals(audio, out[0], "post-orphan audio packet must match the original")
        assertFalse(out.any { it.contentEquals(orphanPayload) }, "orphan payload must not appear in output")
    }
}
