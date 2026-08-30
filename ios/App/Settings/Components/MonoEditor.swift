import SwiftUI

/// Compatibility facade for the callback-based editor API. The binding-based
/// multiline primitive owns the editor surface, length cap, counter, and errors.
struct MonoEditor: View {
    let text: String
    var placeholder: String?
    var maxLength: Int?
    let accessibilityId: String
    let onChange: (String) -> Void

    var body: some View {
        DesignMultilineEditor(
            text: binding,
            placeholder: placeholder,
            maxLength: maxLength,
            accessibilityId: accessibilityId,
            usesMonospacedText: true
        )
    }

    private var binding: Binding<String> {
        Binding(
            get: { text },
            set: { onChange($0) }
        )
    }
}

#Preview {
    VStack(spacing: Space.lg) {
        MonoEditor(
            text: "",
            placeholder: "No MEMORY.md yet — Hermes will write here over time.",
            maxLength: 4000,
            accessibilityId: "settings-memory-editor",
            onChange: { _ in }
        )
        MonoEditor(
            text: "You are Sentient, a warm and capable family assistant…",
            accessibilityId: "settings-soul-editor",
            onChange: { _ in }
        )
    }
    .padding(Space.lg)
    .background(DuskColors.bg)
    .preferredColorScheme(.dark)
}
