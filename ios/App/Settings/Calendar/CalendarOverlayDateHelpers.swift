import Foundation
import MobileData

/// Native DatePicker adapters keep wire values and source time-zone semantics
/// at the Calendar boundary. Existing values are only reformatted after a
/// user changes the native control.
enum CalendarOverlayDateCodec {
    static func date(from wireValue: String, allDay: Bool, timeZone: TimeZone) -> Date? {
        if allDay {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = timeZone
            let parts = wireValue.split(separator: "-").compactMap { Int($0) }
            guard parts.count == 3 else { return nil }
            return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
        }
        return ISO8601DateFormatter().date(from: wireValue)
    }

    static func wireValue(from date: Date, allDay: Bool, timeZone: TimeZone) -> String {
        if allDay {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = timeZone
            return CalendarNativeDateConversion.allDayValue(date, calendar: calendar)
        }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withColonSeparatorInTimeZone]
        formatter.timeZone = timeZone
        return formatter.string(from: date)
    }

    static func timeZone(for draft: CalendarMutationDraft) -> TimeZone {
        if let id = draft.inputTimeZoneId, let zone = TimeZone(identifier: id) { return zone }
        if let zone = numericOffsetTimeZone(in: draft.start) { return zone }
        return .current
    }

    private static func numericOffsetTimeZone(in value: String) -> TimeZone? {
        guard let match = value.range(of: #"[+-]\d{2}:\d{2}$"#, options: .regularExpression) else { return nil }
        let pieces = value[match].split(separator: ":")
        guard pieces.count == 2, let hours = Int(pieces[0]), let minutes = Int(pieces[1]) else { return nil }
        let sign = hours < 0 ? -1 : 1
        return TimeZone(secondsFromGMT: (hours * 60 + sign * minutes) * 60)
    }

    static func displayRange(start: String, end: String?) -> String {
        if let end, !end.isEmpty { return "\(start) – \(end)" }
        return start
    }
}
