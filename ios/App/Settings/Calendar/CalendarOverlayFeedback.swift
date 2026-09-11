import SwiftUI
import MobileData

struct CalendarConflictSheet: View {
    let conflict: CalendarConflictReviewState
    let error: CalendarMutationError?
    let onReread: () -> Void
    let onReview: (CalendarMutationDraft) -> Void
    let onCancel: () -> Void

    @AccessibilityFocusState private var headingFocused: Bool

    var body: some View {
        CalendarSheet(dismissOnScrim: false, onDismiss: {}) {
            CalendarSheetHeader(kicker: "CALENDAR CHANGED", title: "Review the latest version", onClose: onCancel)
                .accessibilityFocused($headingFocused)
            Text("Someone changed this event after you opened it. Reread it, review your draft, then save again.")
                .font(Typo.ui(TypeScale.base)).foregroundStyle(DuskColors.ink2)
            if let error {
                CalendarStatusNotice(kind: .conflict, message: CalendarOverlaySemantics.errorMessage(error))
            }
            if conflict.authoritativeEvent == nil {
                CalendarPrimaryButton(title: conflict.rereadInFlight ? "Rereading…" : "Reread event",
                                      disabled: conflict.rereadInFlight, action: onReread)
                    .accessibilityIdentifier("calendar-conflict-reread")
            } else if !conflict.reviewed {
                CalendarPrimaryButton(title: "Review my changes", disabled: false) {
                    onReview(conflict.draft)
                }
                .accessibilityIdentifier("calendar-conflict-review")
            } else {
                CalendarStatusNotice(kind: .success, message: "Latest version reviewed. You can save again.")
            }
            CalendarSecondaryButton(title: "Cancel", action: onCancel)
                .accessibilityIdentifier("calendar-conflict-cancel")
        }
        .interactiveDismissDisabled(true)
        .onAppear { headingFocused = true }
        .accessibilityIdentifier("calendar-conflict-sheet")
    }
}

struct CalendarOutcomeSheet: View {
    let outcome: any CalendarMutationOutcome
    let onClose: () -> Void

    @AccessibilityFocusState private var headingFocused: Bool

    var body: some View {
        CalendarSheet(dismissOnScrim: false, onDismiss: {}) {
            switch onEnum(of: outcome) {
            case .success(let success):
                CalendarSheetHeader(kicker: "COMPLETE", title: successTitle(success.operation), onClose: onClose)
                    .accessibilityFocused($headingFocused)
                CalendarStatusNotice(kind: .success, message: "The calendar is up to date.")
            case .failure(let failure):
                CalendarSheetHeader(kicker: "COULDN’T COMPLETE", title: "Calendar change failed", onClose: onClose)
                    .accessibilityFocused($headingFocused)
                CalendarStatusNotice(kind: failure.error.isPermission ? .permission : .error,
                                     message: CalendarOverlaySemantics.errorMessage(failure.error))
                    .accessibilityLabel(CalendarOverlaySemantics.errorAccessibilityLabel(failure.error))
            }
            CalendarPrimaryButton(title: "Done", disabled: false, action: onClose)
        }
        .interactiveDismissDisabled(true)
        .onAppear { headingFocused = true }
        .accessibilityIdentifier("calendar-outcome-sheet")
    }

    private func successTitle(_ operation: CalendarMutationOperation) -> String {
        switch operation {
        case .create: "Event added"
        case .update: "Event updated"
        case .delete: "Event deleted"
        }
    }
}

struct CalendarSheetHeader: View {
    let kicker: String
    let title: String
    let onClose: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: Space.md) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(kicker)
                    .font(Typo.mono(TypeScale.xs))
                    .foregroundStyle(DuskColors.ink3)
                    .tracking(1)
                Text(title)
                    .font(Typo.display(CalendarOverlaySemantics.headerDisplaySize, .medium))
                    .foregroundStyle(DuskColors.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: Space.sm)
            DesignCompactIconButton(
                systemName: "xmark",
                label: "Close",
                accessibilityId: "calendar-overlay-close",
                action: onClose
            )
        }
    }
}

struct CalendarMetadata: View {
    let rows: [(String, String)]

    var body: some View {
        VStack(spacing: Space.md) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(alignment: .firstTextBaseline, spacing: Space.md) {
                    Text(row.0).foregroundStyle(DuskColors.ink3)
                        .frame(width: CalendarOverlaySemantics.metadataLabelWidth, alignment: .leading)
                    Text(row.1).foregroundStyle(DuskColors.ink2).frame(maxWidth: .infinity, alignment: .leading)
                }
                .font(Typo.ui(TypeScale.sm))
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(row.0), \(row.1)")
            }
        }
        .padding(.vertical, Space.lg)
        .overlay(alignment: .top) { Divider().overlay(DuskColors.lineSoft) }
        .overlay(alignment: .bottom) { Divider().overlay(DuskColors.lineSoft) }
    }
}

enum CalendarNoticeKind { case offline, permission, conflict, error, success }

struct CalendarStatusNotice: View {
    let kind: CalendarNoticeKind
    let message: String

    var body: some View {
        Label(message, systemImage: icon)
            .font(Typo.ui(TypeScale.sm, .medium))
            .foregroundStyle(color)
            .padding(Space.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(color.opacity(CalendarOverlaySemantics.noticeBackgroundOpacity),
                        in: RoundedRectangle(cornerRadius: Radii.md))
            .accessibilityElement(children: .combine)
    }

    private var icon: String {
        switch kind {
        case .offline: "wifi.slash"
        case .permission: "lock.fill"
        case .conflict: "arrow.triangle.2.circlepath"
        case .error: "exclamationmark.triangle.fill"
        case .success: "checkmark.circle.fill"
        }
    }
    private var color: Color {
        switch kind {
        case .offline, .conflict: DuskColors.warn
        case .permission, .error: DuskColors.stop
        case .success: DuskColors.ok
        }
    }
}
