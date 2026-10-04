import Foundation
import MobileData

/// Display only. Shared scheduling owns recurrence expansion and DST policy.
enum ScheduleDisplay {
    static func summary(_ schedule: Schedule, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        let cadence: String
        let zone: TimeZone
        switch onEnum(of: schedule.timing) {
        case .once:
            cadence = "One time"
            zone = timeZone
        case .recurring(let timing):
            zone = TimeZone(identifier: timing.timeZone) ?? timeZone
            let frequency: String = switch timing.frequency {
            case .daily: "Daily"
            case .weekly: "Weekly"
            case .monthly: "Monthly"
            }
            let fields = ScheduleEditorFields(absolute: "", delay: "30", recurringTime: timing.localTime,
                                              dayOfMonth: "1", timeZone: timing.timeZone)
            var draft = ScheduleDraft(mode: .recurring)
            let errors = fields.apply(to: &draft)
            let time = errors.isEmpty
                ? draft.localTime.formatted(Date.FormatStyle(locale: locale, timeZone: zone).hour().minute())
                : timing.localTime
            cadence = "\(frequency) · \(time) · \(timing.timeZone)"
        }
        let next: String
        if let wire = schedule.nextRunAt {
            if let date = (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(wire))
                ?? (try? Date.ISO8601FormatStyle().parse(wire)) {
                let formatter = DateFormatter()
                formatter.locale = locale
                formatter.timeZone = zone
                formatter.dateStyle = .medium
                formatter.timeStyle = .short
                next = "Next: \(formatter.string(from: date))"
            } else {
                next = "Next time unavailable: \(wire)"
            }
        } else {
            next = "No next run"
        }
        return "\(cadence) · \(next)"
    }

    static func localTime(_ date: Date, zone: TimeZone) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "HH:mm"
        formatter.timeZone = zone
        return formatter.string(from: date)
    }
}
