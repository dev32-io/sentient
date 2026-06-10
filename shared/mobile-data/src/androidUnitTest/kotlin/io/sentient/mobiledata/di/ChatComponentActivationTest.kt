// ---------------------------------------------------------------------------
// ChatComponentActivationTest — pins the device-chat-mirror ACTIVATION (Task 4.7).
//
// KEEPER (per .claude/rules/testing.md): the wiring contract the whole 4.5/4.6
// cache depends on. The bug it guards: if ChatComponent fed the usecases the RAW
// Sdk*Repository instead of the Caching* decorator, the local DB mirror would be
// DEAD (no instant-paint-on-launch, no write-through) while still compiling. This
// asserts the VM-facing repos ARE the caching types.
//
// Builds a real SentientSdk over trivial in-test fakes (never connected — the SDK
// is constructed, not driven) + an in-memory SQLite DB, exactly the shape the
// platform owner wires in production, minus the platform actuals.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.di

import io.sentient.mobiledata.cache.db.InMemoryDatabaseDriverFactory
import io.sentient.mobiledata.data.CachingConversationRepository
import io.sentient.mobiledata.data.CachingSessionsRepository
import io.sentient.mobilesdk.sdk.PlatformBundle
import io.sentient.mobilesdk.sdk.SdkConfig
import io.sentient.mobilesdk.sdk.SentientSdk
import io.sentient.mobilesdk.secure.DeviceIdStore
import io.sentient.mobilesdk.secure.SecureTokenStore
import io.sentient.mobilesdk.transport.WebSocketEngine
import io.sentient.mobilesdk.transport.WebSocketSession
import io.sentient.mobilesdk.util.Clock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertTrue

class ChatComponentActivationTest {

    // ── Trivial in-test fakes (the SDK is constructed, never connected) ──────────
    private class NeverOpenEngine : WebSocketEngine {
        override suspend fun open(url: String, allowSelfSignedDevHost: Boolean): WebSocketSession =
            throw UnsupportedOperationException("activation test never connects")
    }

    private class InMemoryTokenStore : SecureTokenStore {
        private var token: String? = "tok"
        override fun save(token: String) { this.token = token }
        override fun load(): String? = token
        override fun clear() { token = null }
    }

    private class InMemoryDeviceIdStore : DeviceIdStore {
        private var id: String? = "dev-test"
        override fun load(): String? = id
        override fun save(id: String) { this.id = id }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private fun buildComponent(): ChatComponent {
        val sdk = SentientSdk(
            config = SdkConfig(
                gatewayWsUrl = "wss://test/api/v1/ws",
                allowSelfSignedDevHost = false,
                capabilities = listOf("text.input"),
            ),
            bundle = PlatformBundle(
                engine = NeverOpenEngine(),
                tokenStore = InMemoryTokenStore(),
                deviceIdStore = InMemoryDeviceIdStore(),
                clock = Clock { 0L },
            ),
            scope = scope,
            idleTickMs = 1_000_000_000L,
        )
        return ChatComponent(sdk = sdk, databaseDriverFactory = InMemoryDatabaseDriverFactory())
    }

    @AfterTest
    fun tearDown() = scope.cancel()

    @Test
    fun exposed_conversation_repository_is_the_caching_decorator() {
        val component = buildComponent()
        assertTrue(
            component.conversationRepository is CachingConversationRepository,
            "VM-facing conversation repo must be the Caching decorator, was ${component.conversationRepository::class.simpleName}",
        )
        component.close()
    }

    @Test
    fun exposed_sessions_repository_is_the_caching_decorator() {
        val component = buildComponent()
        assertTrue(
            component.sessionsRepository is CachingSessionsRepository,
            "VM-facing sessions repo must be the Caching decorator, was ${component.sessionsRepository::class.simpleName}",
        )
        component.close()
    }
}
