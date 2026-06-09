// ---------------------------------------------------------------------------
// PinPad — the PIN entry surface: a row of [pinLength] dots (filled as digits
// arrive) above a 3×4 numpad (1-9, then 0 and a delete key). Stateless leaf:
// takes the entered length + key closures; the screen owns the digit string.
//
// accessibilityIdentifiers `pin-key-<n>` on each digit key and `pin-delete` on
// the delete key mirror the Android testTags so the e2e driver taps by id.
// Keys are 64×56pt with a 44pt minimum tap target (iOS HIG).
// ---------------------------------------------------------------------------
import SwiftUI

struct PinPad: View {
    let entered: Int
    let onDigit: (Character) -> Void
    let onDelete: () -> Void

    private static let dotSize: CGFloat = 14
    private static let keyWidth: CGFloat = 64
    private static let keyHeight: CGFloat = 56
    private static let minTap: CGFloat = 44

    /// Numpad rows. Last row is [empty, 0, del] so 0 sits under 8.
    private static let rows: [[String]] = [
        ["1", "2", "3"],
        ["4", "5", "6"],
        ["7", "8", "9"],
        ["", "0", "del"],
    ]

    var body: some View {
        VStack(spacing: Space.xl) {
            dots
            VStack(spacing: Space.md) {
                ForEach(Self.rows, id: \.self) { row in
                    HStack(spacing: Space.md) {
                        ForEach(row, id: \.self) { label in
                            key(for: label)
                        }
                    }
                }
            }
        }
    }

    private var dots: some View {
        HStack(spacing: Space.lg) {
            ForEach(0..<pinLength, id: \.self) { i in
                Circle()
                    .fill(i < entered ? DuskColors.accent : DuskColors.bgElev)
                    .frame(width: Self.dotSize, height: Self.dotSize)
            }
        }
    }

    @ViewBuilder
    private func key(for label: String) -> some View {
        switch label {
        case "":
            Color.clear.frame(width: Self.keyWidth, height: Self.keyHeight)
        case "del":
            keyButton(text: "\u{232B}", action: onDelete)
                .accessibilityIdentifier("pin-delete")
                .accessibilityLabel("Delete")
        default:
            keyButton(text: label, action: { onDigit(Character(label)) })
                .accessibilityIdentifier("pin-key-\(label)")
        }
    }

    private func keyButton(text: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(text)
                .font(.system(size: TypeScale.lg, weight: .medium))
                .foregroundStyle(DuskColors.ink)
                .frame(width: Self.keyWidth, height: Self.keyHeight)
                .background(DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.md))
        }
        .buttonStyle(.plain)
        .frame(minWidth: Self.minTap, minHeight: Self.minTap)
    }
}
