import SwiftUI

/// Compatibility facade for the callback-based slider row API.
struct RowSlider: View {
    let label: String
    let value: Double
    let range: ClosedRange<Double>
    let step: Double
    let format: (Double) -> String
    let accessibilityId: String
    let onChange: (Double) -> Void

    var body: some View {
        DesignSlider(
            title: label,
            value: Binding(get: { value }, set: onChange),
            range: range,
            step: step,
            format: format,
            accessibilityId: accessibilityId
        )
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
