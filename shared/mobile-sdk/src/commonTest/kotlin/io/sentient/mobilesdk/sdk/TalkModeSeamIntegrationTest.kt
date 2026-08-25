// ---------------------------------------------------------------------------
// TalkModeSeamIntegrationTest — KEEPER (per .claude/rules/testing.md): pins the
// TalkModeController ↔ SdkVoice ↔ AudioPipeline seam FSM/invariant end-to-end, over the
// REAL wiring (no seam fakes), on a CONFINED single-thread test dispatcher with NO
// advanceUntilIdle barrier between the controller's back-to-back intents.
//
// WHY confined, not Unconfined: the other SdkVoice tests pin BOTH scope + uplinkDispatcher
// to Dispatchers.Unconfined, which drains the command consumer INLINE on every trySend — a
// barrier that production (Dispatchers.Default.limitedParallelism(1)) does NOT have. That
// hides the seam race: the controller fires endCapture+startCapture (lock) / endCapture+arm
// (release) back-to-back, and the SECOND intent derives/enqueues its command while the FIRST
// has not yet applied. StandardTestDispatcher reproduces production exactly — the consumer
// drains ONLY when the scheduler is advanced, so these tests exercise the real ordering.
//
// Pins the two final-review seam fixes:
//   1. lockMic's continuous capture routes the Duplex/VPIO path (turnMode-authoritative,
//      race-free) — NOT the Hold's Manual path inherited via the old micOn-gated mic-edge.
//   2. releaseMic's proactive-hold arm lands playback-axis-only (mic resolved at APPLY time)
//      — NO mic re-open, NO spurious semantic audio.start after the release's audio.end.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.audioio.AudioPipeline
import io.sentient.mobilesdk.connectors.UserAudioInputConnector
import io.sentient.mobilesdk.fakes.FakeOpusDecoderPort
import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.voice.io.FakeVoiceAudio
import io.sentient.mobilesdk.voice.io.VoiceAudioPath
import io.sentient.mobilesdk.voice.talk.TalkModeController
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class TalkModeSeamIntegrationTest {

    /**
     * REAL TalkModeController → REAL SdkVoice → REAL AudioPipeline → FakeVoiceAudio, all
     * pinned to a CONFINED [StandardTestDispatcher] sharing the test's scheduler. The wire
     * log records the audio.start(turnMode)/audio.end control frames SdkVoice emits on each
     * mic edge, so a spurious re-open is directly observable.
     */
    private class Harness(scheduler: TestCoroutineScheduler) {
        val dispatcher = StandardTestDispatcher(scheduler)
        val scope = CoroutineScope(dispatcher + Job())
        val va = FakeVoiceAudio()

        val controls = mutableListOf<ClientMessage>()
        val connector = UserAudioInputConnector(send = { controls += it }, sendBinary = {})
        private val ids = listOf("capture-1", "capture-2", "capture-3").iterator()
        val wire: List<String> get() = controls.map {
            when (it) {
                is ClientMessage.AudioStart -> "audio.start:${it.turnMode}"
                is ClientMessage.AudioEnd -> "audio.end"
                is ClientMessage.AudioCancel -> "audio.cancel"
                else -> error("unexpected control")
            }
        }

        val voice = SdkVoice(
            voiceAudio = va,
            audioConfig = AudioPipelineConfig(),
            audioInput = { connector },
            onUplinkStart = { capture, mode -> connector.startStreaming(capture, mode) },
            onUplinkBeginTerminal = { connector.beginTerminal(it) },
            onUplinkTerminal = { capture, terminal -> connector.completeTerminal(capture, terminal) },
            scope = scope,
            uplinkDispatcher = dispatcher,
            createCaptureId = { ids.next() },
        )

        val pipeline = AudioPipeline(
            playback = va,
            opusDecoder = FakeOpusDecoderPort(),
            fsm = AudioFsm(),
            scope = scope,
            outputSampleRate = 24_000,
            onStateChanged = { _, _ -> },
            // The production lazy-arm/disarm wiring (mirrors SentientSdk): the downlink drives
            // SdkVoice's serialized configure lane, so the arm composes with the mic axis.
            armPlayback = { voice.armPlayback() },
            disarmPlayback = { voice.requestPlayback(false) },
        )

        val controller = TalkModeController(
            startCapture = { tm -> voice.requestStart(tm) },
            endCapture = { voice.requestStop() },
            cancelCapture = { voice.requestCancel() },
            interrupt = {},
            isCycleOrTtsActive = { false },
            beginHoldDefer = { pipeline.beginHold() },
            endHoldDefer = { pipeline.endHold() },
            discardHoldDefer = { pipeline.discardHold() },
        )
    }

    // ── Fix 1: lockMic binds Continuous to the Duplex path, not the Hold's Manual path ──

    @Test
    fun lockMic_lands_continuous_capture_on_duplex_path_not_manual() = runTest {
        val h = Harness(testScheduler)

        h.controller.pressMic()
        advanceUntilIdle() // settle Hold: micOn=true + tracked path=Manual — the pre-state that exposed the race

        // lockMic fires endCapture + startCapture(Semantic) back-to-back (no barrier between
        // them — that is the seam). The continuous mic-rising configure must route Duplex.
        h.controller.lockMic()
        advanceUntilIdle()

        val (mic, playback, _) = h.va.configureCalls.last()
        assertEquals(true, mic, "continuous entry keeps the mic on")
        assertEquals(false, playback, "continuous entry is the mic-only cell (no TTS yet)")
        assertEquals(
            VoiceAudioPath.Duplex,
            h.va.configuredPaths.last(),
            "semantic turn routes the Duplex/VPIO engine — NOT the Hold's Manual path (the bug inherited Manual via the stale micOn gate)",
        )
        h.scope.cancel()
    }

    // ── Fix 2: proactive-hold release arms media playback WITHOUT re-opening the mic ──

    @Test
    fun releaseMic_after_buffered_hold_arms_media_playback_without_reopening_mic() = runTest {
        val h = Harness(testScheduler)

        h.controller.pressMic()
        advanceUntilIdle() // Hold; downlink deferred, micOn=true, tracked path=Manual

        // A proactive TTS reply arrives DURING the hold → buffered, playback NOT armed.
        h.pipeline.onAudioStart("c1", encoding = "pcm16", sampleRate = 24_000)
        h.pipeline.onAudioFrame(byteArrayOf(1, 2), "c1")
        advanceUntilIdle()
        assertEquals(0, h.va.playedFrames.size, "no playback while holding — frame buffered")
        assertTrue(h.va.configureCalls.none { it.second }, "playback engine NOT armed during Hold")

        // releaseMic fires endCapture(mic=false) + endHoldDefer(arm) back-to-back. The arm is
        // enqueued BEHIND the stop; resolving its mic axis at APPLY time (after the stop set
        // micOn=false) lands it playback-only on the Hold-established Manual (MediaPlayback) cell.
        h.controller.releaseMic()
        advanceUntilIdle()

        val (mic, playback, _) = h.va.configureCalls.last()
        assertEquals(false, mic, "release arm is playback-only — the mic stays down (no re-open)")
        assertEquals(true, playback, "release arm turns playback on")
        assertEquals(
            VoiceAudioPath.Manual,
            h.va.configuredPaths.last(),
            "arm lands on the Hold-established Manual cell → MediaPlayback",
        )
        assertEquals(
            listOf("audio.start:manual", "audio.end"),
            h.wire,
            "exactly the hold turn's start(manual)+end — NO spurious semantic audio.start after the release",
        )
        assertEquals(1, h.va.playedFrames.size, "the buffered hold frame flushes once the arm settles")
        h.scope.cancel()
    }

    // ── Fix 2b: lockMic's flush-arm routes the APPLIED Duplex, not the stale Hold Manual ──

    @Test
    fun lockMic_after_buffered_hold_flushes_arm_on_duplex_keeping_continuous_session() = runTest {
        val h = Harness(testScheduler)

        h.controller.pressMic()
        advanceUntilIdle() // Hold; downlink deferred, micOn=true, tracked path=Manual

        // A proactive TTS reply arrives DURING the hold → buffered, playback NOT armed.
        h.pipeline.onAudioStart("c1", encoding = "pcm16", sampleRate = 24_000)
        h.pipeline.onAudioFrame(byteArrayOf(1, 2), "c1")
        advanceUntilIdle()
        assertEquals(0, h.va.playedFrames.size, "no playback while holding — frame buffered")

        // lockMic fires endCapture + startCapture(Semantic) + endHoldDefer(flush-arm) back-to-back.
        // The flush-arm is enqueued BEHIND the semantic turn-open; resolving its PATH at apply
        // time lands it on the APPLIED Duplex — under the residual bug it snapshotted the stale
        // Hold Manual (consumer still suspended in the stop's cancelAndJoin) and wrote Manual back
        // over Duplex, degrading the whole continuous session to per-reply Capture↔Duplex swaps.
        h.controller.lockMic()
        advanceUntilIdle()

        // configureCalls[i] is index-aligned with configuredPaths[i] (SdkVoice always drives the
        // 4-arg path-carrying configure, so the fake records one of each per call).
        val combos = h.va.configureCalls.zip(h.va.configuredPaths)

        // The (mic=true, playback=true, Manual) ambiguous cell — the iOS facade WARN branch — is
        // the whole failure mode; it must NEVER be configured.
        assertTrue(
            combos.none { (c, p) -> c.first && c.second && p == VoiceAudioPath.Manual },
            "the (mic=true, playback=true, Manual) ambiguous cell is never configured; combos=$combos",
        )
        // The semantic continuous capture applied on the Duplex/VPIO path.
        assertTrue(
            combos.any { (c, p) -> c.first && !c.second && p == VoiceAudioPath.Duplex },
            "semantic continuous capture applied (mic=true, playback=false, Duplex); combos=$combos",
        )
        // The flush-arm (last configure) is the full-duplex VPIO cell on Duplex.
        assertEquals(
            true to true,
            h.va.configureCalls.last().let { it.first to it.second },
            "flush-arm is the full-duplex (mic, playback) cell",
        )
        assertEquals(VoiceAudioPath.Duplex, h.va.configuredPaths.last(), "flush-arm routes Duplex, not the stale Hold Manual")
        assertEquals(1, h.va.playedFrames.size, "the buffered hold frame flushes once the arm settles")

        // currentPath stayed Duplex: a subsequent disarm + re-arm both route Duplex — the
        // continuous session is intact (no per-reply Capture↔Duplex swap, VPIO/AEC preserved).
        val before = h.va.configuredPaths.size
        h.voice.requestPlayback(false) // disarm
        advanceUntilIdle()
        h.voice.armPlayback()          // re-arm (real arm path, ack-carrying)
        advanceUntilIdle()
        val after = h.va.configuredPaths.drop(before)
        assertTrue(
            after.isNotEmpty() && after.all { it == VoiceAudioPath.Duplex },
            "currentPath stayed Duplex — subsequent disarm/arm route Duplex, not Manual; after=$after",
        )
        h.scope.cancel()
    }

    @Test
    fun hold_to_auto_uses_two_ids_and_cancel_is_not_end() = runTest {
        val auto = Harness(testScheduler)
        auto.controller.pressMic()
        auto.controller.lockMic()
        advanceUntilIdle()
        assertEquals(
            listOf(
                ClientMessage.AudioStart("capture-1", "manual"),
                ClientMessage.AudioEnd("capture-1"),
                ClientMessage.AudioStart("capture-2", "semantic"),
            ),
            auto.controls,
        )
        auto.scope.cancel()

        val cancelled = Harness(testScheduler)
        cancelled.controller.pressMic()
        advanceUntilIdle()
        cancelled.controller.cancelHeld()
        advanceUntilIdle()
        assertEquals(
            listOf(ClientMessage.AudioStart("capture-1", "manual"), ClientMessage.AudioCancel("capture-1")),
            cancelled.controls,
        )
        cancelled.scope.cancel()
    }

    // ── Regression guard: the plain press/release flow is unchanged ──

    @Test
    fun plain_press_release_emits_exactly_manual_start_then_end() = runTest {
        val h = Harness(testScheduler)

        h.controller.pressMic()
        advanceUntilIdle()
        h.controller.releaseMic() // no buffered TTS → endHold is a clean no-op (no arm)
        advanceUntilIdle()

        assertEquals(
            listOf("audio.start:manual", "audio.end"),
            h.wire,
            "manual turn emits exactly one start(manual) then one end — nothing spurious",
        )
        assertTrue(h.va.configureCalls.none { it.second }, "no playback ever armed on a plain press/release")
        h.scope.cancel()
    }
}
