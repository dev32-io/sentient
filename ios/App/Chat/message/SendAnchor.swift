import Foundation

/// Pure one-shot reducer for outbound row viewport anchoring.
struct SendAnchorState: Equatable {
    var observed: Set<String> = []
}

func reduceSendAnchor(_ state: SendAnchorState, identities: Set<String>) -> (SendAnchorState, String?) {
    let next = identities.first { !state.observed.contains($0) }
    return (SendAnchorState(observed: state.observed.union(identities)), next)
}

func sendAnchorIdentity(_ pendingId: String) -> String { "send-\(pendingId)" }
