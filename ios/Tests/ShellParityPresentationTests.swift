import Foundation
#if !S_SHELL_PURE_CHECK
import Testing
@testable import SentientApp
#endif

/// Same cases run as a host-only executable and in the native test bundle.
private func shellParityPresentationCases() -> [(Bool, String)] {
    var cases: [(Bool, String)] = []
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
    func ms(_ date: String) -> Int64 {
        Int64(ISO8601DateFormatter().date(from: date)!.timeIntervalSince1970 * 1_000)
    }
    // Same UTC date, different local dates; spring DST day has only 23 hours.
    for (now, activity, expected) in [
        ("2026-03-09T07:15:00Z", "2026-03-09T06:45:00Z", "Yesterday"),
        ("2026-03-09T07:15:00Z", "2026-03-08T08:05:00Z", "Yesterday"),
        ("2026-03-09T07:15:00Z", "2026-03-07T08:05:00Z", "Last 7 days"),
        ("2026-03-09T07:15:00Z", "2026-03-02T08:05:00Z", "Older"),
        ("2026-11-02T08:15:00Z", "2026-11-01T07:05:00Z", "Yesterday"),
        ("2026-11-01T09:15:00Z", "2026-11-01T08:15:00Z", "Today"),
        ("2026-11-01T09:15:00Z", "2026-11-03T08:15:00Z", "Today")
    ] {
        cases.append((RelativeTime.dateGroupLabel(nowMs: ms(now), lastActiveMs: ms(activity), calendar: calendar) == expected,
                      "Local day grouping: \(now) / \(activity) → \(expected)"))
    }
    cases.append((RelativeTime.dateGroupLabel(nowMs: ms("2026-03-09T07:15:00Z"), lastActiveMs: 0, calendar: calendar) == RelativeTime.unknown,
                  "Unknown timestamps must not become epoch dates"))
    for (count, loading, ready, pending, failed, expected) in [
        (0, true, false, false, false, ScheduledInboxEmptyPresentation.loading),
        (0, false, true, true, false, .clearing),
        (0, true, false, true, false, .clearing),
        (0, false, true, false, false, .allClear),
        (0, false, true, false, true, .none),
        (0, false, false, false, false, .none),
        (1, true, false, false, false, .none),
        (1, false, true, true, false, .none)
    ] {
        cases.append((scheduledInboxEmptyPresentation(cardCount: count, loading: loading, ready: ready,
                                                      pendingClear: pending, clearFailed: failed) == expected,
                      "Inbox empty state must be truthful: \(expected)"))
    }
    let suite = "S-ShellPresentation-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let profile = DisplayNameStore(defaults: defaults)
    profile.save("Disposable profile")
    profile.saveAvatarTint("sage")
    profile.save("Renamed profile")
    cases.append((profile.avatarTint == "sage", "Display-name changes must not invent or erase tint"))
    profile.clear()
    cases.append((profile.avatarTint.isEmpty && profile.load() == nil, "Logout must clear profile presentation"))
    profile.saveAvatarTint("amber")
    cases.append((profile.avatarTint == "amber", "Next authenticated response must replace tint"))
    return cases
}

#if S_SHELL_PURE_CHECK
@main private enum ShellParityCheck {
    static func main() {
        let cases = shellParityPresentationCases()
        for (passed, reason) in cases { precondition(passed, reason) }
        print("S shell presentation: \(cases.count) pure checks passed")
    }
}
#else
struct ShellParityPresentationTests {
    @Test func sLocalCalendarInboxAndProfilePresentationContracts() {
        for (passed, reason) in shellParityPresentationCases() { #expect(passed, Comment(rawValue: reason)) }
    }
}
#endif
