package io.sentient.mobilesdk.vitals

/** Bounded-by-bytes in-memory write buffer. Single-threaded (the logger routes
 *  on one dispatcher). Oldest lines evicted when total exceeds maxBytes. */
class VitalsRing(private val maxBytes: Int) {
    init { require(maxBytes > 0) { "maxBytes must be > 0" } }
    private val lines = ArrayDeque<String>()
    private var bytes = 0

    fun append(line: String) {
        val size = line.length + 1 // +newline
        lines.addLast(line)
        bytes += size
        while (bytes > maxBytes && lines.size > 1) {
            val removed = lines.removeFirst()
            bytes -= (removed.length + 1)
        }
        if (bytes > maxBytes) {        // lone remaining line still too big → drop it
            lines.removeLast()
            bytes -= size
        }
    }

    /** Returns all buffered lines (newline-joined) and clears the buffer. */
    fun drain(): String {
        if (lines.isEmpty()) return ""
        val sb = StringBuilder()
        for (l in lines) { sb.append(l); sb.append('\n') }
        lines.clear()
        bytes = 0
        return sb.toString()
    }
}
