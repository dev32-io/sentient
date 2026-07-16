// ---------------------------------------------------------------------------
// MemoryViewModel — Memory settings page. Two slots (MEMORY.md / USER.md), each
// lazily fetched the first time it is viewed. SLOW save: each slot's PUT is
// restart-on-write (PutMemory), so Save runs one FSM per dirty slot in sequence and
// refetches server truth after each Ready. Holds per-slot `originals` (server docs,
// carrying `charLimit`) + `drafts`; dirty is derived per slot.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.memory

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.mobiledata.di.SettingsComponent
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobiledata.usecase.settings.ApplyState
import io.sentient.mobiledata.usecase.settings.ProfileMutation
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.settings.MemoryDoc
import io.sentient.mobilesdk.settings.MemorySlot
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Memory page state. Per-slot server docs + editor drafts, keyed by [MemorySlot]. */
data class MemoryUiState(
    val slot: MemorySlot = MemorySlot.MEMORY,
    val originals: Map<MemorySlot, MemoryDoc> = emptyMap(),
    val drafts: Map<MemorySlot, String> = emptyMap(),
    val loadingSlot: Boolean = false,
    val loadError: String? = null,
    val saving: Boolean = false,
    val restarting: Boolean = false,
    val alreadyApplying: Boolean = false,
    val applyError: String? = null,
) {
    val currentDraft: String? get() = drafts[slot]
    val charLimit: Int? get() = originals[slot]?.charLimit
    val applyActive: Boolean get() = saving || restarting

    fun isDirty(target: MemorySlot): Boolean {
        val original = originals[target] ?: return false
        val draft = drafts[target] ?: return false
        return draft != original.content
    }

    val dirty: Boolean get() = MemorySlot.entries.any { isDirty(it) }
}

class MemoryViewModel(private val component: SettingsComponent) : ViewModel() {
    private val log = createLogger("android", "settings", "memory-vm")

    private val _ui = MutableStateFlow(MemoryUiState())
    val ui: StateFlow<MemoryUiState> = _ui.asStateFlow()

    init {
        fetch(MemorySlot.MEMORY)
    }

    fun selectSlot(slot: MemorySlot) {
        _ui.update { it.copy(slot = slot, applyError = null, alreadyApplying = false) }
        if (_ui.value.originals[slot] == null) fetch(slot)
    }

    fun setDraft(content: String) {
        _ui.update { s ->
            s.copy(drafts = s.drafts + (s.slot to content), applyError = null, alreadyApplying = false)
        }
    }

    private fun fetch(slot: MemorySlot) {
        viewModelScope.launch {
            _ui.update { it.copy(loadingSlot = true, loadError = null) }
            when (val r = component.profileRepository.getMemory(slot)) {
                is SentientResult.Success -> _ui.update {
                    it.copy(
                        loadingSlot = false,
                        originals = it.originals + (slot to r.data),
                        drafts = it.drafts + (slot to r.data.content),
                    )
                }
                is SentientResult.Failure -> {
                    log.warn("fetch.failed", mapOf("slot" to slot.slug, "kind" to r.error.kind))
                    _ui.update { it.copy(loadingSlot = false, loadError = r.error.userMessage) }
                }
                is SentientResult.Loading -> Unit
            }
        }
    }

    /** Save every dirty slot in sequence — each PUT restarts; stop on the first non-Ready. */
    fun save() {
        val state = _ui.value
        val dirtySlots = MemorySlot.entries.filter { state.isDirty(it) }
        if (dirtySlots.isEmpty() || state.applyActive) return
        log.info("save", mapOf("slots" to dirtySlots.map { it.slug }))
        viewModelScope.launch {
            for (slot in dirtySlots) {
                val content = _ui.value.drafts[slot] ?: continue
                var terminal = false
                component.applyProfileChange(ProfileMutation.PutMemory(slot, content)).collect { st ->
                    _ui.update { it.foldApply(st) }
                    when (st) {
                        is ApplyState.Ready -> refetch(slot)
                        ApplyState.AlreadyApplying, is ApplyState.Failed -> terminal = true
                        else -> Unit
                    }
                }
                if (terminal) break
            }
        }
    }

    private suspend fun refetch(slot: MemorySlot) {
        when (val r = component.profileRepository.getMemory(slot)) {
            is SentientResult.Success -> _ui.update {
                it.copy(originals = it.originals + (slot to r.data), drafts = it.drafts + (slot to r.data.content))
            }
            is SentientResult.Failure -> log.warn("refetch.failed", mapOf("kind" to r.error.kind))
            is SentientResult.Loading -> Unit
        }
    }
}

/** Fold one FSM transition into flat progress fields. */
internal fun MemoryUiState.foldApply(state: ApplyState): MemoryUiState = when (state) {
    ApplyState.Saving -> copy(saving = true, restarting = false, alreadyApplying = false, applyError = null)
    ApplyState.Restarting -> copy(saving = false, restarting = true)
    is ApplyState.Ready -> copy(saving = false, restarting = false, alreadyApplying = false, applyError = null)
    ApplyState.AlreadyApplying -> copy(saving = false, restarting = false, alreadyApplying = true)
    is ApplyState.Failed -> copy(saving = false, restarting = false, applyError = state.error.userMessage)
    ApplyState.Idle -> this
}
