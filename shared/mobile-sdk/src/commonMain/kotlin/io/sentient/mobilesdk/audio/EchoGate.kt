package io.sentient.mobilesdk.audio

// Retained for Slice 2 (downlink playback-window reuse); not wired into the current uplink.
// ---------------------------------------------------------------------------
// EchoGate — client-side mic echo suppressor.
//
// Port of shared/web-sdk/src/echo-gate.ts.
//
// PROBLEM
// -------
// When the assistant speaks through device speakers, the microphone picks up
// that audio as "user speech" and sends phantom turns to STT. The gateway
// ramps STT energy thresholds around TTS playback, but those estimates lag
// network jitter and client-side buffer changes. The client has perfect
// timing (it owns the audio sink), so the authoritative gating belongs here.
//
// STATE MACHINE
// -------------
//   baseline  — no assistant audio; low threshold → user speech passes easily.
//   playback  — assistant audio scheduled / playing; high threshold → typical
//               echo fails; loud barge-in still passes.
//   tail      — sink drained; stay at elevated threshold for tailHoldMs (covers
//               DAC buffer / speaker settle / WebRTC loopback latency), then
//               fall back to baseline.
//
// Transitions (mirrors echo-gate.ts verbatim):
//   baseline  — onPlaybackStart  → playback
//   playback  — onPlaybackDrain  → tail  (records tailExpiresAtMs)
//   playback  — onPlaybackCancel → baseline
//   tail      — onPlaybackStart  → playback  (new reply)
//   tail      — onPlaybackCancel → baseline
//   tail      — state(nowMs) / acceptFrame(_, nowMs) when nowMs ≥ tailExpiresAtMs → baseline
//
// CLOCK DEVIATION
// ---------------
// The TS source uses an injected timer callback for the tail hold. The KMP
// port replaces the timer with an injected monotonic timestamp: callers pass
// `nowMs: Long` to `onPlaybackDrain`, `state`, and `acceptFrame`. Expiry is
// computed lazily on each call. Semantics are identical; the design is
// deterministic and testable with no real clock.
//
// THRESHOLD DIRECTION (TS parity verified)
// -----------------------------------------
// Both PLAYBACK and TAIL use `playbackThreshold`. Only BASELINE uses
// `baselineThreshold`. This matches thresholdFor() in echo-gate.ts.
//
// TUNABLES
// --------
// EchoGateConfig values (baselineThreshold, playbackThreshold, tailHoldMs)
// are operator tunables. Per the config rule they must live in the gateway's
// config.yaml and flow to the client via the session.configure wire frame.
// The orchestrator (Task E3) injects them at construction time via EchoGateConfig.
// ---------------------------------------------------------------------------

/** FSM states for EchoGate. Mirrors EchoGateState in echo-gate.ts. */
enum class EchoGateState { BASELINE, PLAYBACK, TAIL }

/**
 * Configuration for EchoGate. Values are operator tunables — they must
 * originate from gateway config (gateway/config.yaml) and arrive via the
 * session.configure wire frame. The orchestrator injects them here.
 *
 * @param baselineThreshold RMS threshold [0,1] when no assistant audio is active. Typical: 0.03.
 * @param playbackThreshold RMS threshold [0,1] during playback and tail hold. Typical: 0.2.
 * @param tailHoldMs        Ms to hold elevated threshold after onPlaybackDrain. Typical: 500–1000.
 */
data class EchoGateConfig(
    val baselineThreshold: Double,
    val playbackThreshold: Double,
    val tailHoldMs: Long,
)

/**
 * EchoGate gates mic uplink to suppress acoustic echo during TTS playback.
 *
 * All time is caller-supplied (injected clock) so tests are deterministic.
 * Thread-safety: single-threaded use assumed (audio pipeline runs on one thread).
 */
class EchoGate(private val cfg: EchoGateConfig) {

    private var rawState = EchoGateState.BASELINE
    private var tailExpiresAtMs = 0L

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /**
     * Return the current logical state at [nowMs].
     *
     * Lazily transitions TAIL → BASELINE when [nowMs] has reached the expiry
     * timestamp recorded by [onPlaybackDrain].
     */
    fun state(nowMs: Long): EchoGateState {
        if (rawState == EchoGateState.TAIL && nowMs >= tailExpiresAtMs) {
            rawState = EchoGateState.BASELINE
        }
        return rawState
    }

    /**
     * Compute the RMS of [pcm] and compare against the threshold for the
     * current state. Returns true if the frame should be forwarded to STT.
     *
     * Empty frames are always rejected (guard matches echo-gate.ts line 185).
     */
    fun acceptFrame(pcm: ShortArray, nowMs: Long): Boolean {
        if (pcm.isEmpty()) return false
        return computeRms(pcm) >= thresholdFor(state(nowMs))
    }

    /**
     * Assistant audio has started playing for [cycleId].
     *
     * Transitions: baseline → playback, tail → playback.
     * Any pending tail expiry is superseded (rawState overwrite is sufficient
     * with the injected-clock model — there is no timer to cancel).
     */
    fun onPlaybackStart(cycleId: String) {
        rawState = EchoGateState.PLAYBACK
    }

    /**
     * The output sink has finished draining all scheduled audio for [cycleId].
     *
     * Records [nowMs] + tailHoldMs as the expiry timestamp and transitions
     * playback → tail. Late or duplicate drains are ignored (guard matches
     * echo-gate.ts line 196).
     */
    fun onPlaybackDrain(cycleId: String, nowMs: Long) {
        if (rawState != EchoGateState.PLAYBACK) return
        tailExpiresAtMs = nowMs + cfg.tailHoldMs
        rawState = EchoGateState.TAIL
    }

    /**
     * Playback was cancelled mid-stream (barge-in or user interrupt) for [cycleId].
     *
     * Returns immediately to BASELINE regardless of current state.
     */
    fun onPlaybackCancel(cycleId: String) {
        rawState = EchoGateState.BASELINE
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    /**
     * Threshold for [s]. Both PLAYBACK and TAIL use playbackThreshold.
     * Mirrors thresholdFor() in echo-gate.ts.
     */
    private fun thresholdFor(s: EchoGateState): Double =
        if (s == EchoGateState.BASELINE) cfg.baselineThreshold else cfg.playbackThreshold
}
