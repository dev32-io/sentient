// ---------------------------------------------------------------------------
// LoadingAffordance — pure policy binding chat loading states to SDK state.
//
// chatLoading(status:cognition:hasMessages:) maps the SDK's SdkStatus and
// CognitionState to one of three observable affordances:
//   .none           → steady-state; no loading UI needed
//   .connecting     → first connect or hard reconnect (ConnectionBanner covers
//                     reconnecting/error; this fires only on fresh connect)
//   .sessionStarting → ready but the conversation history is empty; a new chat
//                     session is warming up
//
// disconnected / reconnecting / error are intentionally mapped to .none here;
// ConnectionBanner owns those affordances so they are not duplicated.
// ---------------------------------------------------------------------------
import MobileSdk

enum LoadingAffordance: Equatable {
    case none
    case connecting
    case sessionStarting
}

func chatLoading(status: SdkStatus, cognition: CognitionState, hasMessages: Bool) -> LoadingAffordance {
    switch status {
    case .connecting, .authenticating:
        return .connecting
    case .ready:
        return hasMessages ? .none : .sessionStarting
    default:
        // disconnected / reconnecting / error → ConnectionBanner owns these.
        return .none
    }
}
