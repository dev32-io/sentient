// ---------------------------------------------------------------------------
// SessionLabel — human-readable label for a vitals session row. Swift mirror of
// Android's SessionLabel (settings/SessionLabel.kt).
//
// The newest session is "This session"; older ones get a relative day prefix
// ("Today" / "Yesterday" / a short date) plus a wall-clock time ("9:43 PM").
// Pure over epoch-ms + the session info; uses Calendar / DateFormatter in the
// device timezone so "Today" / "Yesterday" are correct near midnight.
// ---------------------------------------------------------------------------
import Foundation

enum SessionLabel {
    private static let thisSession = "This session"
    private static let unknown = "Unknown time"

    /// Label for one session row. The newest (`isNewest`) renders "This session";
    /// others render "<Today|Yesterday|MMM d> <h:mm a>", e.g. "Yesterday 2:07 PM".
    static func label(sessionStartMs: Int64, nowMs: Int64, isNewest: Bool) -> String {
        if isNewest { return thisSession }
        if sessionStartMs <= 0 { return unknown }
        let date = Date(timeIntervalSince1970: Double(sessionStartMs) / 1000)
        return "\(dayPrefix(nowMs: nowMs, ms: sessionStartMs)) \(timeFormatter.string(from: date))"
    }

    private static func dayPrefix(nowMs: Int64, ms: Int64) -> String {
        let cal = Calendar.current
        let now = Date(timeIntervalSince1970: Double(nowMs) / 1000)
        let then = Date(timeIntervalSince1970: Double(ms) / 1000)
        if cal.isDate(then, inSameDayAs: now) { return "Today" }
        if let yesterday = cal.date(byAdding: .day, value: -1, to: now),
           cal.isDate(then, inSameDayAs: yesterday) {
            return "Yesterday"
        }
        return dateFormatter.string(from: then)
    }

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.setLocalizedDateFormatFromTemplate("jm")
        return f
    }()

    private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.setLocalizedDateFormatFromTemplate("MMMd")
        return f
    }()
}
