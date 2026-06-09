package io.sentient.mobilesdk.dev

/**
 * Debug-only fault injection for E2E. Boundary consultation points (auth/decode/mic)
 * are wired in Phase 5 alongside the Maestro flows that exercise them.
 * Never enabled in release builds (gated by SdkConfig.devFaultsEnabled).
 */
class FaultHooks {
    private var expiredToken = false
    private var malformedNext = false
    private var fixtureUtterance: ByteArray? = null

    fun armExpiredToken() { expiredToken = true }
    fun consumeExpiredToken(): Boolean = expiredToken.also { expiredToken = false }

    fun armMalformedFrame() { malformedNext = true }
    fun consumeMalformedFrame(): Boolean = malformedNext.also { malformedNext = false }

    fun loadFixtureUtterance(pcm: ByteArray) { fixtureUtterance = pcm }
    fun takeFixtureUtterance(): ByteArray? = fixtureUtterance.also { fixtureUtterance = null }
}
