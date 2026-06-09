package io.sentient.mobilesdk.presence

// ---------------------------------------------------------------------------
// IdleDetector — pure FSM tracking client-side user presence.
//
// Port of shared/web-sdk/src/presence/idle-detector.ts (line-by-line).
//
// Three states:
//   ACTIVE  — elapsed since last reset < warningThresholdMs.
//   WARNING — warningThresholdMs elapsed but idleThresholdMs has not.
//             Reserved for "about to disconnect" signals; today it is an
//             instrumentation hook only.
//   IDLE    — idleThresholdMs elapsed since last reset. Consumers close the WS.
//
// Suppression (level-based):
//   cycleActive, ttsActive, and demandStayCount > 0 block the IDLE transition.
//   While any suppressor is active, ticks that would classify as IDLE are
//   clamped to WARNING. Natural WARNING is never downgraded.
//
// All time is caller-supplied (injected clock); no real timers.
// Thread-safety: single-threaded use assumed (audio/UI pipeline).
// ---------------------------------------------------------------------------

/** Minimum viable idle threshold (mirrors MINIMUM_IDLE_THRESHOLD_MS in idle-detector.ts). */
const val MINIMUM_IDLE_THRESHOLD_MS = 30_000L

/** Default fraction of the idle threshold at which the WARNING state is entered. */
const val DEFAULT_WARNING_FRACTION = 0.9

/** FSM states. Mirrors IdleDetectorState in idle-detector.ts. */
enum class IdleDetectorState { ACTIVE, WARNING, IDLE }

/**
 * Sealed event hierarchy. Mirrors IdleDetectorEvent in idle-detector.ts.
 *
 * @property nowMs Monotonic timestamp from the caller's clock.
 */
sealed class IdleDetectorEvent {
    abstract val nowMs: Long

    data class Interaction(override val nowMs: Long) : IdleDetectorEvent()
    data class CycleStart(override val nowMs: Long) : IdleDetectorEvent()
    data class CycleEnd(override val nowMs: Long) : IdleDetectorEvent()
    data class TtsStart(override val nowMs: Long) : IdleDetectorEvent()
    data class TtsEnd(override val nowMs: Long) : IdleDetectorEvent()
    data class Tick(override val nowMs: Long) : IdleDetectorEvent()
}

/**
 * Configuration for IdleDetector. Values flow from gateway config via session.configure.
 *
 * @param idleThresholdMs     Ms of inactivity after which the client disconnects.
 *                            Must be >= [MINIMUM_IDLE_THRESHOLD_MS].
 * @param warningThresholdMs  Ms of inactivity after which WARNING is entered.
 *                            Defaults to [DEFAULT_WARNING_FRACTION] * idleThresholdMs.
 *                            Must be in [0, idleThresholdMs).
 */
data class IdleDetectorConfig(
    val idleThresholdMs: Long,
    val warningThresholdMs: Long? = null,
)

/**
 * Immutable snapshot of IdleDetector state — safe to pass to listeners / UI.
 * Mirrors IdleDetectorSnapshot in idle-detector.ts.
 */
data class IdleDetectorSnapshot(
    val state: IdleDetectorState,
    val idleThresholdMs: Long,
    val warningThresholdMs: Long,
    /** Monotonic nowMs the machine last reset at. 0 at construction. */
    val lastResetAtMs: Long,
    /** Level-based suppression: a cognitive cycle is in flight. */
    val cycleActive: Boolean,
    /** Level-based suppression: TTS is actively playing. */
    val ttsActive: Boolean,
    /** Consumer-driven suppression counter (see [IdleDetector.acquireDemandStay]). */
    val demandStayCount: Int,
)

/**
 * IdleDetector public interface. Mirrors IdleDetector in idle-detector.ts.
 */
interface IdleDetector {
    /** Feed an event. Returns the post-event state. */
    fun handle(event: IdleDetectorEvent): IdleDetectorState

    /** Current snapshot — immutable copy safe to pass to listeners / UI. */
    fun snapshot(): IdleDetectorSnapshot

    /**
     * Consumer escape hatch. Increments an internal counter; while the counter
     * is > 0 the detector cannot enter IDLE (ticks clamp to WARNING). The
     * returned function decrements the counter exactly once — further calls are
     * safe no-ops. Nested / parallel demands all must release for suppression to lift.
     */
    fun acquireDemandStay(): () -> Unit
}

/**
 * Create a new [IdleDetector] with the given [config].
 *
 * Throws [IllegalArgumentException] for invalid config (mirrors validateConfig in idle-detector.ts).
 */
fun createIdleDetector(config: IdleDetectorConfig): IdleDetector {
    validateConfig(config)
    return IdleDetectorImpl(config)
}

// ---------------------------------------------------------------------------
// Internal implementation
// ---------------------------------------------------------------------------

private class IdleDetectorImpl(config: IdleDetectorConfig) : IdleDetector {

    private val idleThresholdMs: Long = config.idleThresholdMs
    private val warningThresholdMs: Long =
        config.warningThresholdMs ?: (idleThresholdMs * DEFAULT_WARNING_FRACTION).toLong()

    private var state = IdleDetectorState.ACTIVE
    private var lastResetAtMs = 0L
    private var cycleActive = false
    private var ttsActive = false
    private var demandStayCount = 0

    override fun snapshot(): IdleDetectorSnapshot = IdleDetectorSnapshot(
        state = state,
        idleThresholdMs = idleThresholdMs,
        warningThresholdMs = warningThresholdMs,
        lastResetAtMs = lastResetAtMs,
        cycleActive = cycleActive,
        ttsActive = ttsActive,
        demandStayCount = demandStayCount,
    )

    override fun handle(event: IdleDetectorEvent): IdleDetectorState {
        applyEvent(event)
        return state
    }

    override fun acquireDemandStay(): () -> Unit {
        demandStayCount++
        var released = false
        return {
            if (!released) {
                released = true
                demandStayCount--
            }
        }
    }

    // -----------------------------------------------------------------------
    // FSM internals
    // -----------------------------------------------------------------------

    private fun isSuppressed(): Boolean =
        cycleActive || ttsActive || demandStayCount > 0

    private fun setState(next: IdleDetectorState) {
        state = next
    }

    private fun reset(nowMs: Long) {
        lastResetAtMs = nowMs
        setState(IdleDetectorState.ACTIVE)
    }

    private fun advance(nowMs: Long) {
        // Non-monotonic input: ignore (mirrors idle-detector.ts line 187).
        if (nowMs < lastResetAtMs) return
        val elapsed = nowMs - lastResetAtMs
        val natural = classifyElapsed(elapsed)
        val effective = suppressIdle(natural)
        setState(effective)
    }

    private fun suppressIdle(natural: IdleDetectorState): IdleDetectorState {
        if (natural != IdleDetectorState.IDLE) return natural
        if (!isSuppressed()) return natural
        return IdleDetectorState.WARNING
    }

    private fun classifyElapsed(elapsed: Long): IdleDetectorState = when {
        elapsed >= idleThresholdMs -> IdleDetectorState.IDLE
        elapsed >= warningThresholdMs -> IdleDetectorState.WARNING
        else -> IdleDetectorState.ACTIVE
    }

    private fun applyEvent(event: IdleDetectorEvent) {
        when (event) {
            is IdleDetectorEvent.Tick -> advance(event.nowMs)
            is IdleDetectorEvent.CycleStart -> {
                cycleActive = true
                reset(event.nowMs)
            }
            is IdleDetectorEvent.CycleEnd -> {
                cycleActive = false
                reset(event.nowMs)
            }
            is IdleDetectorEvent.TtsStart -> {
                ttsActive = true
                reset(event.nowMs)
            }
            is IdleDetectorEvent.TtsEnd -> {
                ttsActive = false
                reset(event.nowMs)
            }
            is IdleDetectorEvent.Interaction -> reset(event.nowMs)
        }
    }
}

// ---------------------------------------------------------------------------
// Config validation — mirrors validateConfig in idle-detector.ts
// ---------------------------------------------------------------------------

private fun validateConfig(config: IdleDetectorConfig) {
    require(config.idleThresholdMs >= MINIMUM_IDLE_THRESHOLD_MS) {
        "IdleDetector: idleThresholdMs must be >= $MINIMUM_IDLE_THRESHOLD_MS, got ${config.idleThresholdMs}"
    }
    val warning = config.warningThresholdMs ?: return
    require(warning >= 0) {
        "IdleDetector: warningThresholdMs must be >= 0, got $warning"
    }
    require(warning < config.idleThresholdMs) {
        "IdleDetector: warningThresholdMs ($warning) must be < idleThresholdMs (${config.idleThresholdMs})"
    }
}
