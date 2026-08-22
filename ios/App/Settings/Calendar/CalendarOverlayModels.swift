import Foundation
import MobileData

/// The control to return VoiceOver/keyboard focus to after an overlay closes.
enum CalendarOverlayOrigin: Equatable {
    case addControl
    case event(String)
}

/// Leaf views receive values and closures, never a repository or view model.
struct CalendarOverlayActions {
    let edit: (EffectiveOccurrence) -> Void
    let updateDraft: (CalendarMutationDraft) -> Void
    let chooseScope: (CalendarMutationScope) -> Void
    let save: (CalendarMutationDraft) -> Void
    let requestDelete: () -> Void
    let confirmDelete: (CalendarMutationScope?) -> Void
    let rereadConflict: () -> Void
    let reviewConflict: (CalendarMutationDraft) -> Void
    let close: () -> Void
    let acknowledgeOutcome: () -> Void
    let restoreFocus: (CalendarOverlayOrigin) -> Void
}

/// Stable presentation rules are kept outside SwiftUI bodies so they can be tested directly.
enum CalendarOverlaySemantics {
    static let maximumHeightFraction = 0.84
    static let topRadius: CGFloat = 26
    static let handleSize = CGSize(width: 42, height: 4)
    static let actionHeight: CGFloat = 48

    static func isOpen(_ state: CalendarUiState) -> Bool { isOpen(state.mutation) }

    static func isOpen(_ mutation: CalendarMutationState) -> Bool {
        mutation.preview != nil || mutation.editor != nil || mutation.deleteConfirmation != nil ||
            mutation.conflict != nil || mutation.outcome != nil
    }

    static func canSave(_ state: CalendarUiState, draft: CalendarMutationDraft) -> Bool {
        guard let editor = state.editor else { return false }
        return canSave(
            editor: editor,
            isOffline: state.isOffline,
            canCreate: state.mutationAvailability.canCreate,
            canEdit: state.mutationAvailability.canEdit,
            isSubmitting: state.mutation.isSubmitting,
            draft: draft
        )
    }

    static func canSave(editor: CalendarMutationEditorState, isOffline: Bool,
                        canCreate: Bool, canEdit: Bool, isSubmitting: Bool,
                        draft: CalendarMutationDraft) -> Bool {
        let modeAllowed = editor.isCreate ? canCreate : canEdit
        return !isOffline && modeAllowed && !isSubmitting &&
            CalendarMutationDraftValidation.shared.isValid(editor: editor, draft: draft)
    }

    static func canDelete(_ state: CalendarUiState) -> Bool {
        !state.isOffline && state.mutationAvailability.canDelete && !state.mutation.isSubmitting
    }

    static func scopeLabel(_ scope: CalendarMutationScope) -> String {
        switch scope {
        case .thisOccurrence: "This occurrence"
        case .thisAndFollowing: "This and following"
        case .entireSeries: "Entire series"
        }
    }

    static func scopeAccessibilityLabel(_ scope: CalendarMutationScope, selected: Bool) -> String {
        "\(scopeLabel(scope)), \(selected ? "selected" : "not selected")"
    }

    static func errorMessage(_ error: CalendarMutationError) -> String {
        switch error.kind {
        case .forbidden, .authorization:
            // Do not disclose event existence or fields to a forbidden caller.
            "You don’t have permission to view or change this event."
        case .connection:
            "Connect to the household gateway to save calendar changes."
        default:
            error.userMessage
        }
    }

    static func errorAccessibilityLabel(_ error: CalendarMutationError) -> String {
        "Calendar error: \(errorMessage(error))"
    }

    static func recurrenceSummary(_ recurrence: StructuredRecurrence?) -> String? {
        guard let recurrence else { return nil }
        let interval = recurrence.interval?.intValue ?? 1
        let unit: String
        switch recurrence.frequency {
        case .daily: unit = interval == 1 ? "day" : "days"
        case .weekly: unit = interval == 1 ? "week" : "weeks"
        case .monthly: unit = interval == 1 ? "month" : "months"
        case .yearly: unit = interval == 1 ? "year" : "years"
        }
        var summary = interval == 1 ? "Every \(unit)" : "Every \(interval) \(unit)"
        if let count = recurrence.count?.intValue { summary += ", \(count) times" }
        if let until = recurrence.until { summary += ", until \(until)" }
        return summary
    }
}

/// DatePicker adapter. Existing wire values remain byte-for-byte unchanged until
/// the user changes that control; changed values retain the draft's IANA zone or
/// original numeric offset rather than silently becoming UTC.
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
}

extension CalendarScope {
    var calendarDisplayName: String {
        switch self {
        case .private: "Private"
        case .household: "Household"
        case .all: "All calendars"
        }
    }
}

extension Visibility {
    var calendarDisplayName: String {
        switch self {
        case .everyone: "Everyone"
        case .adults: "Adults"
        }
    }
}

extension Importance {
    var calendarDisplayName: String {
        switch self {
        case .normal: "Normal"
        case .important: "Important"
        case .pinned: "Pinned"
        }
    }
}
