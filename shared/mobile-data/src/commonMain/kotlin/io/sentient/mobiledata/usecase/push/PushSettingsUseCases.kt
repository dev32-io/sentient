package io.sentient.mobiledata.usecase.push

import io.sentient.mobiledata.data.push.PushRepository
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.push.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class PushSettingsUseCases(private val repository: PushRepository) {
    private val _binding = MutableStateFlow<SentientResult<PushBinding>>(SentientResult.Loading())
    val binding: StateFlow<SentientResult<PushBinding>> = _binding.asStateFlow()

    suspend fun load(installationId: String): SentientResult<PushBinding> =
        repository.get(installationId).also { _binding.value = it }
    suspend fun register(request: PushRegistrationRequest): SentientResult<PushRegistrationResponse> =
        repository.register(request).also { result -> if (result is SentientResult.Success) _binding.value = SentientResult.Success(result.data.binding) }
    suspend fun setEnabled(binding: PushBinding, enabled: Boolean) = patch(binding, PushPreferenceChanges(enabled = enabled))
    suspend fun setPreview(binding: PushBinding, mode: PushPreviewMode) = patch(binding, PushPreferenceChanges(previewMode = mode))
    suspend fun patch(binding: PushBinding, changes: PushPreferenceChanges): SentientResult<PushBinding> {
        val prior = _binding.value
        val result = repository.patch(PushPreferencePatchRequest(binding.bindingId, binding.generation, binding.preferences.revision, changes))
        _binding.value = if (result is SentientResult.Success) result else prior
        // Always reload after a rejected optimistic revision; the returned failure remains truthful.
        if (result is SentientResult.Failure) load(binding.installationId)
        return result
    }
    fun close() { _binding.value = SentientResult.Loading() }
}
