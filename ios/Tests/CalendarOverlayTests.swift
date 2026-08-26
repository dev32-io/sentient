import Foundation
import Testing
import MobileData
@testable import SentientApp

@MainActor
struct CalendarOverlayTests {
    @Test func controlledActionsForwardExactSharedIdentity() {
        let occurrence = overlayOccurrence()
        let draft = overlayDraft()
        var receivedOccurrence: EffectiveOccurrence?
        var receivedDraft: CalendarMutationDraft?
        var receivedScope: CalendarMutationScope?
        var restored: CalendarOverlayOrigin?

        let actions = CalendarOverlayActions(
            edit: { receivedOccurrence = $0 },
            updateDraft: { receivedDraft = $0 },
            chooseScope: { receivedScope = $0 },
            save: { receivedDraft = $0 },
            requestDelete: {}, confirmDelete: { receivedScope = $0 },
            rereadConflict: {}, reviewConflict: { receivedDraft = $0 },
            close: {}, acknowledgeOutcome: {}, restoreFocus: { restored = $0 }
        )

        actions.edit(occurrence)
        #expect(receivedOccurrence === occurrence)
        actions.updateDraft(draft)
        #expect(receivedDraft === draft)
        actions.chooseScope(.thisAndFollowing)
        #expect(receivedScope == .thisAndFollowing)
        actions.restoreFocus(.event("event-7/occurrence-7"))
        #expect(restored == .event("event-7/occurrence-7"))
    }

    @Test func saveEnablementUsesModeSpecificPermissionAndSharedDraftValidation() {
        let valid = overlayDraft()
        let editor = CalendarMutationEditorState(
            mode: .edit, draft: valid, target: nil,
            applicableScopes: [.entireSeries], selectedScope: .entireSeries
        )
        #expect(CalendarOverlaySemantics.canSave(editor: editor, isOffline: false,
                                                  canCreate: false, canEdit: true,
                                                  isSubmitting: false, draft: valid))
        #expect(!CalendarOverlaySemantics.canSave(editor: editor, isOffline: false,
                                                   canCreate: true, canEdit: false,
                                                   isSubmitting: false, draft: valid))
        #expect(!CalendarOverlaySemantics.canSave(editor: editor, isOffline: true,
                                                   canCreate: true, canEdit: true,
                                                   isSubmitting: false, draft: valid))
        #expect(!CalendarOverlaySemantics.canSave(editor: editor, isOffline: false,
                                                   canCreate: true, canEdit: true,
                                                   isSubmitting: true, draft: valid))
        let emptyTitle = copyOverlayDraft(valid, title: "  ")
        #expect(!CalendarOverlaySemantics.canSave(editor: editor, isOffline: false,
                                                   canCreate: true, canEdit: true,
                                                   isSubmitting: false, draft: emptyTitle))
        let missingScope = CalendarMutationEditorState(
            mode: .edit, draft: valid, target: nil,
            applicableScopes: CalendarMutationScope.allCases, selectedScope: nil
        )
        #expect(!CalendarOverlaySemantics.canSave(editor: missingScope, isOffline: false,
                                                   canCreate: true, canEdit: true,
                                                   isSubmitting: false, draft: valid))
    }

    @Test func closedMutationHasNoAccessibleOverlay() {
        let closed = CalendarMutationState(
            phase: .idle, preview: nil, editor: nil, deleteConfirmation: nil,
            pendingRequest: nil, error: nil, conflict: nil, outcome: nil,
            successorEventId: nil, affectedWindows: []
        )
        #expect(!CalendarOverlaySemantics.isOpen(closed))

        let open = closed.doCopy(
            phase: .previewing, preview: overlayOccurrence(), editor: nil,
            deleteConfirmation: nil, pendingRequest: nil, error: nil,
            conflict: nil, outcome: nil, successorEventId: nil, affectedWindows: []
        )
        #expect(CalendarOverlaySemantics.isOpen(open))
    }

    @Test func recurrenceOptionsAndAccessibleSelectionAreExplicit() {
        let scopes = CalendarMutationScope.allCases
        #expect(scopes == [.thisOccurrence, .thisAndFollowing, .entireSeries])
        #expect(CalendarOverlaySemantics.scopeLabel(.thisOccurrence) == "This occurrence")
        #expect(CalendarOverlaySemantics.scopeLabel(.thisAndFollowing) == "This and following")
        #expect(CalendarOverlaySemantics.scopeLabel(.entireSeries) == "Entire series")
        #expect(CalendarOverlaySemantics.scopeAccessibilityLabel(.thisOccurrence, selected: true)
                == "This occurrence, selected")

        let recurrence = StructuredRecurrence(
            frequency: .weekly, interval: 2, weekdays: [.monday, .friday], count: 6, until: nil
        )
        #expect(CalendarOverlaySemantics.recurrenceSummary(recurrence) == "Every 2 weeks, 6 times")
    }

    @Test func fieldAndTimezoneMappingRetainV2IdentityAndOffset() throws {
        let draft = overlayDraft()
        let zone = CalendarOverlayDateCodec.timeZone(for: draft)
        #expect(zone.identifier == "America/Los_Angeles")
        let date = try #require(CalendarOverlayDateCodec.date(from: draft.start, allDay: false, timeZone: zone))
        let changed = CalendarOverlayDateCodec.wireValue(from: date.addingTimeInterval(3600), allDay: false, timeZone: zone)
        #expect(changed.hasSuffix("-07:00"))

        let mapped = copyOverlayDraft(draft, title: "Updated", start: changed)
        #expect(mapped.eventId == draft.eventId)
        #expect(mapped.occurrenceId == draft.occurrenceId)
        #expect(mapped.originalStart == draft.originalStart)
        #expect(mapped.expectedRevision == draft.expectedRevision)
        #expect(mapped.inputTimeZoneId == draft.inputTimeZoneId)
        #expect(mapped.title == "Updated")
    }

    @Test func nativeDateHelpersPreserveAllDayValuesAndDisplayRanges() throws {
        let zone = try #require(TimeZone(identifier: "America/Los_Angeles"))
        let date = try #require(CalendarOverlayDateCodec.date(from: "2026-04-18", allDay: true, timeZone: zone))

        #expect(CalendarOverlayDateCodec.wireValue(from: date, allDay: true, timeZone: zone) == "2026-04-18")
        #expect(CalendarOverlayDateCodec.displayRange(start: "2026-04-18", end: nil) == "2026-04-18")
        #expect(CalendarOverlayDateCodec.displayRange(start: "10:00", end: "11:30") == "10:00 – 11:30")
    }

    @Test func recurrenceUntilRoundTripsTimedValuesWithoutRewritingUnrelatedEdits() throws {
        let zone = try #require(TimeZone(identifier: "America/Los_Angeles"))
        let wire = "2026-08-31T10:15:30.123-07:00"
        let source = try #require(CalendarOverlayDateCodec.recurrenceUntil(from: wire, timeZone: zone))

        #expect(!source.allDay)
        #expect(CalendarOverlayDateCodec.recurrenceUntilWireValue(
            source: source, date: source.date, timeZone: zone
        ) == wire)

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let nextDate = try #require(calendar.date(byAdding: .day, value: 1, to: source.date))
        #expect(CalendarOverlayDateCodec.recurrenceUntilWireValue(
            source: source, date: nextDate, timeZone: zone
        ) == "2026-09-01T10:15:30-07:00")
    }

    @Test func recurrenceUntilRoundTripsAllDayValuesWithoutAddingTime() throws {
        let zone = try #require(TimeZone(identifier: "America/Los_Angeles"))
        let wire = "2026-08-31"
        let source = try #require(CalendarOverlayDateCodec.recurrenceUntil(from: wire, timeZone: zone))

        #expect(source.allDay)
        #expect(CalendarOverlayDateCodec.recurrenceUntilWireValue(
            source: source, date: source.date, timeZone: zone
        ) == wire)

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let nextDate = try #require(calendar.date(byAdding: .day, value: 1, to: source.date))
        #expect(CalendarOverlayDateCodec.recurrenceUntilWireValue(
            source: source, date: nextDate, timeZone: zone
        ) == "2026-09-01")
    }

    @Test func typedErrorsUseNonDisclosingAccessibleCopy() {
        let forbidden = CalendarMutationError(
            kind: .forbidden, userMessage: "Secret event exists", code: "forbidden",
            status: 403, recoverable: false, requiresReread: false
        )
        #expect(CalendarOverlaySemantics.errorMessage(forbidden)
                == "You don’t have permission to view or change this event.")
        #expect(!CalendarOverlaySemantics.errorMessage(forbidden).contains("Secret"))
        #expect(CalendarOverlaySemantics.errorAccessibilityLabel(forbidden)
                == "Calendar error: You don’t have permission to view or change this event.")

        let connection = CalendarMutationError(
            kind: .connection, userMessage: "socket detail", code: "offline",
            status: nil, recoverable: true, requiresReread: false
        )
        #expect(CalendarOverlaySemantics.errorMessage(connection).contains("Connect"))
    }

    @Test func referenceGeometryAndFocusOriginsStayPinned() {
        #expect(CalendarOverlaySemantics.maximumHeightFraction == 0.84)
        #expect(CalendarOverlaySemantics.topRadius == 26)
        #expect(CalendarOverlaySemantics.handleSize == CGSize(width: 42, height: 4))
        #expect(CalendarOverlaySemantics.actionHeight == 48)
        #expect(CalendarOverlayOrigin.addControl != .event("event-7/occurrence-7"))
    }
}

private func overlayOccurrence() -> EffectiveOccurrence {
    EffectiveOccurrence(
        eventId: "event-7", occurrenceId: "occurrence-7",
        originalStart: "2026-08-17T09:00:00-07:00", recurring: true, revision: 7,
        scope: .household, title: "School pickup", description: "Bring forms",
        start: "2026-08-17T10:00:00-07:00", end: "2026-08-17T10:30:00-07:00",
        visibility: .everyone, importance: .important, group: "family", tags: ["school"], recurrence: nil
    )
}

private func overlayDraft() -> CalendarMutationDraft {
    CalendarMutationDraft(
        title: "School pickup", description: "Bring forms", allDay: false,
        start: "2026-08-17T10:00:00-07:00", end: "2026-08-17T10:30:00-07:00",
        scope: .household, visibility: .everyone, importance: .important,
        group: "family", tags: ["school"], recurrence: nil,
        eventId: "event-7", occurrenceId: "occurrence-7",
        originalStart: "2026-08-17T09:00:00-07:00", expectedRevision: 7,
        inputTimeZoneId: "America/Los_Angeles", recurring: true
    )
}

private func copyOverlayDraft(_ draft: CalendarMutationDraft, title: String? = nil,
                              start: String? = nil, recurrence: StructuredRecurrence? = nil) -> CalendarMutationDraft {
    CalendarMutationDraft(
        title: title ?? draft.title, description: draft.description_, allDay: draft.allDay,
        start: start ?? draft.start, end: draft.end, scope: draft.scope,
        visibility: draft.visibility, importance: draft.importance, group: draft.group,
        tags: draft.tags, recurrence: recurrence ?? draft.recurrence, eventId: draft.eventId,
        occurrenceId: draft.occurrenceId, originalStart: draft.originalStart,
        expectedRevision: draft.expectedRevision, inputTimeZoneId: draft.inputTimeZoneId,
        recurring: draft.recurring
    )
}
