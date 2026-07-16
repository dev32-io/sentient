// ---------------------------------------------------------------------------
// ApplyProfileTypes — the input + state alphabet for [ApplyProfileChangeUseCase],
// the one real settings state machine. Kept separate from the driver so the FSM
// file stays focused on transitions.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.usecase.settings

import io.sentient.mobilesdk.result.SentientError
import io.sentient.mobilesdk.settings.MemorySlot
import io.sentient.mobilesdk.settings.ProfileV1

/**
 * A single settings mutation the FSM can execute. `PutProfile` carries [previous]
 * so the usecase can classify an audio-only diff (FAST, no restart) vs a
 * needs-restart change (SLOW). Soul / memory / personality writes always restart.
 */
sealed interface ProfileMutation {
    /** Full-profile PUT. Audio-only diff → fast path; anything else → PUT then apply. */
    data class PutProfile(val previous: ProfileV1, val next: ProfileV1) : ProfileMutation

    /** System-prompt (SOUL) write — the endpoint restarts; single call. */
    data class PutSoul(val content: String) : ProfileMutation

    /** Memory-slot write — the endpoint restarts; single call. */
    data class PutMemory(val slot: MemorySlot, val content: String) : ProfileMutation

    /** Create a personality — the endpoint restarts; single call. */
    data class CreatePersonality(val name: String, val body: String) : ProfileMutation

    /** Update a personality body — the endpoint restarts; single call. */
    data class UpdatePersonality(val name: String, val body: String) : ProfileMutation

    /** Delete a personality — the endpoint restarts; single call. */
    data class DeletePersonality(val name: String) : ProfileMutation

    /** Activate a personality — imperative 204, THEN apply to reach the running worker. */
    data class ActivatePersonality(val name: String) : ProfileMutation
}

/**
 * FSM states surfaced to the caller as a cold flow per mutation:
 *
 *   Idle → Saving → (fast) Ready
 *                 → (slow) Restarting → Ready | AlreadyApplying | Failed
 *                 → Failed        (the write itself failed; draft is preserved by the VM)
 *
 * Ready / AlreadyApplying / Failed are terminal. A failure NEVER mutates caller
 * state — the draft lives in the VM; the FSM only reports the outcome as a value.
 */
sealed interface ApplyState {
    /** Nothing running (the resting state before a mutation is dispatched). */
    data object Idle : ApplyState

    /** The write call is in flight (PUT profile / setActivePersonality). */
    data object Saving : ApplyState

    /** Blocking through the Hermes worker restart (apply, or a restart-on-write endpoint). */
    data object Restarting : ApplyState

    /** Terminal success. [elapsedMs] is the reported restart duration (0 on the fast path). */
    data class Ready(val elapsedMs: Long = 0L) : ApplyState

    /** Terminal: another apply is already running for this user (429). Surface "already applying". */
    data object AlreadyApplying : ApplyState

    /** Terminal failure carrying a user-facing error. The submitted draft is untouched. */
    data class Failed(val error: SentientError) : ApplyState
}
