// ---------------------------------------------------------------------------
// ApplyProfileChangeUseCaseTest — pins the settings FSM invariant (per testing
// rules): fast vs slow classification, the 429 → AlreadyApplying edge, a slow-but-
// successful apply resolving as Ready, failure keeping draft semantics (typed
// value, no extra work), and full state reachability + exits.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.usecase.settings

import io.sentient.mobiledata.data.settings.FakeProfileRepository
import io.sentient.mobiledata.data.settings.sampleProfile
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.protocol.AudioPreferencesPatch
import io.sentient.mobilesdk.result.SentientError
import io.sentient.mobilesdk.settings.ApplyResult
import io.sentient.mobilesdk.settings.MemorySlot
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ApplyProfileChangeUseCaseTest {

    private fun useCase(
        repo: FakeProfileRepository,
        patches: MutableList<AudioPreferencesPatch> = mutableListOf(),
    ) = ApplyProfileChangeUseCase(repo) { patches.add(it) }

    // ── classification (pure) ──

    @Test
    fun `audio-only diff classifies as fast`() {
        val prev = sampleProfile(ttsEnabled = true)
        val next = sampleProfile(ttsEnabled = false)
        assertTrue(isAudioOnlyProfileDiff(prev, next))
    }

    @Test
    fun `model diff classifies as slow`() {
        assertTrue(!isAudioOnlyProfileDiff(sampleProfile(modelId = "a"), sampleProfile(modelId = "b")))
    }

    @Test
    fun `audio plus model diff classifies as slow`() {
        val prev = sampleProfile(ttsEnabled = true, modelId = "a")
        val next = sampleProfile(ttsEnabled = false, modelId = "b")
        assertTrue(!isAudioOnlyProfileDiff(prev, next))
    }

    @Test
    fun `diff patch carries only changed audio fields`() {
        val prev = sampleProfile(ttsEnabled = true, channel = "voice")
        val next = sampleProfile(ttsEnabled = false, channel = "voice")
        val patch = diffToAudioPatch(prev, next)
        assertEquals(false, patch.ttsEnabled)
        assertNull(patch.channel) // unchanged → omitted
    }

    // ── FSM: fast path ──

    @Test
    fun `audio-only save is Saving then Ready with live patch and no apply`() = runTest {
        val repo = FakeProfileRepository()
        val patches = mutableListOf<AudioPreferencesPatch>()
        val states = useCase(repo, patches)
            .invoke(ProfileMutation.PutProfile(sampleProfile(channel = "voice"), sampleProfile(channel = "text")))
            .toList()

        assertEquals(listOf(ApplyState.Saving, ApplyState.Ready(0L)), states)
        assertEquals(1, repo.putProfileCalls)
        assertEquals(0, repo.applyCalls, "audio fast path must NOT call apply")
        assertEquals(listOf("text"), patches.map { it.channel }, "live patch carries the changed channel")
    }

    @Test
    fun `fast path with throwing liveAudioPatch still resolves Ready and does not throw`() = runTest {
        val repo = FakeProfileRepository()
        val useCase = ApplyProfileChangeUseCase(repo) { throw IllegalStateException("dead socket") }
        val states = useCase
            .invoke(ProfileMutation.PutProfile(sampleProfile(channel = "voice"), sampleProfile(channel = "text")))
            .toList()

        assertEquals(
            listOf(ApplyState.Saving, ApplyState.Ready(0L)),
            states,
            "the profile PUT already committed — a dead live-sync socket must be best-effort, not a failure",
        )
        assertEquals(1, repo.putProfileCalls)
        assertEquals(0, repo.applyCalls, "audio fast path must NOT call apply")
    }

    // ── FSM: slow path ──

    @Test
    fun `model save is Saving Restarting Ready with one apply`() = runTest {
        val repo = FakeProfileRepository().apply { applyResult = ApplyResult.Ready(900) }
        val states = useCase(repo)
            .invoke(ProfileMutation.PutProfile(sampleProfile(modelId = "a"), sampleProfile(modelId = "b")))
            .toList()

        assertEquals(listOf(ApplyState.Saving, ApplyState.Restarting, ApplyState.Ready(900)), states)
        assertEquals(1, repo.putProfileCalls)
        assertEquals(1, repo.applyCalls)
    }

    @Test
    fun `slow but successful apply resolves as Ready not failure`() = runTest {
        val repo = FakeProfileRepository().apply {
            applyDelayMs = 90_000 // 90s virtual — longer than a naive timeout
            applyResult = ApplyResult.Ready(90_000)
        }
        val states = useCase(repo)
            .invoke(ProfileMutation.PutProfile(sampleProfile(modelId = "a"), sampleProfile(modelId = "b")))
            .toList()

        assertEquals(ApplyState.Restarting, states[1])
        assertTrue(states.last() is ApplyState.Ready, "a slow-but-healthy restart must land Ready")
    }

    // ── FSM: 429 already-applying ──

    @Test
    fun `apply 429 surfaces AlreadyApplying`() = runTest {
        val repo = FakeProfileRepository().apply { applyResult = ApplyResult.InProgress }
        val states = useCase(repo)
            .invoke(ProfileMutation.PutProfile(sampleProfile(modelId = "a"), sampleProfile(modelId = "b")))
            .toList()

        assertEquals(listOf(ApplyState.Saving, ApplyState.Restarting, ApplyState.AlreadyApplying), states)
    }

    // ── FSM: failure keeps draft (typed value, no extra work) ──

    @Test
    fun `profile put failure is Saving then Failed and skips apply`() = runTest {
        val repo = FakeProfileRepository().apply {
            putProfileResult = SentientResult.Failure(SentientError.Connection("offline"))
        }
        val states = useCase(repo)
            .invoke(ProfileMutation.PutProfile(sampleProfile(modelId = "a"), sampleProfile(modelId = "b")))
            .toList()

        assertEquals(ApplyState.Saving, states[0])
        assertTrue(states[1] is ApplyState.Failed)
        assertEquals(0, repo.applyCalls, "a failed write must NOT trigger apply")
    }

    @Test
    fun `apply failure surfaces Failed`() = runTest {
        val repo = FakeProfileRepository().apply { applyResult = ApplyResult.Failed(status = 502, code = "docker-restart") }
        val states = useCase(repo)
            .invoke(ProfileMutation.PutProfile(sampleProfile(modelId = "a"), sampleProfile(modelId = "b")))
            .toList()

        assertEquals(ApplyState.Restarting, states[1])
        assertTrue(states.last() is ApplyState.Failed)
    }

    // ── FSM: restart-on-write endpoints (single call) ──

    @Test
    fun `soul put is Saving Restarting Ready via a single restart call`() = runTest {
        val repo = FakeProfileRepository().apply { soulResult = ApplyResult.Ready(700) }
        val states = useCase(repo).invoke(ProfileMutation.PutSoul("new soul")).toList()

        assertEquals(listOf(ApplyState.Saving, ApplyState.Restarting, ApplyState.Ready(700)), states)
        assertEquals(0, repo.applyCalls, "restart-on-write endpoints do NOT call the separate apply")
    }

    @Test
    fun `memory put restarts`() = runTest {
        val repo = FakeProfileRepository()
        val states = useCase(repo).invoke(ProfileMutation.PutMemory(MemorySlot.USER, "hi")).toList()
        assertEquals(ApplyState.Restarting, states[1])
        assertTrue(states.last() is ApplyState.Ready)
    }

    // ── FSM: personality activate = setActive THEN apply ──

    @Test
    fun `personality activate runs setActive then apply`() = runTest {
        val repo = FakeProfileRepository()
        val states = useCase(repo).invoke(ProfileMutation.ActivatePersonality("Wizard")).toList()

        assertEquals(listOf(ApplyState.Saving, ApplyState.Restarting, ApplyState.Ready(1_200)), states)
        assertEquals(1, repo.applyCalls, "activate must apply to reach the running worker")
    }

    @Test
    fun `personality activate failure skips apply`() = runTest {
        val repo = FakeProfileRepository().apply {
            setActiveResult = SentientResult.Failure(SentientError.Protocol("nope"))
        }
        val states = useCase(repo).invoke(ProfileMutation.ActivatePersonality("Wizard")).toList()

        assertTrue(states.last() is ApplyState.Failed)
        assertEquals(0, repo.applyCalls)
    }
}
