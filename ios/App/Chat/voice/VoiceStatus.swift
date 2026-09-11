import MobileData

/// Derives the identity from assistant activity only. Capture/listening never
/// changes the identity; those semantics stay with the native composer.
func identityState(
    for connection: ConnectionState,
    hasStreamingAssistantText: Bool = false
) -> SentientIdentityState {
    if hasStreamingAssistantText || connection.isSpeaking || connection.audioState == .assistantSpeaking {
        return .responding
    }
    if connection.cognition == .thinking
        || connection.cognition == .acting
        || connection.audioState == .processing {
        return .thinking
    }
    return .idle
}
