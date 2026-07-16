// ---------------------------------------------------------------------------
// ApplyProfileChangeUseCase — THE settings state machine.
//
// Executes one [ProfileMutation] and exposes the outcome as a cold [Flow] of
// [ApplyState] transitions the VM folds into its page state:
//
//   Idle → Saving → (audio-only diff)  Ready                         [FAST: no restart]
//                 → (needs-restart)     Restarting → Ready            [SLOW: PUT then apply]
//                                                   → AlreadyApplying [429 apply-in-progress]
//                                                   → Failed          [apply/restart error]
//                 → Failed                                            [the write itself failed]
//
// Fast path (audio-only profile diff): PUT the profile, then push the live WS
// preference patch (TTS on/off + reply channel) so the running session updates
// instantly — no worker restart (mirrors webui onAudioApplied). Everything else is
// a slow save that blocks through the Hermes restart; a failure returns a typed
// value and NEVER mutates caller state (the draft lives in the VM).
//
// Restart mutations block MULTI-SECONDS through the worker restart — the injected
// HttpClient (SettingsComponent's) MUST carry a generous request timeout, else a
// slow-but-healthy restart resolves as ApplyResult.Network. See SettingsComponent.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.usecase.settings

import io.sentient.mobiledata.data.settings.MSG_RESTART_FAILED
import io.sentient.mobiledata.data.settings.ProfileRepository
import io.sentient.mobiledata.data.settings.toSentientErrorOrNull
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.AudioPreferencesPatch
import io.sentient.mobilesdk.result.SentientError
import io.sentient.mobilesdk.settings.ApplyResult
import io.sentient.mobilesdk.settings.ProfileV1
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.flow.flow

class ApplyProfileChangeUseCase(
    private val profile: ProfileRepository,
    private val liveAudioPatch: suspend (AudioPreferencesPatch) -> Unit,
) {
    private val log = createLogger("data", "settings", "apply-profile")

    /** Drive [mutation] and stream its FSM transitions. Collect once (a mutation runs once). */
    operator fun invoke(mutation: ProfileMutation): Flow<ApplyState> = flow {
        log.info("dispatch", mapOf("mutation" to mutation.label()))
        go(ApplyState.Saving, ApplyState.Idle, mutation.label())
        when (mutation) {
            is ProfileMutation.PutProfile -> runPutProfile(mutation)
            is ProfileMutation.PutSoul -> runRestartWrite("soul.put") { profile.putSoul(mutation.content) }
            is ProfileMutation.PutMemory ->
                runRestartWrite("memory.put") { profile.putMemory(mutation.slot, mutation.content) }
            is ProfileMutation.CreatePersonality ->
                runRestartWrite("personality.create") { profile.createPersonality(mutation.name, mutation.body) }
            is ProfileMutation.UpdatePersonality ->
                runRestartWrite("personality.update") { profile.updatePersonality(mutation.name, mutation.body) }
            is ProfileMutation.DeletePersonality ->
                runRestartWrite("personality.delete") { profile.deletePersonality(mutation.name) }
            is ProfileMutation.ActivatePersonality -> runActivate(mutation.name)
        }
    }

    private suspend fun FlowCollector<ApplyState>.runPutProfile(m: ProfileMutation.PutProfile) {
        when (val put = profile.putProfile(m.next)) {
            is SentientResult.Failure -> go(ApplyState.Failed(put.error), ApplyState.Saving, "profile.put.failed")
            is SentientResult.Success -> {
                if (isAudioOnlyProfileDiff(m.previous, m.next)) {
                    applyLiveAudioPatch(diffToAudioPatch(m.previous, m.next))
                    go(ApplyState.Ready(0L), ApplyState.Saving, "audio-only")
                } else {
                    go(ApplyState.Restarting, ApplyState.Saving, "needs-restart")
                    emitApplyOutcome(profile.apply())
                }
            }
            is SentientResult.Loading -> Unit // one-shot ops never emit Loading
        }
    }

    /**
     * Best-effort live WS preference push after a committed profile PUT. The write already
     * persisted server-side, so a dead socket here must NOT surface as a failure — log and
     * move on. CancellationException is rethrown; everything else is swallowed as a value.
     */
    private suspend fun applyLiveAudioPatch(patch: AudioPreferencesPatch) {
        runCatching { liveAudioPatch(patch) }
            .onSuccess {
                log.info("audio.fast-path", mapOf("tts" to patch.ttsEnabled, "channel" to patch.channel))
            }
            .onFailure { e ->
                if (e is CancellationException) throw e
                log.warn(
                    "audio.fast-path.live-sync-failed",
                    mapOf(
                        "reason" to (e.message ?: e::class.simpleName ?: "unknown"),
                        "tts" to patch.ttsEnabled,
                        "channel" to patch.channel,
                    ),
                )
            }
    }

    /** Restart-on-write endpoints (soul / memory / personality CUD): one call does write + restart. */
    private suspend fun FlowCollector<ApplyState>.runRestartWrite(op: String, write: suspend () -> ApplyResult) {
        go(ApplyState.Restarting, ApplyState.Saving, op)
        emitApplyOutcome(write())
    }

    /** Activate: imperative 204, THEN apply so the active personality reaches the running worker. */
    private suspend fun FlowCollector<ApplyState>.runActivate(name: String) {
        when (val r = profile.setActivePersonality(name)) {
            is SentientResult.Failure ->
                go(ApplyState.Failed(r.error), ApplyState.Saving, "personality.activate.failed")
            is SentientResult.Success -> {
                go(ApplyState.Restarting, ApplyState.Saving, "personality.activate")
                emitApplyOutcome(profile.apply())
            }
            is SentientResult.Loading -> Unit
        }
    }

    private suspend fun FlowCollector<ApplyState>.emitApplyOutcome(result: ApplyResult) {
        when (result) {
            is ApplyResult.Ready -> go(ApplyState.Ready(result.elapsedMs), ApplyState.Restarting, "apply.ready")
            ApplyResult.InProgress -> go(ApplyState.AlreadyApplying, ApplyState.Restarting, "apply.in-progress")
            is ApplyResult.Failed, is ApplyResult.Network -> {
                val err = result.toSentientErrorOrNull() ?: SentientError.Protocol(MSG_RESTART_FAILED)
                go(ApplyState.Failed(err), ApplyState.Restarting, "apply.failed")
            }
        }
    }

    private suspend fun FlowCollector<ApplyState>.go(to: ApplyState, from: ApplyState, trigger: String) {
        log.info("transition", mapOf("from" to from.label(), "to" to to.label(), "trigger" to trigger))
        emit(to)
    }
}

/** True when every profile field EXCEPT `audio` is unchanged — the fast, no-restart path. */
internal fun isAudioOnlyProfileDiff(previous: ProfileV1, next: ProfileV1): Boolean =
    previous.copy(audio = next.audio) == next

/** Build the minimal live-preference patch: only fields that actually changed are non-null. */
internal fun diffToAudioPatch(previous: ProfileV1, next: ProfileV1): AudioPreferencesPatch =
    AudioPreferencesPatch(
        ttsEnabled = next.audio.ttsEnabled.takeIf { it != previous.audio.ttsEnabled },
        channel = next.audio.channel.takeIf { it != previous.audio.channel },
    )

private fun ApplyState.label(): String = when (this) {
    ApplyState.Idle -> "idle"
    ApplyState.Saving -> "saving"
    ApplyState.Restarting -> "restarting"
    is ApplyState.Ready -> "ready"
    ApplyState.AlreadyApplying -> "already-applying"
    is ApplyState.Failed -> "failed"
}

private fun ProfileMutation.label(): String = when (this) {
    is ProfileMutation.PutProfile -> "put-profile"
    is ProfileMutation.PutSoul -> "put-soul"
    is ProfileMutation.PutMemory -> "put-memory"
    is ProfileMutation.CreatePersonality -> "personality-create"
    is ProfileMutation.UpdatePersonality -> "personality-update"
    is ProfileMutation.DeletePersonality -> "personality-delete"
    is ProfileMutation.ActivatePersonality -> "personality-activate"
}
