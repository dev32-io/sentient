import Foundation
import MobileData

/// The control to return VoiceOver/keyboard focus to after an overlay closes.
enum CalendarOverlayOrigin: Hashable {
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
    static let actionHeight: CGFloat = 48
    static let headerDisplaySize: CGFloat = 29
    static let metadataLabelWidth: CGFloat = 82
    static let noticeBackgroundOpacity = 0.10
    static let pressedScale = 0.97
    static let normalScale = 1.0

    static func isOpen(_ state: CalendarUiState) -> Bool { isOpen(state.mutation) }

    static func isOpen(_ mutation: CalendarMutationState) -> Bool {
        mutation.preview != nil || mutation.editor != nil || mutation.deleteConfirmation != nil ||
            mutation.conflict != nil || mutation.outcome != nil
    }

    static func allowsInteractiveDismiss(_ state: CalendarUiState) -> Bool {
        if state.outcome != nil || state.conflict != nil || state.deleteConfirmation != nil { return false }
        if state.editor != nil { return !state.mutation.isSubmitting }
        return state.preview != nil
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

    static func recurrenceSummary(
        _ recurrence: StructuredRecurrence?,
        locale: Locale = .current,
        timeZone: TimeZone = .current
    ) -> String? {
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
        if let until = recurrence.until {
            let displayUntil = CalendarOverlayDateCodec.displayRecurrenceUntil(
                until, locale: locale, fallbackTimeZone: timeZone
            )
            summary += ", until \(displayUntil)"
        }
        return summary
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
