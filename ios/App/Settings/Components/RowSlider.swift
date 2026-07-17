// ---------------------------------------------------------------------------
// RowSlider — label + mono value-readout chip + a native Slider, tinted with
// the Dusk accent token. Transcribed from the webui Row + Slider primitives
// (components/settings/primitives/row.tsx + slider.tsx). Used for Advanced's
// Compression (0–1 / step 0.05) and Max tokens (128–8192 / step 128) rows.
//
// `format` renders the raw Double into the readout string (e.g. "0.30" or
// "4096 tok") — the caller owns unit formatting, this view only lays it out.
//
// Stateless leaf: `value` + `onChange` in, no local state, no ViewModel.
// ---------------------------------------------------------------------------
import SwiftUI

struct RowSlider: View {
    let label: String
    let value: Double
    let range: ClosedRange<Double>
    let step: Double
    let format: (Double) -> String
    let accessibilityId: String
    let onChange: (Double) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            HStack {
                Text(label)
                    .font(Typo.ui(TypeScale.sm, .medium))
                    .foregroundStyle(DuskColors.ink)
                Spacer(minLength: Space.sm)
                Text(format(value))
                    .font(Typo.mono(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink)
                    .padding(.horizontal, Space.sm)
                    .padding(.vertical, Space.xs)
                    .background(DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.sm))
                    .overlay(RoundedRectangle(cornerRadius: Radii.sm).stroke(DuskColors.lineSoft, lineWidth: 1))
            }
            Slider(value: Binding(get: { value }, set: onChange), in: range, step: step)
                .tint(DuskColors.accent)
        }
        .padding(.vertical, Space.sm)
        .accessibilityIdentifier(accessibilityId)
    }
}

#Preview {
    VStack(spacing: Space.md) {
        RowSlider(
            label: "Compression threshold",
            value: 0.3,
            range: 0...1,
            step: 0.05,
            format: { String(format: "%.2f", $0) },
            accessibilityId: "settings-advanced-compression",
            onChange: { _ in }
        )
        RowSlider(
            label: "Max tokens",
            value: 4096,
            range: 128...8192,
            step: 128,
            format: { "\(Int($0)) tok" },
            accessibilityId: "settings-advanced-max-tokens",
            onChange: { _ in }
        )
    }
    .padding(Space.lg)
    .background(DuskColors.bg)
    .preferredColorScheme(.dark)
}
