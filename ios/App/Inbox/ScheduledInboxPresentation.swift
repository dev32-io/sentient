enum ScheduledInboxEmptyPresentation: Equatable {
    case none, loading, clearing, allClear
}

func scheduledInboxEmptyPresentation(
    cardCount: Int, loading: Bool, ready: Bool, pendingClear: Bool, clearFailed: Bool
) -> ScheduledInboxEmptyPresentation {
    guard cardCount == 0 else { return .none }
    if pendingClear { return .clearing }
    if loading { return .loading }
    return ready && !clearFailed ? .allClear : .none
}

