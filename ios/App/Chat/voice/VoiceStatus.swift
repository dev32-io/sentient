// ---------------------------------------------------------------------------
// VoiceStatus — avatar animation mode enum + live derivation from ConnectionState.
// The legacy markMode(of: SdkState) overload was removed with the SdkState
// aggregate (dead code cleanup). The live path is markModeOfConnection(_:).
//
// Precedence: assistant audio playing wins, then server cognition axis
// (connection.cognition == THINKING/ACTING || audioState.processing), then
// mic-open (listening), else idle. CRITICAL — this is the only place the
// avatar's animation state is decided, and .idle maps to NO animation
// (event-driven-UX rule: "constant by default is a bug").
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

/// Derives the avatar animation mode from a ConnectionState (chat-scoped session
/// path). Analogous to `markModeOfConnection` in Android ChatContentBanners.
/// Precedence: speaking wins, then cognition axis (thinking/acting OR
/// audioState.processing — covers both voice and text-only cycles), then listening.
func markModeOfConnection(_ connection: ConnectionState) -> MarkMode {
    let speaking = connection.isSpeaking || connection.audioState == .assistantSpeaking
    if speaking { return .speaking }
    // Cognition axis: THINKING/ACTING fires the avatar ring on text responses that
    // carry no voice signal (audioState stays .inactive). audioState.processing
    // covers voice-path cycles. Either path → .thinking ring.
    let thinking = connection.cognition == .thinking
        || connection.cognition == .acting
        || connection.audioState == .processing
    if thinking { return .thinking }
    let listening = connection.audioState == .listening || connection.audioState == .userSpeaking
    if listening { return .listening }
    return .idle
}
