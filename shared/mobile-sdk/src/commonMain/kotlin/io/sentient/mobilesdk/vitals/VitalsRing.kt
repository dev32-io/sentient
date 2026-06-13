package io.sentient.mobilesdk.vitals

/** Bounded-by-bytes in-memory write buffer. Single-threaded (the logger routes
 *  on one dispatcher). Oldest lines evicted when total exceeds maxBytes. */
class VitalsRing(private val maxBytes: Int) {
    private val lines = ArrayDeque<String>()
    private var bytes = 0

    fun append(line: String) {
        val size = line.length + 1 // +newline
        lines.addLast(line)
        bytes += size
        while (bytes > maxBytes && lines.isNotEmpty()) {
            val removed = lines.removeFirst()
            bytes -= (removed.length + 1)
        }
    }

    /** Returns all buffered lines (newline-joined) and clears the buffer. */
    fun drain(): String {
        if (lines.isEmpty()) return ""
        val sb = StringBuilder()
        for (l in lines) { sb.append(l); sb.append('\n') }
        lines.clear(); bytes = 0
        return sb.toString()
    }
}
