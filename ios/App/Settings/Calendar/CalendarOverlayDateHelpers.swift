import Foundation
import MobileData

/// A recurrence bound keeps its wire kind and original spelling alongside the
/// native Date. The source value can therefore survive unrelated editor edits
/// without losing a timed offset, fractional seconds, or all-day semantics.
struct CalendarOverlayRecurrenceUntil: Equatable {
    let wireValue: String
    let date: Date
    let allDay: Bool
}

/// Native DatePicker adapters keep wire values and source time-zone semantics
/// at the Calendar boundary. Existing values are only reformatted after a
/// user changes the native control.
enum CalendarOverlayDateCodec {
    static func date(from wireValue: String, allDay: Bool, timeZone: TimeZone) -> Date? {
        if allDay {
            guard wireValue.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else {
                return nil
            }
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = timeZone
            let parts = wireValue.split(separator: "-").compactMap { Int($0) }
            guard parts.count == 3 else { return nil }
            return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
        }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withColonSeparatorInTimeZone, .withFractionalSeconds]
        if let date = fractional.date(from: wireValue) { return date }
        let standard = ISO8601DateFormatter()
        standard.formatOptions = [.withInternetDateTime, .withColonSeparatorInTimeZone]
        return standard.date(from: wireValue)
    }

    static func recurrenceUntil(from wireValue: String, timeZone: TimeZone) -> CalendarOverlayRecurrenceUntil? {
        let allDay = wireValue.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil
        guard let date = date(from: wireValue, allDay: allDay, timeZone: timeZone) else { return nil }
        return CalendarOverlayRecurrenceUntil(wireValue: wireValue, date: date, allDay: allDay)
    }

    /// Preserve a parsed source value while the native date is unchanged. Once
    /// the user changes it, retain the source's timed/all-day kind when
    /// re-encoding in the event's editing zone.
    static func recurrenceUntilWireValue(
        source: CalendarOverlayRecurrenceUntil?,
        date: Date,
        timeZone: TimeZone
    ) -> String {
        if let source, source.date == date { return source.wireValue }
        return wireValue(from: date, allDay: source?.allDay ?? true, timeZone: timeZone)
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
