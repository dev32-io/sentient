package io.sentient.mobiledata.usecase.push

import io.sentient.mobiledata.data.push.PushRepository
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.push.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class PushSettingsUseCases(private val repository: PushRepository) {
    private val operations = Mutex()
    private val _binding = MutableStateFlow<SentientResult<PushBinding>>(SentientResult.Loading())
    val binding: StateFlow<SentientResult<PushBinding>> = _binding.asStateFlow()

    suspend fun load(installationId: String): SentientResult<PushBinding> = operations.withLock {
        _binding.value = SentientResult.Loading()
        repository.get(installationId).also { _binding.value = it }
    }

    suspend fun register(request: PushRegistrationRequest): SentientResult<PushRegistrationResponse> = operations.withLock {
        repository.register(request).also { result ->
            if (result is SentientResult.Success) _binding.value = SentientResult.Success(result.data.binding)
        }
    }

    suspend fun setEnabled(binding: PushBinding, enabled: Boolean) = patch(binding, PushPreferenceChanges(enabled = enabled))
    suspend fun setPreview(binding: PushBinding, mode: PushPreviewMode) = patch(binding, PushPreferenceChanges(previewMode = mode))

    suspend fun patch(binding: PushBinding, changes: PushPreferenceChanges): SentientResult<PushBinding> = operations.withLock {
        val current = (_binding.value as? SentientResult.Success)?.data
            ?.takeIf {
                it.bindingId == binding.bindingId &&
                    it.installationId == binding.installationId &&
                    it.generation == binding.generation
            }
            ?: binding
        val result = repository.patch(PushPreferencePatchRequest(
            current.bindingId,
            current.generation,
            current.preferences.revision,
            changes,
        ))
        if (result is SentientResult.Success) {
            _binding.value = result
        } else {
            _binding.value = repository.get(current.installationId)
        }
        result
    }

    fun close() { _binding.value = SentientResult.Loading() }
}
