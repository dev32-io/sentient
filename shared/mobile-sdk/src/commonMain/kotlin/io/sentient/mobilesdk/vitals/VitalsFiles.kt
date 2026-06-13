package io.sentient.mobilesdk.vitals

data class VitalsSessionInfo(val path: String, val sessionStartMs: Long, val crashed: Boolean, val sizeBytes: Int)

private const val PREFIX = "vitals-"
private const val SUFFIX = ".log"
private const val CRASH_MARK = "\n=== CRASH ===\n"

/**
 * Rolling per-launch file store. One file per startSession(); keepFiles retained;
 * flush() appends drained ring text; markCrash() appends a marker (sync, on crash).
 */
class VitalsFiles(
    private val platform: SentientMobileVitalsPlatform,
    private val keepFiles: Int,
    private val fileMaxBytes: Long,
) {
    private var current: String? = null

    fun startSession(meta: SessionMeta): String {
        val dir = platform.logsDir()
        val path = "$dir/$PREFIX${meta.sessionStartMs}$SUFFIX"
        platform.writeFile(path, meta.renderHeader())
        current = path
        evictOld(dir)
        return path
    }

    fun flush(text: String) {
        if (text.isEmpty()) return
        val path = current ?: return
        val existing = platform.readFile(path)?.length ?: 0
        if (existing >= fileMaxBytes) return // ceiling reached; drop (rare)
        platform.appendFile(path, text)
    }

    fun markCrash() { current?.let { platform.appendFile(it, CRASH_MARK) } }

    fun listSessions(): List<VitalsSessionInfo> =
        platform.listFiles(platform.logsDir())
            .filter { it.substringAfterLast('/').startsWith(PREFIX) }
            .map { p ->
                val content = platform.readFile(p) ?: ""
                val ts = p.substringAfterLast(PREFIX).substringBefore(SUFFIX).toLongOrNull() ?: 0L
                VitalsSessionInfo(p, ts, content.contains("=== CRASH ==="), content.length)
            }
            .sortedByDescending { it.sessionStartMs }

    private fun evictOld(dir: String) {
        val sorted = listSessions()
        if (sorted.size <= keepFiles) return
        sorted.drop(keepFiles).forEach { platform.deleteFile(it.path) }
    }
}
