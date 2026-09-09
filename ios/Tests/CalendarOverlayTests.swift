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

    @Test func nativeDateHelpersPreserveWireValuesAndPresentReadableRanges() throws {
        let zone = try #require(TimeZone(identifier: "America/Los_Angeles"))
        let locale = Locale(identifier: "en_US")
        let date = try #require(CalendarOverlayDateCodec.date(from: "2026-04-18", allDay: true, timeZone: zone))

        #expect(CalendarOverlayDateCodec.wireValue(from: date, allDay: true, timeZone: zone) == "2026-04-18")
        let allDay = CalendarOverlayDateCodec.displayRange(start: "2026-04-18", end: nil, locale: locale)
        #expect(allDay.contains("Saturday"))
        #expect(allDay.contains("April 18, 2026"))
        #expect(!allDay.contains("2026-04-18"))

        let timed = CalendarOverlayDateCodec.displayRange(
            start: "2026-08-17T10:00:00-07:00",
            end: "2026-08-17T10:30:00-07:00",
            locale: locale
        )
        #expect(timed.contains("Monday"))
        #expect(timed.contains("10:00"))
        #expect(timed.contains("10:30"))
        #expect(!timed.contains("T10:00"))
    }

    @Test func allDayRangesDisplayExclusiveEndsAsInclusiveLocalDates() {
        let locale = Locale(identifier: "en_US")
        for (start, end, lastDay) in [
            ("2026-04-18", "2026-04-19", "2026-04-18"),
            ("2026-04-18", "2026-04-21", "2026-04-20"),
            ("2026-03-07", "2026-03-10", "2026-03-09"),
            ("2026-10-31", "2026-11-03", "2026-11-02"),
            ("2028-02-28", "2028-03-01", "2028-02-29"),
            ("2026-12-31", "2027-01-02", "2027-01-01")
        ] {
            let first = CalendarOverlayDateCodec.displayRange(start: start, end: nil, locale: locale)
            let last = CalendarOverlayDateCodec.displayRange(start: lastDay, end: nil, locale: locale)
            let expected = start == lastDay ? first : first + " – " + last.replacingOccurrences(of: "All day · ", with: "")
            #expect(CalendarOverlayDateCodec.displayRange(start: start, end: end, locale: locale) == expected)
        }
    }

    @Test func missingOrNonForwardAllDayEndsRemainSingleDay() {
        let locale = Locale(identifier: "en_US")
        let expected = CalendarOverlayDateCodec.displayRange(start: "2026-04-18", end: nil, locale: locale)
        for end in ["", "invalid", "2026-04-18", "2026-04-17"] {
            #expect(CalendarOverlayDateCodec.displayRange(start: "2026-04-18", end: end, locale: locale) == expected)
        }
    }

    @Test func sharedCloseKeepsContentCoveredUntilNativeDismissalCompletes() {
        var presentation = CalendarOverlayPresentation()
        presentation.sharedDidOpen()
        presentation.didPresent()
        let transition1 = presentation.requestClose(sharedOpen: true)
        #expect(transition1)
        let transition2 = presentation.requestClose(sharedOpen: true)
        #expect(!transition2)
        let transition3 = presentation.finishClose(sharedOpen: true)
        #expect(!transition3)
        // Shared close requests native dismissal, not focus/navigation yet.
        #expect(presentation.isCovered(sharedOpen: false))
        let transition4 = presentation.finishClose(sharedOpen: false)
        #expect(!transition4)
        presentation.didDismiss()
        #expect(!presentation.isCovered(sharedOpen: false))
        let transition5 = presentation.finishClose(sharedOpen: false)
        #expect(transition5)
        let transition6 = presentation.finishClose(sharedOpen: false)
        #expect(!transition6)
        let transition7 = presentation.requestClose(sharedOpen: false)
        #expect(!transition7)
        // A new presentation can issue exactly one new close intent.
        presentation.sharedDidOpen()
        let transition8 = presentation.requestClose(sharedOpen: true)
        #expect(transition8)
    }

    @Test func interactiveDismissalStillWaitsForAuthoritativeSharedClose() {
        var presentation = CalendarOverlayPresentation()
        presentation.didPresent()
        let transition9 = presentation.requestClose(sharedOpen: true)
        #expect(transition9)
        presentation.didDismiss()
        #expect(presentation.isCovered(sharedOpen: true))
        let transition10 = presentation.finishClose(sharedOpen: true)
        #expect(!transition10)
        let transition11 = presentation.requestClose(sharedOpen: true)
        #expect(!transition11)
        let transition12 = presentation.finishClose(sharedOpen: false)
        #expect(transition12)
    }

    @Test func closeWithoutNativePresentationNeedsNoSyntheticDismissal() {
        var presentation = CalendarOverlayPresentation()
        let transition13 = presentation.finishClose(sharedOpen: false)
        #expect(!transition13)
        presentation.sharedDidOpen()
        let transition14 = presentation.finishClose(sharedOpen: false)
        #expect(transition14)
        let transition15 = presentation.finishClose(sharedOpen: false)
        #expect(!transition15)
        // Even when SwiftUI coalesces the open/close observations, a requested
        // navigation close completes without waiting for a nonexistent sheet.
        let transition16 = presentation.requestClose(sharedOpen: true)
        #expect(transition16)
        let transition17 = presentation.finishClose(sharedOpen: false)
        #expect(transition17)
    }

    @Test func stateReplacementDoesNotCompleteAnOpenNativePresentation() {
        var presentation = CalendarOverlayPresentation()
        presentation.didPresent()
        // Preview/editor/outcome replacement keeps the same Boolean sheet open.
        let transition18 = presentation.finishClose(sharedOpen: true)
        #expect(!transition18)
        #expect(!presentation.closeRequested)
        // Explicit outcome acknowledgement/shared closure needs no Cancel.
        let transition19 = presentation.finishClose(sharedOpen: false)
        #expect(!transition19)
        presentation.didDismiss()
        let transition20 = presentation.finishClose(sharedOpen: false)
        #expect(transition20)
        #expect(!presentation.closeRequested)
    }

    @Test func recurrenceUntilUsesReadableSourceZoneDateWithoutChangingWireValue() throws {
        let locale = Locale(identifier: "en_US")
        let zone = try #require(TimeZone(secondsFromGMT: -7 * 60 * 60))
        let recurrence = StructuredRecurrence(
            frequency: .weekly, interval: 1, weekdays: [.monday], count: nil,
            until: "2026-08-31T10:15:30-07:00"
        )

        let summary = CalendarOverlaySemantics.recurrenceSummary(
            recurrence,
            locale: locale,
            timeZone: zone
        )
        #expect(summary?.contains("Monday, August 31, 2026") == true)
        #expect(summary?.contains("10:15") == true)
        #expect(summary?.contains("2026-08-31T10:15:30-07:00") == false)
        #expect(recurrence.until == "2026-08-31T10:15:30-07:00")
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
