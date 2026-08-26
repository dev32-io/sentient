// ChatRows — the typed internal chronology for the chat message surface.
//
// The chronology is the single source for committed messages, optimistic
// outbox rows, and day dividers. It preserves the gateway identity contract
// while keeping pending rows after authoritative history and out of date
// grouping.
import Foundation
import MobileData

enum MessageChronologyRow: Identifiable {
    case divider(label: String, id: String)
    case message(ChatMessage, index: Int, continuation: Bool)
    case pending(PendingMessage, index: Int)

    var id: String {
        switch self {
        case let .divider(_, id): return "div-\(id)"
        case let .message(message, index, _): return messageRowId(message, index: index)
        case let .pending(message, _): return "send-\(message.id)"
        }
    }
}

/// Compatibility name for existing internal/test callers. New rendering code
/// consumes `MessageChronologyRow` through `messageChronology`.
typealias ChatRow = MessageChronologyRow

struct MessageChronology {
    let rows: [MessageChronologyRow]
    /// Number of visible message rows, excluding day dividers. This is the
    /// chronology total used by the shared accessibility label.
    let messageCount: Int
}

/// Stable per-message identity — ONE row per logical bubble across its whole
/// lifecycle. Keyed on replyId FIRST, not turnId: a mid-turn steer rotates
/// replyId, so one turnId can own TWO assistant bubbles (reply 1 answers the
/// first message, reply 2 answers the steer). Keying on turnId aliases both
/// replies onto the same row id — a duplicate Identifiable id in this ForEach,
/// which SwiftUI/LazyVStack shows as a bogus move animation right after the
/// steer and as vanish/reappear on scroll (recycle-by-id).
///
/// The live streaming bubble and its committed twin still share replyId
/// (ObserveChatUseCase builds the live bubble with replyId = it.replyId), so
/// the streaming→committed handoff is still the SAME SwiftUI row (no remount,
/// no flash). replyId is constant across tokens same as turnId was, so unlike
/// ts it never churns mid-reveal.
///
/// Entries with no replyId (user rows, REST history) key by their stable
/// gateway entryId. turnId is a fallback only for a gateway that does not
/// stamp replyId. Index is the last resort.
func messageRowId(_ message: ChatMessage, index: Int) -> String {
    // Optimistic and committed user echoes share the pendingId identity.
    if message.role == "user", let pendingId = message.pendingId, !pendingId.isEmpty {
        return "send-\(pendingId)"
    }
    if let replyId = message.replyId, !replyId.isEmpty { return "reply-\(replyId)" }
    if !message.entryId.isEmpty { return "ent-\(message.entryId)" }
    if let turnId = message.turnId, !turnId.isEmpty { return "turn-\(turnId)" }
    return "idx-\(index)"
}

/// Fold authoritative messages and transient outbox entries into the one
/// render list consumed by MessageList. Pending entries are appended after
/// committed history, receive no day divider, and never become continuations.
/// A pending entry whose committed echo is already present is omitted as a
/// boundary guard; the data layer normally filters it first, but this keeps a
/// transient echo race from rendering duplicate bubbles.
func messageChronology(
    messages: [ChatMessage],
    pending: [PendingMessage] = [],
    calendar: Calendar = .current,
    now: Date = Date()
) -> MessageChronology {
    var rows: [MessageChronologyRow] = []
    var lastDay: DateComponents?
    var previous: ChatMessage?

    for (index, message) in messages.enumerated() {
        var insertedDivider = false
        // Streaming messages have ts=0 (no real timestamp while in flight).
        // Never bucket them into a day-divider — ts=0/epoch would produce a
        // bogus separator. The committed entry that follows carries the real
        // timestamp and divider.
        if !message.streaming {
            let date = Date(timeIntervalSince1970: Double(message.ts) / 1000)
            let day = calendar.dateComponents([.year, .month, .day], from: date)
            if day != lastDay {
                let dayKey = "\(day.year ?? 0)-\(day.month ?? 0)-\(day.day ?? 0)"
                rows.append(.divider(
                    label: dividerLabel(date, calendar: calendar, now: now),
                    id: dayKey
                ))
                lastDay = day
                insertedDivider = true
            }
        }

        let continuation = !insertedDivider && previous?.role == message.role
        rows.append(.message(message, index: index, continuation: continuation))
        previous = message
    }

    let echoedPendingIds = Set(messages.compactMap { message -> String? in
        guard message.role == "user", let pendingId = message.pendingId, !pendingId.isEmpty else {
            return nil
        }
        return pendingId
    })
    let visiblePending = pending.filter { !echoedPendingIds.contains($0.id) }
    for (offset, message) in visiblePending.enumerated() {
        rows.append(.pending(message, index: messages.count + offset))
    }

    return MessageChronology(rows: rows, messageCount: messages.count + visiblePending.count)
}

/// Compatibility wrapper for the pre-encapsulation name. It delegates to the
/// single chronology implementation and intentionally has no second policy.
func chatRows(_ messages: [ChatMessage], calendar: Calendar = .current,
              now: Date = Date()) -> [ChatRow] {
    messageChronology(messages: messages, calendar: calendar, now: now).rows
}

private func dividerLabel(_ date: Date, calendar: Calendar, now: Date) -> String {
    let day: String
    if calendar.isDateInToday(date) { day = "Today" }
    else if calendar.isDateInYesterday(date) { day = "Yesterday" }
    else {
        let f = DateFormatter(); f.dateFormat = "EEEE"; day = f.string(from: date)
    }
    let t = DateFormatter(); t.timeStyle = .short; t.dateStyle = .none
    return "\(day) · \(t.string(from: date))"
}
