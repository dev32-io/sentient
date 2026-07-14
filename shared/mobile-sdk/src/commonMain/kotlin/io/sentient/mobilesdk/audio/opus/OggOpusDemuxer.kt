package io.sentient.mobilesdk.audio.opus

import io.sentient.mobilesdk.log.createLogger

// ---------------------------------------------------------------------------
// OggOpusDemuxer — streaming OGG-page demuxer for OGG-Opus (RFC 7845).
//
// Turns chunked OGG-Opus bytes (TTS downlink, arbitrary-length WS frames)
// into raw opus AUDIO packets ready for libopus decode, plus the
// parsed pre-skip count. Header packets (OpusHead, OpusTags) are consumed
// internally and never returned.
//
// Mirrors the role of the web client's ogg-opus-decoder usage (gateway/webui/
// src/audio/opus-decoder.ts): stateful across chunks, reset between cycles.
// This class does ONLY the OGG demux; opus decode (libopus / kopus) and the
// pre-skip drop happen downstream.
//
// Pure Kotlin, no platform APIs. CRC is intentionally NOT validated — the WS
// transport is reliable (TCP) and dropping packets on a CRC mismatch would be
// worse than trusting the framing.
// ---------------------------------------------------------------------------

/** Magic identifying the OpusHead identification header packet. */
private val OPUS_HEAD_MAGIC = "OpusHead".encodeToByteArray()

/** Magic identifying the OpusTags comment header packet. */
private val OPUS_TAGS_MAGIC = "OpusTags".encodeToByteArray()

/** Byte offset of the channel-count field within an OpusHead packet. */
private const val OPUS_HEAD_CHANNELS_OFFSET = 9

/** Byte offset of the pre-skip field (u16 LE) within an OpusHead packet. */
private const val OPUS_HEAD_PRESKIP_OFFSET = 10

/** Byte offset of the input-sample-rate field (u32 LE) within an OpusHead packet. */
private const val OPUS_HEAD_RATE_OFFSET = 12

/** Minimum OpusHead size we read fields from (magic + version + channels + preSkip + rate). */
private const val OPUS_HEAD_MIN_SIZE = 16

/** Number of header packets to consume before audio begins (OpusHead, OpusTags). */
private const val HEADER_PACKET_COUNT = 2

/** Max bytes shown in a truncated byte preview log. */
private const val PREVIEW_BYTES = 8

class OggOpusDemuxer {

    private val log = createLogger("audio", "ogg-demuxer")

    private var buffer = ByteArray(0)
    private var partialPacket: ByteArray? = null
    private var headerPacketsSeen = 0

    var preSkip: Int = 0
        private set
    var channelCount: Int = 0
        private set
    var inputSampleRate: Int = 0
        private set

    /** Append [bytes] and return every newly-complete raw opus AUDIO packet, in order. */
    fun push(bytes: ByteArray): List<ByteArray> {
        if (bytes.isEmpty()) return emptyList()
        buffer = if (buffer.isEmpty()) bytes.copyOf() else buffer + bytes
        return drainPages()
    }

    /** Clear all streaming state — call between TTS cycles. */
    fun reset() {
        buffer = ByteArray(0)
        partialPacket = null
        headerPacketsSeen = 0
        preSkip = 0
        channelCount = 0
        inputSampleRate = 0
        log.debug("reset")
    }

    /** Parse as many complete pages as the buffer holds; collect audio packets. */
    private fun drainPages(): List<ByteArray> {
        val audio = mutableListOf<ByteArray>()
        while (true) {
            if (!resyncToCapture()) break
            val result = parsePage(buffer, 0)
            if (result is PageParseResult.NeedMore) break
            val page = (result as PageParseResult.Parsed).page
            consumePage(page, audio)
            buffer = buffer.copyOfRange(page.totalBytes, buffer.size)
        }
        return audio
    }

    /** Ensure the buffer starts at an OggS capture pattern; scan + log on desync. */
    private fun resyncToCapture(): Boolean {
        if (hasCapturePattern(buffer, 0)) return true
        val next = findNextCapture(buffer, 0)
        if (next < 0) return false
        log.warn("resync", mapOf("bytesSkipped" to next))
        buffer = buffer.copyOfRange(next, buffer.size)
        return true
    }

    /** Reassemble the page's fragments into whole packets and route each one. */
    private fun consumePage(page: OggPage, audio: MutableList<ByteArray>) {
        log.debug(
            "page",
            mapOf("flags" to page.flags, "fragments" to page.fragments.size, "bytes" to page.totalBytes),
        )
        val packets = reassemble(page)
        for (packet in packets) routePacket(packet, audio)
    }

    /**
     * Merge fragments with the cross-page partial accumulator into whole packets.
     * If the page's last fragment continues, it is held back as the new partial.
     * Desynced streams are logged and dropped rather than emitted as corrupt packets.
     */
    private fun reassemble(page: OggPage): List<ByteArray> {
        val out = mutableListOf<ByteArray>()
        val frags = page.fragments
        if (frags.isEmpty()) return out
        val skipFirst = checkContinuationDesync(page)
        for (i in frags.indices) {
            if (i == 0 && skipFirst) continue
            val isLast = i == frags.lastIndex
            val merged = if (i == 0) joinPartial(frags[0]) else frags[i]
            if (isLast && page.lastFragmentContinues) {
                partialPacket = merged
            } else {
                out.add(merged)
            }
        }
        return out
    }

    /**
     * Detect and resolve two desync cases before reassembly; returns true when the
     * first fragment on this page is an orphan and must be skipped:
     *  1. Page is flagged continued but no partial is pending → head-less orphan fragment.
     *  2. Partial is pending but page is NOT flagged continued → stale partial; discard it.
     */
    private fun checkContinuationDesync(page: OggPage): Boolean {
        if (page.isContinued && partialPacket == null) {
            log.warn(
                "orphan-continuation-dropped",
                mapOf("reason" to "continued-flag set but no pending partial"),
            )
            return true
        }
        if (!page.isContinued && partialPacket != null) {
            log.warn(
                "stale-partial-discarded",
                mapOf("reason" to "pending partial but page not flagged continued"),
            )
            partialPacket = null
        }
        return false
    }

    /** Prepend any held partial packet to the page's first (continued) fragment. */
    private fun joinPartial(first: ByteArray): ByteArray {
        val held = partialPacket ?: return first
        partialPacket = null
        return held + first
    }

    /** Send a whole packet to the header parser or the audio output. */
    private fun routePacket(packet: ByteArray, audio: MutableList<ByteArray>) {
        if (headerPacketsSeen < HEADER_PACKET_COUNT) {
            consumeHeaderPacket(packet)
            return
        }
        if (packet.isEmpty()) {
            log.warn("zero-length-audio-packet-dropped", mapOf("reason" to "lacing [0] yields empty packet"))
            return
        }
        log.debug("packet", mapOf("size" to packet.size, "preview" to preview(packet)))
        audio.add(packet)
    }

    /** Parse OpusHead / OpusTags; both are consumed, neither is emitted. */
    private fun consumeHeaderPacket(packet: ByteArray) {
        when (headerPacketsSeen) {
            0 -> if (startsWith(packet, OPUS_HEAD_MAGIC)) parseOpusHead(packet) else warnMissingMagic("OpusHead")
            else -> if (!startsWith(packet, OPUS_TAGS_MAGIC)) warnMissingMagic("OpusTags")
        }
        headerPacketsSeen++
    }

    private fun warnMissingMagic(expected: String) {
        log.warn("header-magic-mismatch", mapOf("expected" to expected, "index" to headerPacketsSeen))
    }

    /** Extract channels, pre-skip (u16 LE) and input rate (u32 LE) from OpusHead. */
    private fun parseOpusHead(packet: ByteArray) {
        if (packet.size < OPUS_HEAD_MIN_SIZE) {
            log.warn("opus-head-short", mapOf("size" to packet.size))
            return
        }
        channelCount = packet[OPUS_HEAD_CHANNELS_OFFSET].toInt() and 0xFF
        preSkip = readU16Le(packet, OPUS_HEAD_PRESKIP_OFFSET)
        inputSampleRate = readU32Le(packet, OPUS_HEAD_RATE_OFFSET)
        log.info(
            "opus-head",
            mapOf("channels" to channelCount, "preSkip" to preSkip, "inputRate" to inputSampleRate),
        )
    }

    private fun preview(bytes: ByteArray): String {
        val n = minOf(PREVIEW_BYTES, bytes.size)
        return (0 until n).joinToString(",", postfix = if (bytes.size > n) ",…" else "") {
            (bytes[it].toInt() and 0xFF).toString()
        }
    }
}

/** Read an unsigned 16-bit little-endian value at [offset]. */
private fun readU16Le(b: ByteArray, offset: Int): Int =
    (b[offset].toInt() and 0xFF) or ((b[offset + 1].toInt() and 0xFF) shl 8)

/** Read an unsigned 32-bit little-endian value at [offset] (fits in Int for opus rates). */
private fun readU32Le(b: ByteArray, offset: Int): Int =
    (b[offset].toInt() and 0xFF) or
        ((b[offset + 1].toInt() and 0xFF) shl 8) or
        ((b[offset + 2].toInt() and 0xFF) shl 16) or
        ((b[offset + 3].toInt() and 0xFF) shl 24)

/** True if [packet] begins with every byte of [magic]. */
private fun startsWith(packet: ByteArray, magic: ByteArray): Boolean {
    if (packet.size < magic.size) return false
    for (i in magic.indices) if (packet[i] != magic[i]) return false
    return true
}
