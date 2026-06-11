import MobileData

// Compile-only SKIE smoke: SdkEvent must bridge to an exhaustive Swift enum
// (no `default:` needed). Wired into the iOS app target in Phase 4.
func describeSdkEvent(_ e: SdkEvent) -> String {
    switch onEnum(of: e) {
    case .messageStarted(let s): return "start \(s.cycleId)"
    case .messageDelta(let d): return "delta \(d.chunk)"
    case .messageCommitted: return "commit"
    case .taskUpserted: return "task"
    case .transcriptUpdated: return "transcript"
    case .cycleDone: return "done"
    case .cycleAborted: return "aborted"
    case .sessionSwitched: return "switched"
    case .protocolError: return "error"
    case .reopenFailed: return "reopenFailed"
    }
}
