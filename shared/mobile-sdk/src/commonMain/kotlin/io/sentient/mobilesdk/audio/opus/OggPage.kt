package io.sentient.mobilesdk.audio.opus

// ---------------------------------------------------------------------------
// OggPage — pure page-level parsing for the OGG bitstream (RFC 3533).
//
// A page is a fixed 27-byte header + a `pageSegments`-length lacing table +
// a payload whose length is the sum of the lacing bytes. The lacing table
// also defines packet boundaries WITHIN the page: a packet is the run of
// segments terminated by a lacing byte < 255; a lacing byte of exactly 255
// means the packet continues into the next segment (or, if it is the last
// segment, onto the next page via the continued-packet flag).
//
// Everything here is pure: bytes in, parsed values out. No buffering, no
// platform APIs. The streaming state lives in OggOpusDemuxer.
// ---------------------------------------------------------------------------

/** Capture pattern at the start of every page: ASCII "OggS". */
internal val OGG_CAPTURE_PATTERN = byteArrayOf('O'.code.toByte(), 'g'.code.toByte(), 'g'.code.toByte(), 'S'.code.toByte())

/** Fixed page header size in bytes (before the variable-length lacing table). */
internal const val OGG_HEADER_SIZE = 27

/** Offset of the header-type flags byte within the fixed header. */
internal const val OGG_FLAGS_OFFSET = 5

/** Offset of the page_segments count byte within the fixed header. */
internal const val OGG_SEGMENT_COUNT_OFFSET = 26

/** header-type flag bit 0: this page begins with a continued packet. */
internal const val OGG_FLAG_CONTINUED = 0x01

/** A lacing byte of this value means "packet continues into the next segment". */
internal const val OGG_LACING_CONTINUES = 255

/**
 * A fully-parsed page: its flags, the packet fragments it contains (in order),
 * whether its last fragment continues onto the next page, and the total byte
 * length the page occupied in the buffer (so the caller can advance past it).
 *
 * [fragments] are raw segment-runs split at packet boundaries. The first
 * fragment may be the tail of a packet that began on a previous page (when the
 * continued flag is set); the last fragment may be the head of a packet that
 * continues onto the next page (when [lastFragmentContinues] is true).
 */
internal data class OggPage(
    val flags: Int,
    val fragments: List<ByteArray>,
    val lastFragmentContinues: Boolean,
    val totalBytes: Int,
) {
    val isContinued: Boolean get() = (flags and OGG_FLAG_CONTINUED) != 0
}

/**
 * Outcome of attempting to parse a page at [offset] in [buf].
 *  - [NeedMore]: not enough bytes buffered yet to complete the page.
 *  - [Parsed]:   a complete page was parsed.
 */
internal sealed interface PageParseResult {
    data object NeedMore : PageParseResult
    data class Parsed(val page: OggPage) : PageParseResult
}

/** True if [buf] starts the 4-byte OggS capture pattern at [offset]. */
internal fun hasCapturePattern(buf: ByteArray, offset: Int): Boolean {
    if (offset + OGG_CAPTURE_PATTERN.size > buf.size) return false
    for (i in OGG_CAPTURE_PATTERN.indices) {
        if (buf[offset + i] != OGG_CAPTURE_PATTERN[i]) return false
    }
    return true
}

/**
 * Find the byte index of the next OggS capture pattern at or after [from].
 * Returns -1 if no complete pattern is present in the remaining bytes.
 */
internal fun findNextCapture(buf: ByteArray, from: Int): Int {
    var i = maxOf(from, 0)
    while (i + OGG_CAPTURE_PATTERN.size <= buf.size) {
        if (hasCapturePattern(buf, i)) return i
        i++
    }
    return -1
}

/**
 * Parse one page from [buf] starting at [offset] (which MUST be at a capture
 * pattern). Returns [PageParseResult.NeedMore] until the full page (header +
 * lacing table + payload) is present.
 */
internal fun parsePage(buf: ByteArray, offset: Int): PageParseResult {
    if (offset + OGG_HEADER_SIZE > buf.size) return PageParseResult.NeedMore
    val segmentCount = buf[offset + OGG_SEGMENT_COUNT_OFFSET].toInt() and 0xFF
    val lacingStart = offset + OGG_HEADER_SIZE
    if (lacingStart + segmentCount > buf.size) return PageParseResult.NeedMore

    val lacing = IntArray(segmentCount) { buf[lacingStart + it].toInt() and 0xFF }
    val payloadLen = lacing.sum()
    val payloadStart = lacingStart + segmentCount
    if (payloadStart + payloadLen > buf.size) return PageParseResult.NeedMore

    val flags = buf[offset + OGG_FLAGS_OFFSET].toInt() and 0xFF
    val (fragments, lastContinues) = splitFragments(buf, payloadStart, lacing)
    val total = OGG_HEADER_SIZE + segmentCount + payloadLen
    return PageParseResult.Parsed(OggPage(flags, fragments, lastContinues, total))
}

/**
 * Walk the lacing table, slicing the payload into packet fragments. A fragment
 * ends at the first lacing byte < 255; a trailing run of 255s with no closing
 * byte < 255 means the final fragment continues onto the next page.
 */
private fun splitFragments(buf: ByteArray, payloadStart: Int, lacing: IntArray): Pair<List<ByteArray>, Boolean> {
    val fragments = mutableListOf<ByteArray>()
    var fragStart = payloadStart
    var cursor = payloadStart
    var openFragment = false
    for (len in lacing) {
        cursor += len
        openFragment = true
        if (len < OGG_LACING_CONTINUES) {
            fragments.add(buf.copyOfRange(fragStart, cursor))
            fragStart = cursor
            openFragment = false
        }
    }
    if (openFragment) fragments.add(buf.copyOfRange(fragStart, cursor))
    return fragments to openFragment
}
