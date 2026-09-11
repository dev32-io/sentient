import SwiftUI
import MobileData

struct CalendarDeleteSheet: View {
    let confirmation: CalendarDeleteConfirmationState
    let isOffline: Bool
    let isSubmitting: Bool
    let error: CalendarMutationError?
    let onChooseScope: (CalendarMutationScope) -> Void
    let onDelete: (CalendarMutationScope?) -> Void
    let onCancel: () -> Void

    @AccessibilityFocusState private var headingFocused: Bool

    var body: some View {
        CalendarSheet(dismissOnScrim: false, onDismiss: {}) {
            CalendarSheetHeader(kicker: "CONFIRM DELETE", title: "Delete event?", onClose: onCancel)
                .disabled(isSubmitting)
                .accessibilityFocused($headingFocused)
            Text("This action can’t be undone.")
                .font(Typo.ui(TypeScale.base)).foregroundStyle(DuskColors.ink2)
            if confirmation.applicableScopes.count > 1 {
                CalendarScopeChoices(scopes: confirmation.applicableScopes,
                                     selected: confirmation.selectedScope,
                                     onChoose: onChooseScope)
                    .disabled(isSubmitting)
            }
            if isOffline {
                CalendarStatusNotice(kind: .offline, message: "Connect to delete this event.")
            }
            if let error {
                CalendarStatusNotice(kind: error.isPermission ? .permission : .error,
                                     message: CalendarOverlaySemantics.errorMessage(error))
            }
            HStack(spacing: Space.sm) {
                CalendarSecondaryButton(title: "Cancel", disabled: isSubmitting, action: onCancel)
                    .accessibilityIdentifier("calendar-confirmation-cancel")
                CalendarDestructiveButton(title: isSubmitting ? "Deleting…" : "Delete",
                    disabled: isOffline || isSubmitting ||
                        (confirmation.applicableScopes.count > 1 && confirmation.selectedScope == nil)) {
                        onDelete(confirmation.selectedScope)
                    }
                    .accessibilityIdentifier("calendar-confirmation-delete")
            }
        }
        .interactiveDismissDisabled(true)
        .onAppear { headingFocused = true }
        .accessibilityIdentifier("calendar-delete-sheet")
    }
}
