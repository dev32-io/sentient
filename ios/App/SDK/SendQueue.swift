// ---------------------------------------------------------------------------
// SendQueue — pure outbound-text queue policy (web-sdk parity).
//
// When the SDK is not yet READY, messages typed by the user are not dropped;
// they accumulate in a pending queue and are flushed in order on the first
// rising edge to READY. This mirrors the web-sdk behaviour where a send issued
// before the socket is live is queued then flushed when the socket connects.
//
// All state is a plain value type (`SendQueueState`); the two free functions
// are pure transformations so they can be tested without any SDK/I-O
// dependencies.
// ---------------------------------------------------------------------------
import Foundation

/// The persistent state of the send queue.
struct SendQueueState: Equatable {
    /// Messages buffered while the SDK is not READY, preserved in FIFO order.
    var pending: [String] = []
}

/// Called when the user submits text.
/// - Returns the updated state and the texts that should be dispatched NOW
///   (empty when queued; `[text]` when sent immediately).
func sendQueueOnSend(_ s: SendQueueState, text: String, ready: Bool) -> (SendQueueState, [String]) {
    if ready { return (s, [text]) }
    var updated = s
    updated.pending.append(text)
    return (updated, [])
}

/// Called on every SDK status transition.
/// Drains the queue only on a rising edge to READY (`!wasReady && ready`).
/// - Returns the updated state and the texts that should be dispatched NOW
///   (empty unless we just crossed into READY with a non-empty backlog).
func sendQueueOnStatus(_ s: SendQueueState, ready: Bool, wasReady: Bool) -> (SendQueueState, [String]) {
    guard ready, !wasReady, !s.pending.isEmpty else { return (s, []) }
    return (SendQueueState(), s.pending)
}
