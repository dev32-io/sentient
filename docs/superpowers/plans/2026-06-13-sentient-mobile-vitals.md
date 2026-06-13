# SentientMobileVitals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A commonMain self-monitoring subsystem (`SentientMobileVitals`) that always captures the app's runtime log into a byte-bounded ring, flushes it to a rolling per-launch file with a session-meta header, captures crashes (sync flush+mark → auto-upload next launch), and uploads a session to an authenticated gateway endpoint that stores it under `clientLogs/mobile/`.

**Architecture:** ~90% lives in `shared/mobile-sdk` commonMain (`io.sentient.mobilesdk.vitals`). Platform file-I/O + crash-handler + device-info live behind ONE injected interface `SentientMobileVitalsPlatform` (impls in androidMain/iosMain). The existing `Log.kt` tees every line into the ring (DEBUG+) before the logcat-level gate. The gateway adds `POST /api/v1/diagnostics/logs` mirroring the `sessions.ts` auth+file-write pattern.

**Tech Stack:** Kotlin Multiplatform (`shared/mobile-sdk`), kotlin.test (commonTest), Ktor HttpClient (existing), Bun/TypeScript gateway, Maestro E2E.

**Test runners:** mobile-sdk → `./gradlew :shared:mobile-sdk:testDebugUnitTest`; gateway → `cd gateway/src && bun test`. Source `scripts/env.sh` first.

**Branch:** continue on `feature/resume-conversation-continuity` (HEAD `5d727e1`). One PR.

---

## Task 1: Platform interface + value types (commonMain)

**Files:**
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/vitals/SentientMobileVitalsPlatform.kt`
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/vitals/VitalsConfig.kt`

- [ ] **Step 1: Create the platform interface + DeviceMeta + config.** No platform imports (commonMain-purity). File ops take String paths + String content (data in/out, per expect-actual-contract rule).

`SentientMobileVitalsPlatform.kt`:
```kotlin
package io.sentient.mobilesdk.vitals

/** Non-PII device facts captured at init (UIDevice / Build). */
data class DeviceMeta(
    val platform: String,   // "ios" | "android"
    val device: String,     // model
    val os: String,         // name + version, e.g. "iOS 26.5"
    val locale: String,
    val freeMemBytes: Long,
    val freeDiskBytes: Long,
)

/**
 * The ONE platform capability surface SentientMobileVitals needs. Impls live in
 * androidMain / iosMain; the app constructs one and passes it to init().
 * File ops are path-in / bytes-out — no platform types cross this boundary.
 */
interface SentientMobileVitalsPlatform {
    /** Absolute dir for vitals files (app-private). Created if missing. */
    fun logsDir(): String
    fun writeFile(path: String, content: String)
    fun appendFile(path: String, content: String)
    fun readFile(path: String): String?
    fun listFiles(dir: String): List<String>   // absolute paths
    fun deleteFile(path: String)

    /** Register an unhandled-crash hook. onCrash runs SYNCHRONOUSLY in the dying
     *  process — it must only flush+mark locally, never network. */
    fun registerCrashHandler(onCrash: () -> Unit)

    fun deviceMeta(): DeviceMeta
}
```

`VitalsConfig.kt`:
```kotlin
package io.sentient.mobilesdk.vitals

data class VitalsConfig(
    val appVersion: String,
    val build: String,
    val sdkVersion: String = "0.1.1",
    val ringMaxBytes: Int = 2 * 1024 * 1024,    // in-memory write buffer
    val fileMaxBytes: Long = 50L * 1024 * 1024, // per-launch file ceiling
    val keepFiles: Int = 5,
)
```

- [ ] **Step 2: Typecheck.** `source scripts/env.sh && ./gradlew :shared:mobile-sdk:compileKotlinMetadata` → no errors.
- [ ] **Step 3: Commit.** `git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/vitals/ && git commit -m "feat(vitals): platform interface + config value types"`

---

## Task 2: VitalsRing — byte-bounded ring (commonMain, TDD)

**Files:**
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/vitals/VitalsRing.kt`
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/vitals/VitalsRingTest.kt`

- [ ] **Step 1: Write the failing test.**
```kotlin
package io.sentient.mobilesdk.vitals

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class VitalsRingTest {
    @Test fun appends_and_drains_in_order() {
        val r = VitalsRing(maxBytes = 1000)
        r.append("a")
        r.append("b")
        assertEquals("a\nb\n", r.drain())
        assertEquals("", r.drain()) // drained
    }

    @Test fun evicts_oldest_when_over_byte_cap() {
        val r = VitalsRing(maxBytes = 10) // tiny
        r.append("11111") // 6 bytes with \n
        r.append("22222") // would be 12 → evict oldest
        val out = r.drain()
        assertTrue(out.contains("22222"))
        assertTrue(!out.contains("11111"))
    }
}
```
- [ ] **Step 2: Run → FAIL.** `./gradlew :shared:mobile-sdk:testDebugUnitTest --tests '*VitalsRingTest*'` → unresolved `VitalsRing`.
- [ ] **Step 3: Implement.**
```kotlin
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
```
- [ ] **Step 4: Run → PASS.** Same command. Green.
- [ ] **Step 5: Commit.** `git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/vitals/VitalsRing.kt shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/vitals/VitalsRingTest.kt && git commit -m "feat(vitals): byte-bounded ring buffer"`

---

## Task 3: SessionMeta header (commonMain, TDD)

**Files:**
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/vitals/SessionMeta.kt`
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/vitals/SessionMetaTest.kt`

- [ ] **Step 1: Failing test.**
```kotlin
package io.sentient.mobilesdk.vitals

import kotlin.test.Test
import kotlin.test.assertTrue

class SessionMetaTest {
    @Test fun header_has_all_fields_and_no_chat_content() {
        val m = SessionMeta(
            platform = "ios", device = "iPhone14,3", os = "iOS 26.5",
            appVersion = "0.1.1", build = "1", sdkVersion = "0.1.1",
            deviceId = "dev-1", userId = "u_abc", sessionStartMs = 1000,
            locale = "en", network = "wifi", freeMemBytes = 1, freeDiskBytes = 2,
        )
        val h = m.renderHeader()
        for (f in listOf("platform=ios","device=iPhone14,3","os=iOS 26.5","appVersion=0.1.1",
                         "deviceId=dev-1","userId=u_abc","network=wifi","sessionStartMs=1000")) {
            assertTrue(h.contains(f), "missing $f")
        }
        assertTrue(h.startsWith("=== SENTIENT VITALS SESSION ==="))
    }
}
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
```kotlin
package io.sentient.mobilesdk.vitals

data class SessionMeta(
    val platform: String, val device: String, val os: String,
    val appVersion: String, val build: String, val sdkVersion: String,
    val deviceId: String, val userId: String?, val sessionStartMs: Long,
    val locale: String, val network: String,
    val freeMemBytes: Long, val freeDiskBytes: Long,
) {
    /** Structured header block written at the top of each rolling file. Non-PII only. */
    fun renderHeader(): String = buildString {
        appendLine("=== SENTIENT VITALS SESSION ===")
        appendLine("platform=$platform"); appendLine("device=$device"); appendLine("os=$os")
        appendLine("appVersion=$appVersion"); appendLine("build=$build"); appendLine("sdkVersion=$sdkVersion")
        appendLine("deviceId=$deviceId"); appendLine("userId=${userId ?: "-"}")
        appendLine("sessionStartMs=$sessionStartMs"); appendLine("locale=$locale"); appendLine("network=$network")
        appendLine("freeMemBytes=$freeMemBytes"); appendLine("freeDiskBytes=$freeDiskBytes")
        appendLine("=== LOG ===")
    }
}
```
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `git add ...SessionMeta.kt ...SessionMetaTest.kt && git commit -m "feat(vitals): session-meta header"`

---

## Task 4: VitalsFiles — rolling file store (commonMain, TDD with a fake platform)

**Files:**
- Create: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/vitals/FakeVitalsPlatform.kt`
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/vitals/VitalsFiles.kt`
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/vitals/VitalsFilesTest.kt`

- [ ] **Step 1: Create the fake platform** (in-memory file map; records crash hook + meta).
```kotlin
package io.sentient.mobilesdk.vitals

class FakeVitalsPlatform(
    private val meta: DeviceMeta = DeviceMeta("android","Pixel","Android 14","en",1,2),
) : SentientMobileVitalsPlatform {
    val files = LinkedHashMap<String, String>()
    var crashHook: (() -> Unit)? = null
    override fun logsDir() = "/vitals"
    override fun writeFile(path: String, content: String) { files[path] = content }
    override fun appendFile(path: String, content: String) { files[path] = (files[path] ?: "") + content }
    override fun readFile(path: String) = files[path]
    override fun listFiles(dir: String) = files.keys.filter { it.startsWith("$dir/") }.toList()
    override fun deleteFile(path: String) { files.remove(path) }
    override fun registerCrashHandler(onCrash: () -> Unit) { crashHook = onCrash }
    override fun deviceMeta() = meta
}
```

- [ ] **Step 2: Failing test** (rotate-at-launch, retain 5, crash marker, flush appends).
```kotlin
package io.sentient.mobilesdk.vitals

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class VitalsFilesTest {
    private fun meta(ts: Long) = SessionMeta("android","Pixel","Android 14","0.1.1","1","0.1.1","d","u",ts,"en","wifi",1,2)

    @Test fun rotates_a_new_file_per_launch_with_posix_suffix_and_header() {
        val p = FakeVitalsPlatform()
        val f = VitalsFiles(p, keepFiles = 5, fileMaxBytes = 1_000_000)
        val path = f.startSession(meta(1700000000000))
        assertTrue(path.startsWith("/vitals/vitals-1700000000000"))
        assertTrue(p.readFile(path)!!.contains("=== SENTIENT VITALS SESSION ==="))
    }

    @Test fun flush_appends_ring_lines_to_current_file() {
        val p = FakeVitalsPlatform()
        val f = VitalsFiles(p, keepFiles = 5, fileMaxBytes = 1_000_000)
        val path = f.startSession(meta(1))
        f.flush("line-x\nline-y\n")
        assertTrue(p.readFile(path)!!.contains("line-x"))
    }

    @Test fun retains_only_keepFiles_newest_sessions() {
        val p = FakeVitalsPlatform()
        val f = VitalsFiles(p, keepFiles = 3, fileMaxBytes = 1_000_000)
        for (ts in listOf(1L,2L,3L,4L,5L)) f.startSession(meta(ts))
        val remaining = p.listFiles("/vitals").size
        assertEquals(3, remaining)
        assertTrue(p.listFiles("/vitals").none { it.contains("vitals-1") || it.contains("vitals-2") })
    }

    @Test fun markCrash_appends_marker_to_current_file() {
        val p = FakeVitalsPlatform()
        val f = VitalsFiles(p, keepFiles = 5, fileMaxBytes = 1_000_000)
        val path = f.startSession(meta(1))
        f.markCrash()
        assertTrue(p.readFile(path)!!.contains("=== CRASH ==="))
        assertTrue(f.listSessions().single().crashed)
    }
}
```

- [ ] **Step 3: Run → FAIL.**
- [ ] **Step 4: Implement.**
```kotlin
package io.sentient.mobilesdk.vitals

data class VitalsSessionInfo(val path: String, val sessionStartMs: Long, val crashed: Boolean, val sizeBytes: Int)

private const val PREFIX = "vitals-"
private const val SUFFIX = ".log"
private const val CRASH_MARK = "\n=== CRASH ===\n"

/** Rolling per-launch file store. One file per startSession(); keepFiles retained;
 *  flush() appends drained ring text; markCrash() appends a marker (sync, on crash). */
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
```
- [ ] **Step 5: Run → PASS.**
- [ ] **Step 6: Commit.** `git add ...vitals/VitalsFiles.kt ...vitals/FakeVitalsPlatform.kt ...vitals/VitalsFilesTest.kt && git commit -m "feat(vitals): rolling per-launch file store"`

---

## Task 5: Log tee — capture DEBUG+ into the ring before the logcat gate

**Files:**
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/vitals/VitalsLogTap.kt`
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/log/Log.kt:48-75` (the `emit` body)
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/vitals/VitalsLogTapTest.kt`

- [ ] **Step 1: Create the tap** (a settable global sink; no-op until vitals registers).
```kotlin
package io.sentient.mobilesdk.vitals

import io.sentient.mobilesdk.log.LogLevel

/** Global tap: Log.emit feeds every formatted line here BEFORE the logcat-level
 *  gate, so the ring captures DEBUG+ even when logcat is INFO-only in release. */
object VitalsLogTap {
    @Volatile private var sink: ((LogLevel, String, String) -> Unit)? = null
    fun register(s: (LogLevel, String, String) -> Unit) { sink = s }
    fun capture(level: LogLevel, tag: String, line: String) { sink?.invoke(level, tag, line) }
}
```

- [ ] **Step 2: Modify `Log.kt` emit** — compute the sanitized line once, tap it before the gate. Replace the body of `emit` (lines ~52-72) so it reads:
```kotlin
private fun emit(level: LogLevel, message: String, props: Map<String, Any?>) {
    val propsStr = if (props.isEmpty()) "" else
        " " + props.entries.joinToString(" ") { (k, v) -> "$k=${truncatePreview(v.toString())}" }
    val line = sanitizeLog(message + propsStr)
    io.sentient.mobilesdk.vitals.VitalsLogTap.capture(level, tag, line) // always-on capture
    if (level.ordinal < LogConfig.minLevel.ordinal) return               // logcat gate
    platformLogSink(tag, level, line)
}
```

- [ ] **Step 3: Failing test** (tap receives DEBUG even when minLevel=INFO).
```kotlin
package io.sentient.mobilesdk.vitals

import io.sentient.mobilesdk.log.LogConfig
import io.sentient.mobilesdk.log.LogLevel
import io.sentient.mobilesdk.log.createLogger
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertTrue

class VitalsLogTapTest {
    @AfterTest fun reset() { VitalsLogTap.register { _,_,_ -> }; LogConfig.minLevel = LogLevel.DEBUG }

    @Test fun captures_debug_even_when_logcat_is_info() {
        LogConfig.minLevel = LogLevel.INFO
        val captured = mutableListOf<Pair<LogLevel,String>>()
        VitalsLogTap.register { lvl, _, line -> captured += lvl to line }
        createLogger("t").debug("hello", mapOf("k" to "v"))
        assertTrue(captured.any { it.first == LogLevel.DEBUG && it.second.contains("hello") })
    }
}
```
- [ ] **Step 4: Run → PASS.** `./gradlew :shared:mobile-sdk:testDebugUnitTest --tests '*VitalsLogTap*'`. Also run the full suite to confirm no regression: `./gradlew :shared:mobile-sdk:testDebugUnitTest`.
- [ ] **Step 5: Commit.** `git add ...vitals/VitalsLogTap.kt ...log/Log.kt ...vitals/VitalsLogTapTest.kt && git commit -m "feat(vitals): log tee captures DEBUG+ into the ring"`

---

## Task 6: VitalsUploader — authenticated POST with progress (commonMain)

**Files:**
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/vitals/VitalsUploader.kt`

> Mirrors `SessionsHttpClient.kt:68-75` (inject `HttpClient` + `gatewayWsUrl` + `token`). Uses Ktor `onUpload` for progress. No isolated unit test (network boundary) — covered by the gateway wire test (Task 9) + E2E (Task 13).

- [ ] **Step 1: Implement.**
```kotlin
package io.sentient.mobilesdk.vitals

import io.ktor.client.HttpClient
import io.ktor.client.request.headers
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.isSuccess
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.sessions.deriveBaseUrl

class VitalsUploader(
    private val http: HttpClient,
    gatewayWsUrl: String,
    private val token: () -> String,
) {
    private val baseUrl = deriveBaseUrl(gatewayWsUrl)
    private val log = createLogger("vitals", "uploader")

    /** POST the file body. onProgress(0.0..1.0). Returns the server ref or null. */
    suspend fun upload(fileName: String, body: String, onProgress: (Double) -> Unit): String? {
        return try {
            val resp = http.post("$baseUrl/api/v1/diagnostics/logs") {
                headers {
                    append(HttpHeaders.Authorization, "Bearer ${token()}")
                    append("X-Vitals-File", fileName)
                }
                setBody(body)
                onUpload { sent, total -> if (total != null && total > 0) onProgress(sent.toDouble() / total) }
            }
            if (!resp.status.isSuccess()) { log.warn("upload.error", mapOf("status" to resp.status.value)); return null }
            val ref = Regex("\"ref\"\\s*:\\s*\"([^\"]+)\"").find(resp.bodyAsText())?.groupValues?.get(1)
            log.info("upload.ok", mapOf("ref" to (ref ?: "-"))); ref
        } catch (e: Throwable) {
            log.warn("upload.failed", mapOf("reason" to (e.message ?: "unknown"))); null
        }
    }
}
```
> If `deriveBaseUrl` is private in `SessionsHttpClient.kt`, lift it to an internal top-level fun in a shared `sessions/Urls.kt` (check its current location at `SessionsHttpClient.kt` first; reuse, don't duplicate).

- [ ] **Step 2: Typecheck.** `./gradlew :shared:mobile-sdk:compileKotlinMetadata`.
- [ ] **Step 3: Commit.** `git add ...vitals/VitalsUploader.kt && git commit -m "feat(vitals): authenticated upload with progress"`

---

## Task 7: SentientMobileVitals facade (commonMain, TDD with fakes)

**Files:**
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/vitals/SentientMobileVitals.kt`
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/vitals/SentientMobileVitalsTest.kt`

- [ ] **Step 1: Failing test** (init rotates a file + registers crash hook; crash hook flushes+marks; onAppBackground flushes; auto-upload fires when a prior file has a crash marker).
```kotlin
package io.sentient.mobilesdk.vitals

import io.sentient.mobilesdk.log.createLogger
import kotlin.test.Test
import kotlin.test.assertTrue

class SentientMobileVitalsTest {
    private fun cfg() = VitalsConfig(appVersion = "0.1.1", build = "1")

    @Test fun init_rotates_file_and_registers_crash_hook() {
        val p = FakeVitalsPlatform()
        val v = SentientMobileVitals()
        v.initForTest(cfg(), p, deviceId = "d", userId = "u", nowMs = 100, network = "wifi", uploader = null)
        assertTrue(p.files.keys.any { it.contains("vitals-100") })
        assertTrue(p.crashHook != null)
    }

    @Test fun crash_hook_flushes_and_marks() {
        val p = FakeVitalsPlatform()
        val v = SentientMobileVitals()
        v.initForTest(cfg(), p, "d","u", 1, "wifi", uploader = null)
        createLogger("x").info("before-crash")
        p.crashHook!!.invoke()
        val file = p.files.entries.single { it.key.contains("vitals-") }.value
        assertTrue(file.contains("before-crash"))
        assertTrue(file.contains("=== CRASH ==="))
    }

    @Test fun onAppBackground_flushes_ring_to_file() {
        val p = FakeVitalsPlatform()
        val v = SentientMobileVitals()
        v.initForTest(cfg(), p, "d","u", 1, "wifi", uploader = null)
        createLogger("x").info("hello-bg")
        v.onAppBackground()
        assertTrue(p.files.entries.single { it.key.contains("vitals-") }.value.contains("hello-bg"))
    }
}
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** (Production `init` builds the uploader; `initForTest` injects a fake/null uploader + clock. Auto-upload-on-crash scans the PRIOR files for a crash marker before rotating the new one.)
```kotlin
package io.sentient.mobilesdk.vitals

import io.sentient.mobilesdk.log.LogLevel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

class SentientMobileVitals {
    private lateinit var ring: VitalsRing
    private lateinit var files: VitalsFiles
    private var uploader: VitalsUploader? = null
    private var scope: CoroutineScope? = null

    /** Production entry: build uploader from the SDK's http client + token. */
    fun init(
        config: VitalsConfig, platform: SentientMobileVitalsPlatform,
        deviceId: String, userId: String?, nowMs: Long, network: String,
        uploader: VitalsUploader?, scope: CoroutineScope?,
    ) {
        this.uploader = uploader; this.scope = scope
        ring = VitalsRing(config.ringMaxBytes)
        files = VitalsFiles(platform, config.keepFiles, config.fileMaxBytes)
        VitalsLogTap.register { _, tag, line -> ring.append("$tag $line") }

        // Auto-upload any PRIOR crashed session before we rotate the new file.
        val crashed = files.listSessions().filter { it.crashed }
        val dm = platform.deviceMeta()
        val meta = SessionMeta(dm.platform, dm.device, dm.os, config.appVersion, config.build,
            config.sdkVersion, deviceId, userId, nowMs, dm.locale, network, dm.freeMemBytes, dm.freeDiskBytes)
        val path = files.startSession(meta)
        platform.registerCrashHandler { ring.drain().let { files.flush(it) }; files.markCrash() }
        for (s in crashed) autoUpload(platform, s)
    }

    fun initForTest(config: VitalsConfig, platform: SentientMobileVitalsPlatform, deviceId: String,
                    userId: String?, nowMs: Long, network: String, uploader: VitalsUploader?) =
        init(config, platform, deviceId, userId, nowMs, network, uploader, scope = null)

    fun onAppBackground() { files.flush(ring.drain()) }

    fun listSessions(): List<VitalsSessionInfo> { files.flush(ring.drain()); return files.listSessions() }

    suspend fun upload(path: String, body: String, fileName: String, onProgress: (Double) -> Unit): String? =
        uploader?.upload(fileName, body, onProgress)

    private fun autoUpload(p: SentientMobileVitalsPlatform, s: VitalsSessionInfo) {
        val u = uploader ?: return; val sc = scope ?: return
        val body = p.readFile(s.path) ?: return
        sc.launch { u.upload(s.path.substringAfterLast('/'), body) { } }
    }
}
```
> `VitalsLogTap` line tag is built as `"$tag $line"`; the level is available if richer formatting is wanted later. Keep it simple now.

- [ ] **Step 4: Run → PASS.** Full suite green: `./gradlew :shared:mobile-sdk:testDebugUnitTest`.
- [ ] **Step 5: Commit.** `git add ...vitals/SentientMobileVitals.kt ...vitals/SentientMobileVitalsTest.kt && git commit -m "feat(vitals): facade — init, crash flush, background flush, auto-upload"`

---

## Task 8: Privacy guard test (commonTest)

**Files:**
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/vitals/PrivacyGuardTest.kt`

- [ ] **Step 1: Write the guard.** Drive the real connectors that touch chat text through the logger + tap, assert the captured ring NEVER contains the message bodies.
```kotlin
package io.sentient.mobilesdk.vitals

import io.sentient.mobilesdk.connectors.InFlightMessageConnector
import io.sentient.mobilesdk.protocol.ServerMessage
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertTrue

class PrivacyGuardTest {
    @AfterTest fun reset() { VitalsLogTap.register { _,_,_ -> } }

    @Test fun captured_log_never_contains_chat_text() {
        val secret = "MY_SECRET_FAVORITE_NUMBER_IS_42"
        val captured = StringBuilder()
        VitalsLogTap.register { _, tag, line -> captured.append(tag).append(' ').append(line).append('\n') }

        val c = InFlightMessageConnector()
        c.handle(ServerMessage.CycleStarted(cycleId = "c1", triggerKind = "t"))
        c.handle(ServerMessage.MessageDelta(cycleId = "c1", delta = secret))
        c.handle(ServerMessage.MessageDone(cycleId = "c1"))

        assertTrue(!captured.contains(secret), "chat text leaked into the diagnostic log:\n$captured")
    }
}
```
> Adjust `ServerMessage.*` constructor args to the real shapes (see `InFlightMessageConnectorTest.kt` for the exact factory calls). If other connectors log content-bearing fields, add them here too.

- [ ] **Step 2: Run → PASS** (proves no leak). `./gradlew :shared:mobile-sdk:testDebugUnitTest --tests '*PrivacyGuard*'`.
- [ ] **Step 3: Commit.** `git add ...vitals/PrivacyGuardTest.kt && git commit -m "test(vitals): privacy guard — no chat content in captured logs"`

---

## Task 9: Gateway endpoint — POST /api/v1/diagnostics/logs

**Files:**
- Create: `gateway/src/api/handlers/diagnostics.ts`
- Modify: `gateway/src/api/router.ts:44-71` (add the route)
- Modify: `gateway/src/server.ts` (build + wire `handleDiagnostics`)

- [ ] **Step 1: Create the handler.** Mirror `sessions.ts` auth (`readBearer` → `tokens.validate` → `userId`). Write the body to `/app/clientLogs/mobile/<userId>-<platform>-<ts>[-crash]-<ref>.log`. Return `{ ref }`.
```typescript
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getLog } from "../../logging/logger.js";
import type { TokenService } from "../../user-auth/token-service.js";

const log = getLog(["sentient", "api", "diagnostics"]);
const HTTP_UNAUTHORIZED = 401, HTTP_BAD_REQUEST = 400, HTTP_OK = 200;
const MAX_BYTES = 64 * 1024 * 1024; // 64MB guard
const CLIENT_LOGS_DIR = process.env.CLIENT_LOGS_DIR ?? "/app/clientLogs";

export interface DiagnosticsDeps { tokens: TokenService }

function readBearer(req: Request): string | null {
  const h = req.headers.get("authorization"); if (!h) return null;
  const p = h.split(" "); return p.length === 2 && p[0]?.toLowerCase() === "bearer" ? (p[1] ?? null) : null;
}
function jsonError(status: number, error: string) {
  return new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });
}
function safe(s: string) { return s.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80); }

export function createDiagnosticsHandler(deps: DiagnosticsDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== "POST") return jsonError(HTTP_BAD_REQUEST, "method-not-allowed");
    const token = readBearer(req); if (!token) return jsonError(HTTP_UNAUTHORIZED, "missing-token");
    const valid = await deps.tokens.validate(token); if (!valid.ok) return jsonError(HTTP_UNAUTHORIZED, valid.error);
    const userId = valid.value.userId;

    const body = await req.text();
    if (body.length > MAX_BYTES) return jsonError(HTTP_BAD_REQUEST, "too-large");

    const fileHint = safe(req.headers.get("x-vitals-file") ?? "session");
    const crashed = fileHint.includes("crash") || body.includes("=== CRASH ===");
    const ref = Math.random().toString(36).slice(2, 8).toUpperCase(); // NOTE: replace with crypto-safe id at impl
    const ts = Date.now();
    const name = `${safe(userId)}-${ts}${crashed ? "-crash" : ""}-${ref}.log`;
    const dir = join(CLIENT_LOGS_DIR, "mobile");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), `# fileHint=${fileHint}\n${body}`, { mode: 0o644 });
    log.info("received", { userId, bytes: body.length, crashed, ref });
    return new Response(JSON.stringify({ ref }), { status: HTTP_OK, headers: { "content-type": "application/json" } });
  };
}
```
> At implementation, replace `Math.random()` with the gateway's existing id helper (grep for `randomUUID`/an id util — do NOT introduce `Math.random()` if the codebase forbids it; check the logging/clean-code rules).

- [ ] **Step 2: Wire the route.** In `router.ts`, add after the `/sessions` line (~line 61):
```typescript
    if (pathname.startsWith(`${API_V1}/diagnostics`)) return deps.handleDiagnostics(request);
```
Add `handleDiagnostics: (request: Request) => Promise<Response>;` to `ApiRouterDeps`. In `server.ts` (near where `handleSessions` is built, ~line 144) build `const handleDiagnostics = createDiagnosticsHandler({ tokens: services.tokens });` and pass it into the router deps (~line 171).

- [ ] **Step 3: Typecheck + gateway tests.** `source scripts/env.sh && bun run typecheck` clean; `cd gateway/src && bun test` green (existing suite must not break).

- [ ] **Step 4: Wire the clientLogs dir.** Confirm the container path. Default `CLIENT_LOGS_DIR=/app/clientLogs` (no config needed; env override allowed).

- [ ] **Step 5: Commit.** `git add gateway/src/api/handlers/diagnostics.ts gateway/src/api/router.ts gateway/src/server.ts && git commit -m "feat(gateway): POST /api/v1/diagnostics/logs → clientLogs/mobile"`

---

## Task 10: Deploy — mount clientLogs/

**Files:**
- Modify: `deploy/docker/docker-compose.yml:92`, `deploy/macos/docker-compose.yml:86`, `deploy/pi/docker-compose.yml:65`

- [ ] **Step 1: Add the sibling volume** in all three, right after the `logs` mount line:
```yaml
      - ~/.sentient/gateway/clientLogs:/app/clientLogs
```
- [ ] **Step 2: Commit.** `git add deploy/*/docker-compose.yml && git commit -m "chore(deploy): mount clientLogs/ next to logs/"`

---

## Task 11: Android platform impl + app wiring

**Files:**
- Create: `shared/mobile-sdk/src/androidMain/kotlin/io/sentient/mobilesdk/vitals/AndroidVitalsPlatform.kt`
- Modify: `android/.../SentientApp.kt:25` area (call `SentientMobileVitals.init`)
- Modify: `android/.../presence/PresenceCoordinator.kt:40-58` (forward background → `onAppBackground`) OR wire at the bind site `UserSessionManager.kt:171-173`
- Modify: `android/.../settings/SettingsScreen.kt:72-94` + `SettingsViewModel.kt:31-48`

- [ ] **Step 1: AndroidVitalsPlatform** (java.io.File + Build + uncaught handler, chaining the prior one):
```kotlin
package io.sentient.mobilesdk.vitals

import android.content.Context
import android.os.Build
import java.io.File

class AndroidVitalsPlatform(private val context: Context) : SentientMobileVitalsPlatform {
    private val dir by lazy { File(context.filesDir, "vitals").apply { mkdirs() } }
    override fun logsDir() = dir.absolutePath
    override fun writeFile(path: String, content: String) = File(path).writeText(content)
    override fun appendFile(path: String, content: String) { File(path).appendText(content) }
    override fun readFile(path: String) = File(path).let { if (it.exists()) it.readText() else null }
    override fun listFiles(dir: String) = File(dir).listFiles()?.map { it.absolutePath } ?: emptyList()
    override fun deleteFile(path: String) { File(path).delete() }
    override fun registerCrashHandler(onCrash: () -> Unit) {
        val prior = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e -> try { onCrash() } finally { prior?.uncaughtException(t, e) } }
    }
    override fun deviceMeta() = DeviceMeta(
        platform = "android", device = "${Build.MANUFACTURER} ${Build.MODEL}",
        os = "Android ${Build.VERSION.RELEASE}", locale = java.util.Locale.getDefault().toString(),
        freeMemBytes = Runtime.getRuntime().freeMemory(), freeDiskBytes = context.filesDir.usableSpace,
    )
}
```

- [ ] **Step 2: Init at app start.** In `SentientApp.kt` after `MobileSdk.initAndroid(applicationContext)` (line 25), call (build version from `BuildConfig`):
```kotlin
val vitalsPlatform = AndroidVitalsPlatform(applicationContext)
AppVitals.instance.init(
    config = VitalsConfig(appVersion = BuildConfig.VERSION_NAME, build = BuildConfig.VERSION_CODE.toString()),
    platform = vitalsPlatform, deviceId = /* the stable deviceId */, userId = /* tokenStore-derived or null */,
    nowMs = System.currentTimeMillis(), network = /* "wifi"/"cellular"/"none" */,
    uploader = /* VitalsUploader(httpClient, gatewayWsUrl, token) */, scope = /* app scope */,
)
```
> `AppVitals.instance` is a single `SentientMobileVitals()` held in `AppDependencies`. Derive `deviceId` from the same source the SDK uses (the persisted device-id), `network` from `ConnectivityManager`. Build the `VitalsUploader` with the same `buildAuthHttpClient(...)` + `gatewayWsUrl` + token used at `UserSessionManager.kt:140-144`.

- [ ] **Step 3: Forward background.** In `PresenceCoordinator` `onStop`, also call `AppVitals.instance.onAppBackground()` (it's safe pre-init: guard with an `isInited` flag in the facade if needed).

- [ ] **Step 4: Settings UI.** Add to `SettingsScreen.kt` a button `testTag("settings-send-logs")` calling `onSendLogs`, and a simple session list (from `vm.sessions`) with human labels + 🔴 for crashed, tapping one calls `onUploadSession(path)`. Add to `SettingsViewModel.kt`: `sessions = AppVitals.instance.listSessions()`, and `fun uploadSession(path, onProgress)` calling `AppVitals.instance.upload(...)` on `viewModelScope`. Button morphs to a progress bar bound to a `StateFlow<Float?>`.

- [ ] **Step 5: Build + install.** `./gradlew :android:assembleDebug` green; install on emulator. (Behavior verified in Task 13 E2E.)
- [ ] **Step 6: Commit.** `git add shared/mobile-sdk/src/androidMain/.../AndroidVitalsPlatform.kt android/ && git commit -m "feat(android): vitals platform + init + settings send-logs"`

---

## Task 12: iOS platform impl + app wiring

**Files:**
- Create: `shared/mobile-sdk/src/iosMain/kotlin/io/sentient/mobilesdk/vitals/IosVitalsPlatform.kt`
- Modify: `ios/App/SentientApp.swift:5-26` (init) + `ios/App/Settings/SettingsView.swift:55-78` (button + picker) + the scene-background hook.

- [ ] **Step 1: IosVitalsPlatform** (NSFileManager + UIDevice + K/N hook + ObjC handler):
```kotlin
package io.sentient.mobilesdk.vitals

import kotlinx.cinterop.ExperimentalForeignApi
import platform.Foundation.*
import platform.UIKit.UIDevice
import kotlin.native.concurrent.ThreadLocal

@OptIn(ExperimentalForeignApi::class)
class IosVitalsPlatform : SentientMobileVitalsPlatform {
    private val fm = NSFileManager.defaultManager
    private val dir: String by lazy {
        val caches = NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, true).first() as String
        val d = "$caches/vitals"; fm.createDirectoryAtPath(d, true, null, null); d
    }
    override fun logsDir() = dir
    override fun writeFile(path: String, content: String) { (content as NSString).writeToFile(path, true, NSUTF8StringEncoding, null) }
    override fun appendFile(path: String, content: String) {
        val handle = NSFileHandle.fileHandleForWritingAtPath(path)
        if (handle == null) { writeFile(path, content); return }
        handle.seekToEndOfFile(); handle.writeData((content as NSString).dataUsingEncoding(NSUTF8StringEncoding)!!); handle.closeFile()
    }
    override fun readFile(path: String) = NSString.stringWithContentsOfFile(path, NSUTF8StringEncoding, null) as String?
    override fun listFiles(dir: String) = (fm.contentsOfDirectoryAtPath(dir, null) ?: emptyList<String>()).map { "$dir/$it" }
    override fun deleteFile(path: String) { fm.removeItemAtPath(path, null) }
    override fun registerCrashHandler(onCrash: () -> Unit) {
        kotlin.native.setUnhandledExceptionHook { onCrash() }       // Kotlin/Native crashes
        IosCrashBridge.onCrash = onCrash                            // ObjC handler set in Swift (NSSetUncaughtExceptionHandler)
    }
    override fun deviceMeta(): DeviceMeta {
        val d = UIDevice.currentDevice
        return DeviceMeta("ios", d.model, "${d.systemName} ${d.systemVersion}", NSLocale.currentLocale.localeIdentifier, 0, 0)
    }
}

@ThreadLocal object IosCrashBridge { var onCrash: (() -> Unit)? = null }
```
> The ObjC `NSSetUncaughtExceptionHandler` is set in Swift (it needs a C-callable function); on fire it calls `IosCrashBridge.onCrash`. Kotlin/Native `setUnhandledExceptionHook` covers shared-code crashes. Document native-signal crashes as the known gap (per spec non-goals).

- [ ] **Step 2: iOS init.** In `SentientApp.swift` `init()`, after the LogConfig lines, construct `IosVitalsPlatform()` + call the facade init through the framework (`MobileData`/`MobileSdk` bridged), passing `Bundle.main` `CFBundleShortVersionString`/`CFBundleVersion`, the device id, token-derived userId, `Date()` ms, network (NWPathMonitor), and a `VitalsUploader` built from the SDK's http client. Set `NSSetUncaughtExceptionHandler { _ in IosCrashBridge().onCrash?() }`.

- [ ] **Step 3: Background hook.** In the scene-lifecycle observer (`UserSessionHost`), on `.background` call the facade `onAppBackground()`.

- [ ] **Step 4: Settings UI.** In `SettingsView.swift` add a `"Send diagnostic log"` button (`accessibilityIdentifier("settings-send-logs")`) + a session list (human labels, 🔴 crash flag) bound to a `SendLogsViewModel`; tap → upload → button→progress→"Sent ✓ ref …".

- [ ] **Step 5: Build.** XCFramework (`:shared:mobile-data:assembleMobileDataDebugXCFramework`) → `xcodegen generate` → `xcodebuild -scheme SentientApp -configuration Debug` green. (Behavior verified in Task 13.)
- [ ] **Step 6: Commit.** `git add shared/mobile-sdk/src/iosMain/.../IosVitalsPlatform.kt ios/ && git commit -m "feat(ios): vitals platform + init + settings send-logs"`

---

## Task 13: E2E — Maestro send-diagnostic + crash auto-upload

> Agent-owned (`.claude/rules/e2e-testing.md` + mobile rules). Local stack (`deploy/macos`), real services, PIN 1234. Evidence under the mobile QA dir.

**Files:**
- Create: `qa/mobile/flows/android/30-send-diagnostic.yaml`, `qa/mobile/flows/ios/30-send-diagnostic.yaml`
- Create: `qa/mobile/evidence/2026-06-13-vitals/results.md`

- [ ] **Step 1: Boot stack** (gateway rebuilt with the diagnostics endpoint + clientLogs volume), emulator + sim, install both apps.
- [ ] **Step 2: Manual upload flow (Android + iOS).** Login → chat a turn → Settings → "Send diagnostic log" → "This session" → assert button→progress→"Sent ✓". Verify a file appears under `~/.sentient/gateway/clientLogs/mobile/` and its header has device/os/build; gateway log `[api:diagnostics] received`.
- [ ] **Step 3: Crash auto-upload.** Trigger a Kotlin unhandled exception (a debug-only crash button or an `adb`/`simctl` hook), relaunch → assert a `-crash-` file lands in `clientLogs/mobile/` with `=== CRASH ===`, no manual step.
- [ ] **Step 4: Privacy spot-check.** Grep an uploaded file for the chat text you sent → MUST be absent.
- [ ] **Step 5: Evidence + commit.** Capture screenshots + the gateway file listing into `results.md`. `git add qa/mobile && git commit -m "test(mobile-e2e): vitals send-diagnostic + crash auto-upload"`

---

## Task 14: Version bumps

**Files:** `shared/mobile-sdk/build.gradle.kts`, `android/build.gradle.kts`, `ios/project.yml` + `ios/App/Info.plist`, `gateway/package.json`.

- [ ] **Step 1:** Bump each +0.0.1 (mobile-sdk + android versionName/Code + ios CFBundleShortVersionString + gateway). Keep coherent.
- [ ] **Step 2: Commit.** `git add ... && git commit -m "chore: bump versions for SentientMobileVitals"`

---

## Pre-handover gate

- All commonTest green (`:shared:mobile-sdk:testDebugUnitTest`), gateway `cd gateway/src && bun test` green, `bun run typecheck` + `bun run lint` clean.
- Android + iOS build (signed; NEVER `CODE_SIGNING_ALLOWED=NO`).
- E2E green (manual upload + crash auto-upload, both platforms), evidence captured, privacy spot-check passed.
- No partial green. Branch left for the user to review/merge — do NOT merge or deploy without explicit go.

## Self-review (gaps / placeholders / consistency)

- Spec coverage: ring (T2), file (T4), meta (T3), tee/always-on-DEBUG (T5), upload+progress (T6), facade+crash+auto-upload (T7), privacy guard (T8), gateway endpoint+clientLogs (T9), deploy volume (T10), android (T11), ios (T12), UX two-lane (T11/T12), e2e (T13), versions (T14). All spec sections mapped.
- Naming consistent: `SentientMobileVitals` / `SentientMobileVitalsPlatform` / `VitalsRing`/`VitalsFiles`/`VitalsUploader`/`VitalsLogTap`/`SessionMeta`/`VitalsConfig` across tasks.
- Two `// NOTE:` markers (replace `Math.random()` with the gateway id helper; confirm `deriveBaseUrl` location) are explicit impl-time checks, not placeholders.
- Native-signal crash capture is intentionally a documented gap (spec non-goal), not a missing task.
