// ---------------------------------------------------------------------------
// AddMemberSheet — the "Add user" modal for the Members page: display name + a
// 4-digit PIN (reusing the masked PinBoxesField). Mobile collects only name +
// PIN; the ViewModel templates the rest of the profile off the admin's own. On
// success the sheet dismisses; a server failure surfaces inline. PIN NEVER logged.
//
// Pure presentation: `adding` / `error` values + an async `onSubmit` returning
// success. Drafts live in local @State. Previews render empty + error states.
// ---------------------------------------------------------------------------
import SwiftUI

struct AddMemberSheet: View {
    let adding: Bool
    let error: String?
    let onSubmit: (String, String) async -> Bool

    @State private var name = ""
    @State private var pin = ""
    @Environment(\.dismiss) private var dismiss

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSubmit: Bool { !trimmedName.isEmpty && pin.count == 4 && !adding }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.lg) {
                    Text("Create a new member of this household.")
                        .font(Typo.ui(TypeScale.sm))
                        .foregroundStyle(DuskColors.ink3)
                    nameField
                    PinBoxesField(title: "PIN", value: $pin, accessibilityId: "settings-members-add-pin", autoFocus: false)
                    if let error {
                        Text(error)
                            .font(Typo.ui(TypeScale.xs, .medium))
                            .foregroundStyle(DuskColors.stop)
                            .accessibilityIdentifier("settings-members-add-error")
                    }
                }
                .padding(.horizontal, Space.lg)
                .padding(.top, Space.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(DuskColors.bg)
            .navigationTitle("Add user")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .accessibilityIdentifier("settings-members-add-cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") { Task { if await onSubmit(trimmedName, pin) { dismiss() } } }
                        .disabled(!canSubmit)
                        .accessibilityIdentifier("settings-members-add-submit")
                }
            }
            .duskTheme()
        }
    }

    private var nameField: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text("Display name")
                .font(Typo.ui(TypeScale.xs, .medium))
                .foregroundStyle(DuskColors.ink3)
            TextField("Their name", text: $name)
                .font(Typo.ui(TypeScale.sm))
                .foregroundStyle(DuskColors.ink)
                .padding(.horizontal, Space.md)
                .padding(.vertical, Space.sm)
                .background(DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.sm))
                .overlay(RoundedRectangle(cornerRadius: Radii.sm).stroke(DuskColors.lineSoft, lineWidth: 1))
                .accessibilityIdentifier("settings-members-add-name")
        }
    }
}

#Preview("empty") {
    AddMemberSheet(adding: false, error: nil, onSubmit: { _, _ in true })
}

#Preview("error") {
    AddMemberSheet(adding: false, error: "Household is full", onSubmit: { _, _ in false })
}
