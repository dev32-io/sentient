import MobileData

/// Selects at most one row, and never lets stale speech or a new turn's global
/// cognition animate a previous reply. A null reply is only the live pre-token row.
func activeAssistantAvatar(
    in messages: [ChatMessage],
    activity: AssistantActivityState
) -> (index: Int, state: SentientIdentityState)? {
    guard activity.phase != .idle,
          let turnId = activity.turnId, !turnId.isEmpty,
          let index = messages.lastIndex(where: { $0.role == "assistant" }) else { return nil }
    let message = messages[index]
    guard message.cutoffKind == nil, message.turnId == turnId else { return nil }
    if let replyId = activity.replyId {
        guard !replyId.isEmpty, message.replyId == replyId else { return nil }
    } else {
        guard message.streaming, message.replyId == nil else { return nil }
    }
    return (index, activity.phase == .thinking ? .thinking : .responding)
}
