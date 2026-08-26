import SwiftUI
import MobileData

struct CalendarEditorSheet: View {
    let editor: CalendarMutationEditorState
    let canSave: Bool
    let canDelete: Bool
    let isOffline: Bool
    let isSubmitting: Bool
    let error: CalendarMutationError?
    let onUpdate: (CalendarMutationDraft) -> Void
    let onChooseScope: (CalendarMutationScope) -> Void
    let onSave: (CalendarMutationDraft) -> Void
    let onDelete: () -> Void
    let onCancel: () -> Void

    @State private var draft: CalendarMutationDraft
    @FocusState private var titleFocused: Bool

    init(editor: CalendarMutationEditorState, canSave: Bool, canDelete: Bool, isOffline: Bool,
         isSubmitting: Bool, error: CalendarMutationError?,
         onUpdate: @escaping (CalendarMutationDraft) -> Void,
         onChooseScope: @escaping (CalendarMutationScope) -> Void,
         onSave: @escaping (CalendarMutationDraft) -> Void,
         onDelete: @escaping () -> Void, onCancel: @escaping () -> Void) {
        self.editor = editor
        self.canSave = canSave
        self.canDelete = canDelete
        self.isOffline = isOffline
        self.isSubmitting = isSubmitting
        self.error = error
        self.onUpdate = onUpdate
        self.onChooseScope = onChooseScope
        self.onSave = onSave
        self.onDelete = onDelete
        self.onCancel = onCancel
        _draft = State(initialValue: editor.draft)
    }

    var body: some View {
        CalendarSheet(dismissOnScrim: !isSubmitting, onDismiss: onCancel) {
            CalendarSheetHeader(
                kicker: editor.isCreate ? "NEW EVENT" : "EDIT EVENT",
                title: editor.isCreate ? "Add event" : "Edit event",
                onClose: onCancel
            )
            .disabled(isSubmitting)
            CalendarDraftFields(draft: $draft, titleFocused: $titleFocused, onUpdate: onUpdate)
                .disabled(isSubmitting)
            if editor.applicableScopes.count > 1 {
                CalendarScopeChoices(scopes: editor.applicableScopes, selected: editor.selectedScope,
                                     onChoose: onChooseScope)
                    .disabled(isSubmitting)
            }
            if isOffline {
                CalendarStatusNotice(kind: .offline,
                    message: "Connection required. Your draft stays open, but it can’t be saved offline.")
            }
            if let error {
                CalendarStatusNotice(kind: error.isPermission ? .permission : .error,
                                     message: CalendarOverlaySemantics.errorMessage(error))
                    .accessibilityLabel(CalendarOverlaySemantics.errorAccessibilityLabel(error))
                    .accessibilityIdentifier("calendar-editor-error")
            }
            if editor.isEdit && canDelete {
                Button("Delete event", role: .destructive, action: onDelete)
                    .font(Typo.ui(TypeScale.base, .semibold))
                    .foregroundStyle(DuskColors.stop)
                    .frame(minWidth: DesignMetrics.minimumTarget, minHeight: DesignMetrics.minimumTarget)
                    .disabled(isOffline || isSubmitting)
                    .accessibilityHint(isOffline ? "Connection required" : "")
                    .accessibilityIdentifier("calendar-editor-delete")
            }
        } footer: {
            HStack(spacing: Space.sm) {
                CalendarSecondaryButton(title: "Cancel", disabled: isSubmitting, action: onCancel)
                    .accessibilityIdentifier("calendar-editor-cancel")
                CalendarPrimaryButton(title: isSubmitting ? "Saving…" : "Save",
                                      disabled: !canSave || isOffline || isSubmitting) { onSave(draft) }
                    .accessibilityIdentifier("calendar-editor-save")
            }
        }
        .interactiveDismissDisabled(isSubmitting)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { titleFocused = false }
                    .accessibilityIdentifier("calendar-editor-keyboard-done")
            }
        }
        .onAppear { titleFocused = true }
        .accessibilityIdentifier("calendar-editor-sheet")
    }
}
