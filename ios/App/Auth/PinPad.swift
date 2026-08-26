import SwiftUI

struct PinPad: View {
    let entered: Int
    var isSubmitting = false
    let onDigit: (Character) -> Void
    let onDelete: () -> Void

    private static let rows: [[String]] = [
        ["1", "2", "3"],
        ["4", "5", "6"],
        ["7", "8", "9"],
        ["", "0", "delete"],
    ]

    var body: some View {
        VStack(spacing: Space.xl) {
            dots
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("PIN entry")
                .accessibilityValue("\(entered) of \(pinLength) digits entered")
            VStack(spacing: Space.sm) {
                ForEach(Self.rows, id: \.self) { row in
                    HStack(spacing: Space.sm) {
                        ForEach(row, id: \.self) { key in
                            keyView(key)
                                .frame(maxWidth: .infinity)
                        }
                    }
                }
            }
        }
        .disabled(isSubmitting)
    }

    private var dots: some View {
        HStack(spacing: Space.lg) {
            ForEach(0..<pinLength, id: \.self) { index in
                Circle()
                    .fill(index < entered ? DuskColors.accent : DuskColors.bgElev)
                    .frame(width: Space.sm, height: Space.sm)
                    .overlay(Circle().stroke(DuskColors.line, lineWidth: DesignMetrics.hairline))
            }
        }
    }

    @ViewBuilder
    private func keyView(_ key: String) -> some View {
        switch key {
        case "":
            Color.clear.frame(minHeight: DesignMetrics.minimumTarget)
                .accessibilityHidden(true)
        case "delete":
            Button(action: onDelete) {
                Image(systemName: "delete.left")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(DesignButtonStyle(role: .quiet))
            .accessibilityLabel("Delete")
            .accessibilityIdentifier("pin-delete")
        default:
            Button(action: { onDigit(Character(key)) }) {
                Text(key).designText(.large).frame(maxWidth: .infinity)
            }
            .buttonStyle(DesignButtonStyle(role: .quiet))
            .accessibilityIdentifier("pin-key-\(key)")
        }
    }
}
