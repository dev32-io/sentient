package io.sentient.mobiledata.usecase.settings

import io.sentient.mobiledata.data.settings.FakeAccountRepository
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

class AccountUseCasesTest {
    @Test
    fun logoutStartsLocalBoundaryBeforeBestEffortNetworkLogout() = runTest {
        val events = mutableListOf<String>()
        val repository = FakeAccountRepository().apply {
            beforeLogout = { events += "network" }
        }
        val useCase = AccountUseCases(repository, onLoggedOut = { events += "local" })

        useCase.logout()

        assertEquals(listOf("local", "network"), events)
    }
}
