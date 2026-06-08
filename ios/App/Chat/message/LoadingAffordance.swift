// ---------------------------------------------------------------------------
// LoadingAffordance — pure policy binding chat loading states to SDK state.
//
// chatLoading(status:) maps the SDK's SdkStatus to one of two observable affordances:
//   .none           → steady-state; no loading UI needed
//   .connecting     → first connect or hard reconnect (ConnectionBanner covers
//                     reconnecting/error; this fires only on fresh connect)
//
// A READY-but-empty session is NOT a loading state — an empty chat is immediately
// typeable (the new-chat request fires silently in the background; the user only
// needs to know "I can type"). So there is no "session starting" spinner: it would
// otherwise spin forever on every empty chat. disconnected / reconnecting / error
// map to .none here too; ConnectionBanner owns those affordances.
// ---------------------------------------------------------------------------
import MobileData

enum LoadingAffordance: Equatable {
    case none
    case connecting
}

func chatLoading(status: SdkStatus) -> LoadingAffordance {
    switch status {
    case .connecting, .authenticating:
        return .connecting
    default:
        // ready (incl. empty chat) / disconnected / reconnecting / error → no spinner.
        return .none
    }
}
