// ---------------------------------------------------------------------------
// ChatUiState — value type representing one snapshot of the chat screen.
//
// Consumed by ChatViewModel and will be rendered by ChatView (next task).
// Mirrors the Android ChatUiState shape: last-good model on failure
// (graceful degradation), explicit loading flag, dismissible error banner.
// ---------------------------------------------------------------------------
import MobileData

/// Non-fatal error banner: shown inline when a SentientResult.failure arrives.
/// `canRetry` drives whether the banner exposes a retry affordance.
struct ErrorBanner {
    let text: String
    let canRetry: Bool
}

/// Immutable snapshot of the chat screen state, driven by ChatViewModel.
struct ChatUiState {
    /// The last successfully received chat model; defaults to empty on first load.
    var model: ChatModel = ChatModel(committed: [], live: nil, tasks: [], pending: [])
    /// True while an initial (no-prior-model) load is in flight.
    var isLoading: Bool = false
    /// Non-nil when the latest result was a failure; nil on success or loading.
    var banner: ErrorBanner? = nil
}

/// Build a DISCONNECTED placeholder ConnectionState for use before the first
/// emission from ConnectionRepository.status. All fields are their SDK defaults.
func makeDisconnectedConnection() -> ConnectionState {
    ConnectionState(
        status: .disconnected,
        hasSession: false,
        connectionLost: false,
        authExpired: false,
        prefs: AudioPreferences.companion.DEFAULT,
        voiceMode: .off,
        isSpeaking: false,
        audioState: .inactive,
        cognition: .idle
    )
}

/// Build a terminal-auth-expired ConnectionState. authExpired=true routes ChatView
/// to call onAuthExpired → onLogout, clearing the token and swapping to login.
func makeAuthExpiredConnection() -> ConnectionState {
    ConnectionState(
        status: .disconnected,
        hasSession: false,
        connectionLost: false,
        authExpired: true,
        prefs: AudioPreferences.companion.DEFAULT,
        voiceMode: .off,
        isSpeaking: false,
        audioState: .inactive,
        cognition: .idle
    )
}
