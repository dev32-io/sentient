// ---------------------------------------------------------------------------
// VoiceStatus — pure mapping from the SDK's voice fields to a SentientMark
// animation mode, mirroring the Android markModeOf (android/.../chat/
// VoiceStatus.kt) and gateway/webui/src/hooks/voice-status.ts (buildVoiceStatus)
// + app.tsx's activeCycleMode/topbarMarkMode derivation.
//
// Precedence (identical to buildVoiceStatus): assistant audio playing wins,
// then server cognition (thinking/acting → processing), then mic-open
// (listening), else idle. CRITICAL — this is the only place the avatar's
// animation state is decided, and .idle maps to NO animation (the
// event-driven-UX rule: "constant by default is a bug").
// ---------------------------------------------------------------------------
import MobileData

/// The four avatar animation modes, mirroring the webui SentientMarkMode union
/// and the Android MarkMode enum. Each maps to exactly one animation (or none,
/// for `.idle`).
enum MarkMode {
    case idle
    case listening
    case thinking
    case speaking
}

/// Derives the avatar animation mode from the single SDK surface. Pure — every
/// mode traces to an SDK-emitted field, so the animation is event-driven and
/// stops the instant its driving state leaves. `.idle` ⇒ no animation.
func markMode(of state: SdkState) -> MarkMode {
    let speaking = state.isSpeaking || state.audioState == .assistantSpeaking
    if speaking { return .speaking }
    let thinking = state.cognition != .idle || state.audioState == .processing
    if thinking { return .thinking }
    let listening = state.audioState == .listening || state.audioState == .userSpeaking
    if listening { return .listening }
    return .idle
}

/// Derives the avatar animation mode from a ConnectionState (chat-scoped session
/// path). Analogous to `markModeOfConnection` in Android ChatContentBanners.
/// ConnectionState carries audioState + isSpeaking but NOT cognition, so the
/// thinking path maps to audioState.processing only (mirrors Android).
func markModeOfConnection(_ connection: ConnectionState) -> MarkMode {
    let speaking = connection.isSpeaking || connection.audioState == .assistantSpeaking
    if speaking { return .speaking }
    let thinking = connection.audioState == .processing
    if thinking { return .thinking }
    let listening = connection.audioState == .listening || connection.audioState == .userSpeaking
    if listening { return .listening }
    return .idle
}
