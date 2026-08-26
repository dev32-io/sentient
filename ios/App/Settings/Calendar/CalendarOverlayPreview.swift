import SwiftUI
import MobileData

struct CalendarPreviewSheet: View {
    let occurrence: EffectiveOccurrence
    let canEdit: Bool
    let isOffline: Bool
    let onEdit: () -> Void
    let onClose: () -> Void

    @AccessibilityFocusState private var headingFocused: Bool

    var body: some View {
        CalendarSheet(dismissOnScrim: true, onDismiss: onClose) {
            CalendarSheetHeader(kicker: "EVENT PREVIEW", title: occurrence.title, onClose: onClose)
                .accessibilityFocused($headingFocused)
            Text(CalendarOverlayDateCodec.displayRange(start: occurrence.start, end: occurrence.end))
                .font(Typo.mono(TypeScale.sm))
                .foregroundStyle(DuskColors.ink3)
            if let description = occurrence.description_, !description.isEmpty {
                Text(description)
                    .font(Typo.ui(TypeScale.base))
                    .foregroundStyle(DuskColors.ink2)
            }
            CalendarMetadata(rows: previewRows)
            if isOffline {
                CalendarStatusNotice(kind: .offline, message: "Connect to edit this event.")
            }
            HStack(spacing: Space.sm) {
                CalendarSecondaryButton(title: "Close", action: onClose)
                    .accessibilityIdentifier("calendar-preview-close")
                CalendarPrimaryButton(title: "Edit", disabled: !canEdit || isOffline, action: onEdit)
                    .accessibilityIdentifier("calendar-preview-edit")
            }
        }
        .onAppear { headingFocused = true }
        .accessibilityIdentifier("calendar-preview-sheet")
    }

    private var previewRows: [(String, String)] {
        var rows = [
            ("Calendar", occurrence.scope.calendarDisplayName),
            ("Visibility", occurrence.visibility.calendarDisplayName),
            ("Importance", occurrence.importance.calendarDisplayName)
        ]
        if let group = occurrence.group, !group.isEmpty { rows.append(("Group", group)) }
        if !occurrence.tags.isEmpty { rows.append(("Tags", occurrence.tags.joined(separator: ", "))) }
        if let recurrence = CalendarOverlaySemantics.recurrenceSummary(occurrence.recurrence) {
            rows.append(("Repeats", recurrence))
        }
        return rows
    }
}
