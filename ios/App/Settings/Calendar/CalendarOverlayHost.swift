import SwiftUI
import MobileData

/// Integration wrapper that removes covered content from accessibility and hit
/// testing while keeping the controlled host independent of CalendarScreen.
struct CalendarOverlayContainer<Content: View>: View {
    let state: CalendarUiState
    let origin: CalendarOverlayOrigin
    let actions: CalendarOverlayActions
    @ViewBuilder let content: () -> Content

    var body: some View {
        let overlayOpen = CalendarOverlaySemantics.isOpen(state)
        ZStack {
            content()
                .allowsHitTesting(!overlayOpen)
                .accessibilityHidden(overlayOpen)
            CalendarOverlayHost(state: state, origin: origin, actions: actions)
        }
    }
}

/// Controlled overlay stack for CalendarScreen integration. It renders shared
/// mutation state and forwards every user action through the supplied closures.
struct CalendarOverlayHost: View {
    let state: CalendarUiState
    let origin: CalendarOverlayOrigin
    let actions: CalendarOverlayActions

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack(alignment: .bottom) {
            if let outcome = state.outcome {
                CalendarOutcomeSheet(outcome: outcome, onClose: actions.acknowledgeOutcome)
                    .transition(sheetTransition)
            } else if let conflict = state.conflict {
                CalendarConflictSheet(
                    conflict: conflict,
                    error: state.mutation.error,
                    onReread: actions.rereadConflict,
                    onReview: actions.reviewConflict,
                    onCancel: actions.close
                )
                .transition(sheetTransition)
            } else if let confirmation = state.deleteConfirmation {
                CalendarDeleteSheet(
                    confirmation: confirmation,
                    isOffline: state.isOffline,
                    isSubmitting: state.mutation.isSubmitting,
                    error: state.mutation.error,
                    onChooseScope: actions.chooseScope,
                    onDelete: actions.confirmDelete,
                    onCancel: actions.close
                )
                .transition(sheetTransition)
            } else if let editor = state.editor {
                CalendarEditorSheet(
                    editor: editor,
                    canSave: CalendarOverlaySemantics.canSave(state, draft: editor.draft) &&
                        (editor.applicableScopes.count == 1 || editor.selectedScope != nil),
                    canDelete: state.mutationAvailability.canDelete,
                    isOffline: state.isOffline,
                    isSubmitting: state.mutation.isSubmitting,
                    error: state.mutation.error,
                    onUpdate: actions.updateDraft,
                    onChooseScope: actions.chooseScope,
                    onSave: actions.save,
                    onDelete: actions.requestDelete,
                    onCancel: actions.close
                )
                .transition(sheetTransition)
            } else if let preview = state.preview {
                CalendarPreviewSheet(
                    occurrence: preview,
                    canEdit: state.mutationAvailability.canEdit,
                    isOffline: state.isOffline,
                    onEdit: { actions.edit(preview) },
                    onClose: actions.close
                )
                .transition(sheetTransition)
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: Motion.normal), value: state.mutation.phase)
        .onChange(of: CalendarOverlaySemantics.isOpen(state)) { oldValue, newValue in
            if oldValue && !newValue { actions.restoreFocus(origin) }
        }
    }

    private var sheetTransition: AnyTransition {
        reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity)
    }
}
