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
        // Index-only id — DO NOT include m.ts here. The streaming bubble's ts is stamped
        // clock.nowMs() fresh on every SDK derive (StateDeriver), so an id with ts would
        // churn SwiftUI identity each token and reset the typewriter @State to zero each frame.
        // History is append-only so existing indices are stable; the bubble is always last.
        case let .message(_, i): return "msg-\(i)"
        }
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
