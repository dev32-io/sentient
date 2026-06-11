// ---------------------------------------------------------------------------
// RelativeTime — date-group + compact relative-time labels for session rows.
//
// Mirrors the Android history/RelativeTime.kt exactly: date-bucket grouping
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
    private static let weekDays: Int64 = 7

    /// True when a timestamp is the unknown sentinel (0) or otherwise non-positive.
    static func isUnknown(_ ms: Int64) -> Bool { ms <= 0 }

    /// Date-bucket label for the list group header. Matches Android dateGroupLabel.
    static func dateGroupLabel(nowMs: Int64, lastActiveMs: Int64) -> String {
        if isUnknown(lastActiveMs) { return unknown }
        let today = nowMs / dayMs
        let day = lastActiveMs / dayMs
        switch true {
        case day == today: return "Today"
        case day == today - 1: return "Yesterday"
        case today - day < weekDays: return "Last 7 days"
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
