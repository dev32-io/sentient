// ---------------------------------------------------------------------------
// ObserveSettingsAccessUseCaseTest — the envelope-fold edge: me must resolve to
// gate Admin; the optional services/versions read degrades to fish-hidden on
// failure without failing the whole surface.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.usecase.settings

import io.sentient.mobiledata.data.settings.FakeAccountRepository
import io.sentient.mobiledata.data.settings.FakeVoicesRepository
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.auth.AuthResponse
import io.sentient.mobilesdk.protocol.AuthUser
import io.sentient.mobilesdk.result.SentientError
import io.sentient.mobilesdk.settings.ServicesVersions
import io.sentient.mobilesdk.settings.ServicesVersionsFeatures
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ObserveSettingsAccessUseCaseTest {

    private fun useCase(account: FakeAccountRepository, voices: FakeVoicesRepository) =
        ObserveSettingsAccessUseCase(account, voices)

    @Test
    fun `combines isAdmin and fishBrowseEnabled on success`() = runTest {
        val account = FakeAccountRepository().apply {
            meResult = SentientResult.Success(AuthResponse("tok", AuthUser("u1", "Kev", isAdmin = true)))
        }
        val voices = FakeVoicesRepository().apply {
            servicesVersionsResult =
                SentientResult.Success(ServicesVersions(features = ServicesVersionsFeatures(fishBrowseEnabled = true)))
        }
        val r = useCase(account, voices).invoke()
        assertEquals(SentientResult.Success(SettingsAccess(isAdmin = true, fishBrowseEnabled = true)), r)
    }

    @Test
    fun `versions failure degrades fish to hidden but access still resolves`() = runTest {
        val account = FakeAccountRepository().apply {
            meResult = SentientResult.Success(AuthResponse("tok", AuthUser("u1", "Kev", isAdmin = true)))
        }
        val voices = FakeVoicesRepository().apply {
            servicesVersionsResult = SentientResult.Failure(SentientError.Connection("offline"))
        }
        val r = useCase(account, voices).invoke()
        assertEquals(SentientResult.Success(SettingsAccess(isAdmin = true, fishBrowseEnabled = false)), r)
    }

    @Test
    fun `me failure propagates and never reaches versions`() = runTest {
        val account = FakeAccountRepository().apply {
            meResult = SentientResult.Failure(SentientError.Auth("expired", terminal = true))
        }
        val voices = FakeVoicesRepository()
        val r = useCase(account, voices).invoke()
        assertTrue(r is SentientResult.Failure)
    }
}
