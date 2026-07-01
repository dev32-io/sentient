package io.sentient.mobilesdk.dev

/**
 * Debug-only fault injection for E2E. Boundary consultation points (auth/decode)
 * are wired in Phase 5 alongside the Maestro flows that exercise them.
 * Never enabled in release builds (gated by SdkConfig.devFaultsEnabled).
 */
class FaultHooks {
    private var expiredToken = false
    private var malformedNext = false

    fun armExpiredToken() { expiredToken = true }
    fun consumeExpiredToken(): Boolean = expiredToken.also { expiredToken = false }

    fun armMalformedFrame() { malformedNext = true }
    fun consumeMalformedFrame(): Boolean = malformedNext.also { malformedNext = false }
}
