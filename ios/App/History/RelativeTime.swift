// ---------------------------------------------------------------------------
// RelativeTime — date-group + compact relative-time labels for session rows.
//
// Local-calendar date-bucket grouping
// (Today / Yesterday / Last 7 days / Older) plus a compact per-row relative
// label ("2h ago", "3d ago") for the row's secondary line. Pure functions over
// epoch-ms; no platform clock import — keeping them pure makes them trivially
// testable and matches the webui logic.
//
// Graceful degradation: a row whose ts is the unknown sentinel (0 / non-positive)
// renders "-" rather than an epoch date or a nonsense "55 years ago" — defense
// against a Hermes getMessages gap or a malformed gateway frame.
// ---------------------------------------------------------------------------
import Foundation

enum RelativeTime {
    /// Label for a missing/invalid timestamp (the unknown sentinel).
    static let unknown = "-"

    private static let dayMs: Int64 = 86_400_000
    private static let hourMs: Int64 = 3_600_000
    private static let minuteMs: Int64 = 60_000

    /// True when a timestamp is the unknown sentinel (0) or otherwise non-positive.
    static func isUnknown(_ ms: Int64) -> Bool { ms <= 0 }

    /// Local calendar days, not elapsed 24-hour intervals (DST days vary).
    static func dateGroupLabel(nowMs: Int64, lastActiveMs: Int64, calendar: Calendar = .current) -> String {
        if isUnknown(lastActiveMs) { return unknown }
        let today = calendar.startOfDay(for: Date(timeIntervalSince1970: Double(nowMs) / 1_000))
        let day = calendar.startOfDay(for: Date(timeIntervalSince1970: Double(lastActiveMs) / 1_000))
        let days = calendar.dateComponents([.day], from: day, to: today).day ?? 0
        switch days {
        case ...0: return "Today"
        case 1: return "Yesterday"
        case 2..<7: return "Last 7 days"
        default: return "Older"
        }
    }

    /// Compact "x ago" label for a row's secondary line.
    static func relative(nowMs: Int64, lastActiveMs: Int64) -> String {
        if isUnknown(lastActiveMs) { return unknown }
        let delta = max(nowMs - lastActiveMs, 0)
        switch true {
        case delta < minuteMs: return "just now"
        case delta < hourMs: return "\(delta / minuteMs)m ago"
        case delta < dayMs: return "\(delta / hourMs)h ago"
        default: return "\(delta / dayMs)d ago"
        }
    }
}
