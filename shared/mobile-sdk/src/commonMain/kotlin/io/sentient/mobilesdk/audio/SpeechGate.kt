package io.sentient.mobilesdk.audio

// ---------------------------------------------------------------------------
// SpeechGate — client-side mic latch.
//
// Port of shared/web-sdk/src/speech-gate.ts (line-by-line).
//
// PROBLEM
// -------
// Per-frame gating on a single speech-positive frame causes two failure modes:
// transient noise (cough, knock) opens a fixed trailing-timer stream → ghost
// STT turns; marginal frames at utterance edges are dropped → one utterance
// fragments into many turns.
//
// DESIGN
// ------
// A latch composed on top of AudioPreRollRing (hangoverFrames=0, because close
// is server-driven on connector.transcript.final, not a local hangover).
//
//   closed — push every frame into the ring as rejected (pre-roll buffer);
//            count sustained speech via sustainedMs. A brief sub-threshold
//            flicker is tolerated (gapToleranceFrames); a longer gap resets.
//   open   — sustainedMs reached openDebounceMs: push the triggering frame as
//            accepted so the ring flushes the buffered onset; forward EVERY
//            subsequent frame until close() or the maxOpenMs failsafe.
//
// COUNTING MECHANISM (mirrors speech-gate.ts verbatim)
// -----------------------------------------------------
// sustainedMs is ms-based: each speech frame increments it by frameDurationMs.
// gap is frame-count-based: each non-speech frame increments gap by 1; when
// gap > gapToleranceFrames, sustainedMs is reset to 0.
// Debounce threshold check: sustainedMs >= openDebounceMs.
//
// CLOCK
// -----
// No real timer. The caller passes a monotonic nowMs to process() — the same
// injected-clock pattern used by EchoGate. Deterministic and testable.
//
// TUNABLES
// --------
// SpeechGateConfig values originate from gateway/config.yaml and flow to the
// client via the session.configure wire frame (Task E3). The orchestrator
// injects them at construction time via SpeechGateConfig.
// ---------------------------------------------------------------------------

/** FSM states for SpeechGate. Mirrors SpeechGateState in speech-gate.ts. */
enum class SpeechGateState { CLOSED, OPEN }

/**
 * Configuration for SpeechGate. All values are operator tunables that must
 * originate from gateway config and arrive via session.configure.
 *
 * @param openDebounceMs      Sustained speech required to open, in ms. Typical: 200.
 * @param frameDurationMs     Duration of one audio frame in ms. Typical: 10.
 * @param gapToleranceFrames  Non-speech frames tolerated before resetting the counter. Typical: 3.
 * @param preRollFrames       Pre-roll frames buffered before onset flush. Typical: 24.
 * @param maxOpenMs           Failsafe: force-close after gate has been open this long. Typical: 20_000.
 */
data class SpeechGateConfig(
    val openDebounceMs: Int,
    val frameDurationMs: Int,
    val gapToleranceFrames: Int,
    val preRollFrames: Int,
    val maxOpenMs: Long,
)

/**
 * Result returned by [SpeechGate.process] for each frame.
 *
 * @param forward Frames to send upstream (may be empty or contain pre-roll + current frame).
 * @param opened  True on the exact frame that transitions closed → open.
 */
data class SpeechGateResult(
    val forward: List<FloatArray>,
    val opened: Boolean,
)

/**
 * SpeechGate gates mic uplink with a sustained-speech debounce and a pre-roll
 * buffer. Pure FSM — no logging, no platform deps, no real timers.
 *
 * All time is caller-supplied so tests are deterministic.
 *
 * @param config Operator-tunable gate parameters.
 */
class SpeechGate(private val config: SpeechGateConfig) {

    // Composed ring with hangoverFrames=0: close is server-driven, not local.
    private val ring = AudioPreRollRing<FloatArray>(
        preRollFrames = config.preRollFrames,
        hangoverFrames = 0,
    )

    private var rawState = SpeechGateState.CLOSED
    private var sustainedMs = 0
    private var gap = 0
    private var openedAtMs = 0L

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /**
     * Feed one captured frame with the VAD speech verdict and current time.
     *
     * Returns the frames to forward upstream and whether the gate just opened.
     * Mirrors the process() function in speech-gate.ts line-by-line.
     */
    fun process(frame: FloatArray, isSpeech: Boolean, nowMs: Long): SpeechGateResult {
        if (rawState == SpeechGateState.OPEN) {
            if (nowMs - openedAtMs >= config.maxOpenMs) {
                reset()
                return SpeechGateResult(forward = emptyList(), opened = false)
            }
            return SpeechGateResult(forward = ring.push(frame, accepted = true), opened = false)
        }

        // Closed state: accumulate sustained speech, tolerate brief gaps.
        if (isSpeech) {
            sustainedMs += config.frameDurationMs
            gap = 0
        } else {
            gap += 1
            if (gap > config.gapToleranceFrames) sustainedMs = 0
            // gap keeps counting after this; harmless since sustainedMs is already 0.
        }

        if (sustainedMs >= config.openDebounceMs) {
            rawState = SpeechGateState.OPEN
            openedAtMs = nowMs
            return SpeechGateResult(forward = ring.push(frame, accepted = true), opened = true)
        }
        return SpeechGateResult(forward = ring.push(frame, accepted = false), opened = false)
    }

    /**
     * Force the gate closed and reset all counters.
     *
     * Call this on connector.transcript.final (server-driven close).
     * Mirrors close() / reset() in speech-gate.ts.
     */
    fun close() {
        reset()
    }

    /** Current FSM state. */
    fun state(): SpeechGateState = rawState

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    /** Full reset — mirrors the reset() inner function in speech-gate.ts. */
    private fun reset() {
        rawState = SpeechGateState.CLOSED
        sustainedMs = 0
        gap = 0
        openedAtMs = 0L
        ring.reset()
    }
}

// ---------------------------------------------------------------------------
// Factory function (mirrors createSpeechGate in speech-gate.ts)
// ---------------------------------------------------------------------------

/**
 * Create a new [SpeechGate] with the given [config].
 *
 * Provided as a top-level function to mirror the TS factory pattern and to
 * keep test call sites readable.
 */
fun createSpeechGate(config: SpeechGateConfig): SpeechGate = SpeechGate(config)
