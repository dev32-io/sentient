import MobileData

// Compile-only SKIE smoke: generic SentientResult<out T : Any> must bridge to an
// exhaustive Swift enum via SKIE — verifies §14 risk from the KMP design spec.
// SentientResultFailure carries no generic (Failure : SentientResult<Nothing>) so
// the switch is over an erased SentientResult<ChatModel>; all three cases are
// reachable and the switch is exhaustive (no `default:` needed).
func describeResult(_ r: SentientResult<ChatModel>) -> String {
    switch onEnum(of: r) {
    case .loading(let l): return "loading partial=\(l.partial != nil)"
    case .success(let s): return "success \(s.data.committed.count)"
    case .failure(let f): return "failure \(f.error.userMessage)"
    }
}
