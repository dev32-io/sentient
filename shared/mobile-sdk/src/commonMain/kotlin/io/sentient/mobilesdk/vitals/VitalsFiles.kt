package io.sentient.mobilesdk.vitals

import io.sentient.mobilesdk.log.createLogger

data class VitalsSessionInfo(
    val path: String,
    val sessionStartMs: Long,
    val crashed: Boolean,
    val sizeBytes: Long,
)

private const val PREFIX = "vitals-"
private const val SUFFIX = ".log"
private const val CRASH_SENTINEL = "=== CRASH ==="
private const val CRASH_MARK = "\n$CRASH_SENTINEL\n"

/**
 * Rolling per-launch file store. One file per startSession() (POSIX-ms suffix);
 * keepFiles newest retained; flush() appends drained ring text; markCrash() appends
 * a sync crash marker. The write ceiling is tracked with an in-memory byte counter so
 * flush never re-reads the file, and eviction sorts by the timestamp in the filename
 * so it never reads file content.
 */
class VitalsFiles(
    private val platform: SentientMobileVitalsPlatform,
    private val keepFiles: Int,
    private val fileMaxBytes: Long,
) {
    init { require(keepFiles >= 1) { "keepFiles must be >= 1" } }

    private val log = createLogger("vitals", "files")
    private var current: String? = null
    private var currentBytes: Long = 0

    fun startSession(meta: SessionMeta): String {
        val dir = platform.logsDir()
        val path = uniquePath(dir, meta.sessionStartMs)
        val header = meta.renderHeader()
        platform.writeFile(path, header)
        current = path
        currentBytes = header.length.toLong()
        log.info("session.start", mapOf("path" to path))
        evictOld(dir)
        return path
    }

    fun flush(text: String) {
        if (text.isEmpty()) return
        val path = current ?: return
        if (currentBytes >= fileMaxBytes) {
            log.debug("flush.ceiling", mapOf("currentBytes" to currentBytes, "cap" to fileMaxBytes))
            return
        }
        platform.appendFile(path, text)
        currentBytes += text.length
    }

    fun markCrash() {
        val path = current ?: return
        platform.appendFile(path, CRASH_MARK)
        currentBytes += CRASH_MARK.length
    }

    fun listSessions(): List<VitalsSessionInfo> =
        sessionFiles(platform.logsDir())
            .map { p ->
                val content = platform.readFile(p) ?: ""
                VitalsSessionInfo(p, parseTs(p), content.contains(CRASH_SENTINEL), content.length.toLong())
            }
            .sortedByDescending { it.sessionStartMs }

    /** Avoid clobbering a prior file if two launches land in the same millisecond. */
    private fun uniquePath(dir: String, ts: Long): String {
        val existing = platform.listFiles(dir).toSet()
        var path = "$dir/$PREFIX$ts$SUFFIX"
        var n = 1
        while (path in existing) { path = "$dir/$PREFIX$ts-${n++}$SUFFIX" }
        return path
    }

    /** Eviction needs only filenames + timestamps — never reads file content. */
    private fun evictOld(dir: String) {
        val sorted = sessionFiles(dir).sortedByDescending { parseTs(it) }
        if (sorted.size <= keepFiles) return
        val drop = sorted.drop(keepFiles)
        drop.forEach { platform.deleteFile(it) }
        log.debug("evict", mapOf("deleted" to drop.size, "kept" to keepFiles))
    }

    private fun sessionFiles(dir: String): List<String> =
        platform.listFiles(dir).filter { it.substringAfterLast('/').startsWith(PREFIX) }

    // Base ms before any "-n" collision suffix; unparseable foreign names → 0L (sort oldest, evicted first).
    private fun parseTs(path: String): Long =
        path.substringAfterLast(PREFIX).substringBefore(SUFFIX).substringBefore('-').toLongOrNull() ?: 0L
}
