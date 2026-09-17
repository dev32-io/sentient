package io.sentient.mobiledata.usecase.push

import io.sentient.mobiledata.data.push.PushRepository
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.push.*
import io.sentient.mobilesdk.result.SentientError
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.*

class PushSettingsUseCasesTest {
    @Test fun `reload hides stale values and load errors can be retried`() = runTest {
        val repo = FakePushRepository()
        val useCases = PushSettingsUseCases(repo)
        repo.get = { SentientResult.Success(binding(revision = 1)) }
        useCases.load("installation")

        val release = CompletableDeferred<Unit>()
        repo.get = {
            release.await()
            SentientResult.Failure(SentientError.Connection("load failed"))
        }
        val failedLoad = async { useCases.load("installation") }
        runCurrent()
        assertNull(assertIs<SentientResult.Loading<PushBinding>>(useCases.binding.value).partial)
        release.complete(Unit)
        assertIs<SentientResult.Failure>(failedLoad.await())

        repo.get = { SentientResult.Success(binding(revision = 2, preview = PushPreviewMode.CONTENT)) }
        assertEquals(2, assertIs<SentientResult.Success<PushBinding>>(useCases.load("installation")).data.preferences.revision)
        assertEquals(PushPreviewMode.CONTENT, assertIs<SentientResult.Success<PushBinding>>(useCases.binding.value).data.preferences.previewMode)
    }

    @Test fun `delayed load wins over stale registration snapshot before save`() = runTest {
        val repo = FakePushRepository()
        val useCases = PushSettingsUseCases(repo)
        val release = CompletableDeferred<Unit>()
        repo.get = { release.await(); SentientResult.Success(binding(revision = 2)) }
        repo.patch = { request -> SentientResult.Success(binding(revision = request.expectedRevision + 1, preview = PushPreviewMode.CONTENT)) }

        val load = launch { useCases.load("installation") }
        runCurrent()
        val save = launch { useCases.setPreview(binding(revision = 1), PushPreviewMode.CONTENT) }
        runCurrent()
        assertTrue(repo.patchRequests.isEmpty())

        release.complete(Unit)
        load.join(); save.join()
        assertEquals(2, repo.patchRequests.single().expectedRevision)
        assertEquals(3, assertIs<SentientResult.Success<PushBinding>>(useCases.binding.value).data.preferences.revision)
    }

    @Test fun `rapid mutations serialize against latest acknowledged revision`() = runTest {
        val repo = FakePushRepository()
        val useCases = PushSettingsUseCases(repo)
        repo.get = { SentientResult.Success(binding(revision = 2)) }
        repo.patch = { request ->
            SentientResult.Success(binding(
                revision = request.expectedRevision + 1,
                enabled = request.changes.enabled ?: true,
                preview = request.changes.previewMode ?: PushPreviewMode.HIDDEN,
            ))
        }
        useCases.load("installation")
        val stale = binding(revision = 2)

        val first = launch { useCases.setEnabled(stale, false) }
        val second = launch { useCases.setPreview(stale, PushPreviewMode.CONTENT) }
        first.join(); second.join()

        assertEquals(listOf(2, 3), repo.patchRequests.map { it.expectedRevision })
        assertEquals(4, assertIs<SentientResult.Success<PushBinding>>(useCases.binding.value).data.preferences.revision)
    }

    @Test fun `conflict publishes refreshed binding and retry uses refreshed revision`() = runTest {
        val repo = FakePushRepository()
        val useCases = PushSettingsUseCases(repo)
        var getCalls = 0
        repo.get = {
            getCalls++
            SentientResult.Success(if (getCalls == 1) binding(revision = 2) else binding(revision = 3))
        }
        var patchCalls = 0
        repo.patch = { request ->
            patchCalls++
            if (patchCalls == 1) SentientResult.Failure(SentientError.Protocol("conflict"))
            else SentientResult.Success(binding(revision = request.expectedRevision + 1, preview = PushPreviewMode.CONTENT))
        }
        useCases.load("installation")

        assertIs<SentientResult.Failure>(useCases.setPreview(binding(revision = 2), PushPreviewMode.CONTENT))
        assertEquals(3, assertIs<SentientResult.Success<PushBinding>>(useCases.binding.value).data.preferences.revision)
        assertIs<SentientResult.Success<PushBinding>>(useCases.setPreview(binding(revision = 2), PushPreviewMode.CONTENT))
        assertEquals(listOf(2, 3), repo.patchRequests.map { it.expectedRevision })
    }

    @Test fun `save and reconciliation failure removes stale values until reload`() = runTest {
        val repo = FakePushRepository()
        val useCases = PushSettingsUseCases(repo)
        repo.get = { SentientResult.Success(binding(revision = 2)) }
        useCases.load("installation")
        repo.patch = { SentientResult.Failure(SentientError.Connection("save failed")) }
        repo.get = { SentientResult.Failure(SentientError.Connection("reload failed")) }

        assertIs<SentientResult.Failure>(useCases.setEnabled(binding(revision = 2), false))
        assertIs<SentientResult.Failure>(useCases.binding.value)

        repo.get = { SentientResult.Success(binding(revision = 2)) }
        assertIs<SentientResult.Success<PushBinding>>(useCases.load("installation"))
    }
}

private class FakePushRepository : PushRepository {
    var get: suspend (String) -> SentientResult<PushBinding> = { error("get not configured") }
    var patch: suspend (PushPreferencePatchRequest) -> SentientResult<PushBinding> = { error("patch not configured") }
    val patchRequests = mutableListOf<PushPreferencePatchRequest>()

    override suspend fun register(request: PushRegistrationRequest): SentientResult<PushRegistrationResponse> = error("unused")
    override suspend fun get(installationId: String) = get.invoke(installationId)
    override suspend fun patch(request: PushPreferencePatchRequest): SentientResult<PushBinding> {
        patchRequests += request
        return patch.invoke(request)
    }
}

private fun binding(
    revision: Int,
    enabled: Boolean = true,
    preview: PushPreviewMode = PushPreviewMode.HIDDEN,
) = PushBinding(
    bindingId = "binding",
    installationId = "installation",
    platform = "ios",
    generation = 1,
    state = PushBindingState.ACTIVE,
    preferences = PushPreferences(enabled, preview, revision),
    createdAt = "2026-01-01T00:00:00Z",
    updatedAt = "2026-01-01T00:00:00Z",
)
