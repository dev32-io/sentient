enum DesignApplyState: Equatable {
    case idle
    case saving
    case restarting
    case alreadyApplying
    case applied
    case failed(String)
}

extension DesignApplyState {
    var isBusy: Bool { self == .saving || self == .restarting }

    func canDiscard(isDirty: Bool) -> Bool { isDirty && !isBusy }
    func canApply(isDirty: Bool) -> Bool { isDirty && !isBusy }

    func actionTitle(isDirty: Bool) -> String {
        switch self {
        case .saving: "Saving…"
        case .restarting: "Applying…"
        case .applied where !isDirty: "Applied"
        case .failed, .alreadyApplying: "Retry"
        case .idle, .applied: "Apply changes"
        }
    }
}
