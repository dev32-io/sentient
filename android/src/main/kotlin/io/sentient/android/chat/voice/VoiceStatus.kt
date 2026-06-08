// ---------------------------------------------------------------------------
// VoiceStatus — avatar animation mode enum. The live derivation path uses
// markModeOfConnection (ChatContentBanners.kt), which maps ConnectionState →
// MarkMode. The legacy markModeOf(SdkState) overload was removed with
// the old chat surface (dead code cleanup).
// ---------------------------------------------------------------------------
package io.sentient.android.chat.voice

/**
 * The four avatar animation modes, mirroring the webui SentientMarkMode union.
 * Each maps to exactly one animation (or none, for [IDLE]).
 */
enum class MarkMode { IDLE, LISTENING, THINKING, SPEAKING }
