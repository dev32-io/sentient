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

    // Stable per-message identity — ONE row per logical message across its whole
    // lifecycle. The live streaming bubble and its committed twin share the
    // gateway-owned turnId, so the streaming→committed handoff is the SAME
    // SwiftUI row (no remount, no flash). turnId is constant across tokens, so
    // unlike ts it never churns mid-reveal. Entries with no turn (user, REST
    // history) key by their stable gateway entryId. Index is a last-resort
    // fallback only (every committed row carries entryId; the live bubble turnId).
    private static func messageRowId(_ m: ChatMessage, index: Int) -> String {
        if let turnId = m.turnId, !turnId.isEmpty { return "turn-\(turnId)" }
        if !m.entryId.isEmpty { return "ent-\(m.entryId)" }
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
