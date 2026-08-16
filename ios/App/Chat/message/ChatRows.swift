// ChatRows — fold messages into a render list with day dividers (webui .day-divider).
// A divider precedes the first message of each calendar day; label = day name + first ts.
import Foundation
import MobileData

enum ChatRow: Identifiable {
    case divider(label: String, id: String)
    case message(ChatMessage, index: Int)
    var id: String {
        switch self {
        case let .divider(_, id): return "div-\(id)"
        case let .message(m, i): return Self.messageRowId(m, index: i)
        }
    }

    // Stable per-message identity — ONE row per logical BUBBLE across its whole
    // lifecycle. Keyed on replyId FIRST, not turnId: a mid-turn steer rotates
    // replyId, so one turnId can own TWO assistant bubbles (reply 1 answers the
    // first message, reply 2 answers the steer). Keying on turnId aliases both
    // replies onto the same row id — a duplicate Identifiable id in this ForEach,
    // which SwiftUI/LazyVStack shows as a bogus move animation right after the
    // steer and as vanish/reappear on scroll (recycle-by-id).
    //
    // The live streaming bubble and its committed twin still share replyId
    // (ObserveChatUseCase builds the live bubble with replyId = it.replyId), so
    // the streaming→committed handoff is still the SAME SwiftUI row (no remount,
    // no flash). replyId is constant across tokens same as turnId was, so unlike
    // ts it never churns mid-reveal.
    //
    // Entries with no replyId (user rows, REST history) key by their stable
    // gateway entryId. turnId is a fallback only for a gateway that does not
    // stamp replyId. Index is the last resort.
    private static func messageRowId(_ m: ChatMessage, index: Int) -> String {
        // Optimistic and committed user echoes share the pendingId identity.
        if m.role == "user", let pendingId = m.pendingId, !pendingId.isEmpty {
            return "send-\(pendingId)"
        }
        if let replyId = m.replyId, !replyId.isEmpty { return "reply-\(replyId)" }
        if !m.entryId.isEmpty { return "ent-\(m.entryId)" }
        if let turnId = m.turnId, !turnId.isEmpty { return "turn-\(turnId)" }
        return "idx-\(index)"
    }
}

func chatRows(_ messages: [ChatMessage], calendar: Calendar = .current,
              now: Date = Date()) -> [ChatRow] {
    var rows: [ChatRow] = []
    var lastDay: DateComponents?
    for (i, m) in messages.enumerated() {
        // Streaming messages have ts=0 (no real timestamp while in flight).
        // Never bucket them into a day-divider — ts=0/epoch would produce a
        // bogus "WEDNESDAY · 4:00 PM" separator. Skip the divider entirely;
        // the committed entry that follows will carry the real ts and divider.
        if !m.streaming {
            let date = Date(timeIntervalSince1970: Double(m.ts) / 1000)
            let day = calendar.dateComponents([.year, .month, .day], from: date)
            if day != lastDay {
                // Day-component key (not the first-message index) so divider identity is
                // stable even if history is ever prepended (load-earlier paging).
                let dayKey = "\(day.year ?? 0)-\(day.month ?? 0)-\(day.day ?? 0)"
                rows.append(.divider(label: dividerLabel(date, calendar: calendar, now: now),
                                     id: dayKey))
                lastDay = day
            }
        }
        rows.append(.message(m, index: i))
    }
    return rows
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
