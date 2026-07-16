// ---------------------------------------------------------------------------
// ChangePinSheet — the "Change PIN" modal: current + new 4-digit entries as
// masked PIN boxes (numeric keypad, dots only — digits are NEVER shown or
// logged). Submits current+new; on success the sheet dismisses, on a wrong
// current PIN the caller surfaces an inline error with NO logout.
//
// Pure presentation: takes `saving` / `error` values + an async `onSubmit`
// returning success. PIN drafts live in local @State so they never leave the
// sheet. Previews render the empty + error states with no VM.
// ---------------------------------------------------------------------------
import SwiftUI

private let pinDigitCount = 4
private let sheetLead = "Enter your current 4-digit PIN, then choose a new one."

/// A row of masked PIN boxes backed by an invisible numeric field.
struct PinBoxesField: View {
    let title: String
    @Binding var value: String
    let accessibilityId: String
    var autoFocus = false

    @FocusState private var focused: Bool

    private static let boxWidth: CGFloat = 46
    private static let boxHeight: CGFloat = 54
    private static let dotSize: CGFloat = 11

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(title)
                .font(Typo.ui(TypeScale.xs, .medium))
                .foregroundStyle(DuskColors.ink3)
            ZStack {
                boxes
                TextField("", text: sanitizedBinding)
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
                    .focused($focused)
                    .foregroundStyle(.clear)
                    .tint(.clear)
                    .accessibilityIdentifier(accessibilityId)
            }
            .contentShape(Rectangle())
            .onTapGesture { focused = true }
        }
        .task { if autoFocus { focused = true } }
    }

    private var sanitizedBinding: Binding<String> {
        Binding(
            get: { value },
            set: { value = String($0.filter(\.isNumber).prefix(pinDigitCount)) }
        )
    }

    private var boxes: some View {
        HStack(spacing: Space.sm) {
            ForEach(0..<pinDigitCount, id: \.self) { index in
                box(filled: index < value.count)
            }
        }
    }

    private func box(filled: Bool) -> some View {
        RoundedRectangle(cornerRadius: Radii.sm)
            .fill(DuskColors.bgElev)
            .frame(width: Self.boxWidth, height: Self.boxHeight)
            .overlay(
                RoundedRectangle(cornerRadius: Radii.sm)
                    .stroke(focused ? DuskColors.accent : DuskColors.lineSoft, lineWidth: 1)
            )
            .overlay(
                Circle()
                    .fill(DuskColors.ink)
                    .frame(width: Self.dotSize, height: Self.dotSize)
                    .opacity(filled ? 1 : 0)
            )
    }
}

struct ChangePinSheet: View {
    let saving: Bool
    let error: String?
    let onSubmit: (String, String) async -> Bool

    @State private var current = ""
    @State private var newPin = ""
    @Environment(\.dismiss) private var dismiss

    private var canSubmit: Bool {
        current.count == pinDigitCount && newPin.count == pinDigitCount && !saving
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.lg) {
                    Text(sheetLead)
                        .font(Typo.ui(TypeScale.sm))
                        .foregroundStyle(DuskColors.ink3)
                    PinBoxesField(
                        title: "Current PIN",
                        value: $current,
                        accessibilityId: "settings-account-pin-current",
                        autoFocus: true
                    )
                    PinBoxesField(
                        title: "New PIN",
                        value: $newPin,
                        accessibilityId: "settings-account-pin-new"
                    )
                    if let error {
                        Text(error)
                            .font(Typo.ui(TypeScale.xs, .medium))
                            .foregroundStyle(DuskColors.stop)
                            .accessibilityIdentifier("settings-account-pin-error")
                    }
                }
                .padding(.horizontal, Space.lg)
                .padding(.top, Space.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(DuskColors.bg)
            .navigationTitle("Change PIN")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .accessibilityIdentifier("settings-account-pin-cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Update") { Task { if await onSubmit(current, newPin) { dismiss() } } }
                        .disabled(!canSubmit)
                        .accessibilityIdentifier("settings-account-pin-submit")
                }
            }
            .duskTheme()
        }
    }
}

#Preview("empty") {
    ChangePinSheet(saving: false, error: nil, onSubmit: { _, _ in true })
}

#Preview("wrong-current") {
    ChangePinSheet(saving: false, error: "Current PIN is wrong", onSubmit: { _, _ in false })
}
