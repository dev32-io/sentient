// ---------------------------------------------------------------------------
// AdminUseCasesTest — pins the createUser template invariant that fixes the
// mobile "Add user" 422 defect: model.id must never be blank. Covers the pure
// [templateMemberProfile] mapper (keeps model/voice/audio/compression/advanced,
// resets persona + extraSystemPrompt) and the createUser wiring (profile-fetch
// failure returns the typed failure and never reaches admin.createUser).
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.usecase.settings

import io.sentient.mobiledata.data.settings.FakeAdminRepository
import io.sentient.mobiledata.data.settings.FakeProfileRepository
import io.sentient.mobiledata.data.settings.sampleProfile
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.result.SentientError
import io.sentient.mobilesdk.settings.ProfilePersona
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class AdminUseCasesTest {

    // ── pure mapper ──

    @Test
    fun `templateMemberProfile keeps model voice audio compression and advanced verbatim`() {
        val from = sampleProfile(modelId = "gpt-x", voiceId = "v-9", channel = "text", ttsEnabled = false)
        val body = templateMemberProfile(from)

        assertEquals(from.model, body.model)
        assertEquals(from.voice, body.voice)
        assertEquals(from.audio, body.audio)
        assertEquals(from.compression, body.compression)
        assertEquals(from.advanced.maxTokens, body.advanced.maxTokens)
        assertEquals(from.advanced.reasoningEffort, body.advanced.reasoningEffort)
    }

    @Test
    fun `templateMemberProfile resets persona and extraSystemPrompt to clean defaults`() {
        val from = sampleProfile().copy(
            persona = ProfilePersona(template = "Wizard", overrides = "be spooky"),
            advanced = sampleProfile().advanced.copy(extraSystemPrompt = "admin's scratch notes"),
        )
        val body = templateMemberProfile(from)

        assertEquals("default", body.persona.template)
        assertEquals("", body.persona.overrides)
        assertEquals("", body.advanced.extraSystemPrompt)
    }

    @Test
    fun `templateMemberProfile never yields a blank model id when the caller's own profile is valid`() {
        val body = templateMemberProfile(sampleProfile(modelId = "a-real-model"))
        assertTrue(body.model.id.isNotEmpty(), "a blank model.id 422s against the gateway's profileBodySchema")
    }

    // ── createUser wiring ──

    @Test
    fun `createUser success templates the request off the caller's profile`() = runTest {
        val profileRepo = FakeProfileRepository().apply {
            getProfileResult = SentientResult.Success(sampleProfile(modelId = "caller-model", voiceId = "caller-voice"))
        }
        val adminRepo = FakeAdminRepository()
        val useCase = AdminUseCases(adminRepo, profileRepo)

        val result = useCase.createUser(displayName = "Sam", pin = "1234", isAdmin = false)

        assertTrue(result is SentientResult.Success)
        val sent = assertNotNull(adminRepo.lastCreateRequest)
        assertEquals("Sam", sent.displayName)
        assertEquals("1234", sent.pin)
        assertFalse(sent.isAdmin)
        assertEquals("caller-model", sent.profile.model.id)
        assertEquals("caller-voice", sent.profile.voice.id)
        assertEquals("default", sent.profile.persona.template)
        assertEquals("", sent.profile.advanced.extraSystemPrompt)
    }

    @Test
    fun `createUser profile-fetch failure returns typed failure and never calls admin createUser`() = runTest {
        val profileRepo = FakeProfileRepository().apply {
            getProfileResult = SentientResult.Failure(SentientError.Connection("offline"))
        }
        val adminRepo = FakeAdminRepository()
        val useCase = AdminUseCases(adminRepo, profileRepo)

        val result = useCase.createUser(displayName = "Sam", pin = "1234", isAdmin = false)

        assertTrue(result is SentientResult.Failure)
        assertEquals("offline", result.error.userMessage)
        assertEquals(0, adminRepo.createUserCalls, "an empty model.id must never reach the gateway")
    }
}
