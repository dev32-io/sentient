#if DEBUG
import SwiftUI
import MobileData

private enum CalendarOverlayPreviewFixture {
    static let occurrence = EffectiveOccurrence(
        eventId: "preview-event", occurrenceId: "preview-occurrence",
        originalStart: "2026-04-18T09:00:00-07:00", recurring: true, revision: 4,
        scope: .household, title: "Family brunch", description: "Bring the picnic basket",
        start: "2026-04-18T10:00:00-07:00", end: "2026-04-18T11:30:00-07:00",
        visibility: .everyone, importance: .important, group: "family",
        tags: ["family", "weekend"],
        recurrence: StructuredRecurrence(frequency: .weekly, interval: 1,
                                         weekdays: [.saturday], count: 12, until: nil)
    )
    static let timedDraft = CalendarMutationDraft(
        title: "Family brunch", description: "Bring the picnic basket", allDay: false,
        start: "2026-04-18T10:00:00-07:00", end: "2026-04-18T11:30:00-07:00",
        scope: .household, visibility: .everyone, importance: .important,
        group: "family", tags: ["family", "weekend"], recurrence: occurrence.recurrence,
        eventId: occurrence.eventId, occurrenceId: occurrence.occurrenceId,
        originalStart: occurrence.originalStart, expectedRevision: 4,
        inputTimeZoneId: "America/Los_Angeles", recurring: true
    )
    static let allDayDraft = CalendarMutationDraft(
        title: "", description: nil, allDay: true, start: "2026-04-18", end: nil,
        scope: .private, visibility: .everyone, importance: .normal,
        group: nil, tags: [], recurrence: nil, eventId: nil, occurrenceId: nil,
        originalStart: nil, expectedRevision: nil,
        inputTimeZoneId: "America/Los_Angeles", recurring: false
    )
    static let allDayEditDraft = CalendarMutationDraft(
        title: "School holiday", description: "No classes", allDay: true,
        start: "2026-04-18", end: "2026-04-19", scope: .household,
        visibility: .everyone, importance: .normal, group: "school", tags: ["holiday"],
        recurrence: nil, eventId: occurrence.eventId, occurrenceId: occurrence.occurrenceId,
        originalStart: "2026-04-18", expectedRevision: 4,
        inputTimeZoneId: "America/Los_Angeles", recurring: false
    )
    static let target = CalendarMutationTarget(
        eventId: occurrence.eventId, scope: occurrence.scope,
        expectedRevision: occurrence.revision, occurrenceId: occurrence.occurrenceId,
        originalStart: occurrence.originalStart, recurring: true
    )
    static let edit = CalendarMutationEditorState(
        mode: .edit, draft: timedDraft, target: target,
        applicableScopes: CalendarMutationScope.allCases, selectedScope: .thisOccurrence
    )
    static let add = CalendarMutationEditorState(
        mode: .create, draft: allDayDraft, target: nil,
        applicableScopes: [.entireSeries], selectedScope: .entireSeries
    )
    static let allDayEdit = CalendarMutationEditorState(
        mode: .edit, draft: allDayEditDraft, target: target,
        applicableScopes: [.entireSeries], selectedScope: .entireSeries
    )
    static let error = CalendarMutationError(
        kind: .server, userMessage: "The event couldn’t be saved. Try again.",
        code: "server", status: 500, recoverable: true, requiresReread: false
    )
    static let conflictError = CalendarMutationError(
        kind: .conflict, userMessage: "This event changed while you were editing.",
        code: "stale_revision", status: 409, recoverable: true, requiresReread: true
    )
    static let permissionError = CalendarMutationError(
        kind: .forbidden, userMessage: "Hidden server detail", code: "forbidden",
        status: 403, recoverable: false, requiresReread: false
    )
    static let success: any CalendarMutationOutcome = CalendarMutationOutcomeSuccess(
        operation: .create,
        value: CalendarMutationSuccess(operation: .create, event: nil, mutation: nil,
                                       successorEventId: nil, affectedWindows: [])
    )
    static let conflict = CalendarConflictReviewState(
        operation: .update, target: target, draft: timedDraft,
        rereadInFlight: false, authoritativeEvent: nil, reviewed: false
    )
    static let deletion = CalendarDeleteConfirmationState(
        target: target, applicableScopes: CalendarMutationScope.allCases,
        selectedScope: .entireSeries
    )
}

private extension View {
    func calendarPreviewCanvas(width: CGFloat, height: CGFloat) -> some View {
        frame(width: width, height: height)
            .background(DuskColors.bg)
            .environment(\.colorScheme, .dark)
    }
}

#Preview("Event preview · 390×844") {
    CalendarPreviewSheet(
        occurrence: CalendarOverlayPreviewFixture.occurrence, locale: .current,
        canEdit: true, isOffline: false, onEdit: {}, onClose: {}
    ).calendarPreviewCanvas(width: 390, height: 844)
}

#Preview("Add all-day · 430×932") {
    CalendarEditorSheet(
        editor: CalendarOverlayPreviewFixture.add, canSave: false, canDelete: false,
        isOffline: false, isSubmitting: false, error: nil,
        onUpdate: { _ in }, onChooseScope: { _ in }, onSave: { _ in },
        onDelete: {}, onCancel: {}
    ).calendarPreviewCanvas(width: 430, height: 932)
}

#Preview("Timed edit and recurrence · 390×844") {
    CalendarEditorSheet(
        editor: CalendarOverlayPreviewFixture.edit, canSave: true, canDelete: true,
        isOffline: false, isSubmitting: false, error: nil,
        onUpdate: { _ in }, onChooseScope: { _ in }, onSave: { _ in },
        onDelete: {}, onCancel: {}
    ).calendarPreviewCanvas(width: 390, height: 844)
}

#Preview("All-day edit · 430×932") {
    CalendarEditorSheet(
        editor: CalendarOverlayPreviewFixture.allDayEdit, canSave: true, canDelete: true,
        isOffline: false, isSubmitting: false, error: nil,
        onUpdate: { _ in }, onChooseScope: { _ in }, onSave: { _ in },
        onDelete: {}, onCancel: {}
    ).calendarPreviewCanvas(width: 430, height: 932)
}

#Preview("Recurrence scope · 430×932") {
    CalendarEditorSheet(
        editor: CalendarOverlayPreviewFixture.edit, canSave: true, canDelete: true,
        isOffline: false, isSubmitting: false, error: nil,
        onUpdate: { _ in }, onChooseScope: { _ in }, onSave: { _ in },
        onDelete: {}, onCancel: {}
    ).calendarPreviewCanvas(width: 430, height: 932)
}

#Preview("Delete confirmation · 390×844") {
    CalendarDeleteSheet(
        confirmation: CalendarOverlayPreviewFixture.deletion,
        isOffline: false, isSubmitting: false, error: nil,
        onChooseScope: { _ in }, onDelete: { _ in }, onCancel: {}
    ).calendarPreviewCanvas(width: 390, height: 844)
}

#Preview("Conflict reread · 430×932") {
    CalendarConflictSheet(
        conflict: CalendarOverlayPreviewFixture.conflict,
        error: CalendarOverlayPreviewFixture.conflictError,
        onReread: {}, onReview: { _ in }, onCancel: {}
    ).calendarPreviewCanvas(width: 430, height: 932)
}

#Preview("Offline write · 390×844") {
    CalendarEditorSheet(
        editor: CalendarOverlayPreviewFixture.edit, canSave: false, canDelete: false,
        isOffline: true, isSubmitting: false, error: nil,
        onUpdate: { _ in }, onChooseScope: { _ in }, onSave: { _ in },
        onDelete: {}, onCancel: {}
    ).calendarPreviewCanvas(width: 390, height: 844)
}

#Preview("Failure · 430×932") {
    CalendarEditorSheet(
        editor: CalendarOverlayPreviewFixture.edit, canSave: true, canDelete: true,
        isOffline: false, isSubmitting: false, error: CalendarOverlayPreviewFixture.error,
        onUpdate: { _ in }, onChooseScope: { _ in }, onSave: { _ in },
        onDelete: {}, onCancel: {}
    ).calendarPreviewCanvas(width: 430, height: 932)
}

#Preview("Submitting · 390×844") {
    CalendarEditorSheet(
        editor: CalendarOverlayPreviewFixture.edit, canSave: false, canDelete: true,
        isOffline: false, isSubmitting: true, error: nil,
        onUpdate: { _ in }, onChooseScope: { _ in }, onSave: { _ in },
        onDelete: {}, onCancel: {}
    ).calendarPreviewCanvas(width: 390, height: 844)
}

#Preview("Permission · 430×932") {
    CalendarEditorSheet(
        editor: CalendarOverlayPreviewFixture.edit, canSave: false, canDelete: false,
        isOffline: false, isSubmitting: false, error: CalendarOverlayPreviewFixture.permissionError,
        onUpdate: { _ in }, onChooseScope: { _ in }, onSave: { _ in },
        onDelete: {}, onCancel: {}
    ).calendarPreviewCanvas(width: 430, height: 932)
}

#Preview("Success · 390×844") {
    CalendarOutcomeSheet(outcome: CalendarOverlayPreviewFixture.success, onClose: {})
        .calendarPreviewCanvas(width: 390, height: 844)
}

#Preview("Large Dynamic Type · 430×932") {
    CalendarPreviewSheet(
        occurrence: CalendarOverlayPreviewFixture.occurrence, locale: .current,
        canEdit: true, isOffline: false, onEdit: {}, onClose: {}
    )
    .calendarPreviewCanvas(width: 430, height: 932)
    .environment(\.dynamicTypeSize, .accessibility3)
}
#endif
