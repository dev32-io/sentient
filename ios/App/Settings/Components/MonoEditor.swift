// ---------------------------------------------------------------------------
// MonoEditor — multiline monospaced text editor with an optional hard
// `maxLength` cap and a "used / cap" char counter. Transcribed from the
// webui `Textarea` primitive (components/settings/primitives/textarea.tsx,
// `.mono` variant) used for Memory, System Prompt, and the prompt-injection
// editor.
//
// `maxLength` is enforced in the binding's setter (SwiftUI's `TextEditor`
// has no native `maxLength`, unlike the browser's `<textarea maxLength>`),
// so a paste past the cap is clamped the same way the webui's browser-level
// cap behaves. Placeholder is hand-drawn (`TextEditor` has none) and only
// approximately aligned to the editor's built-in internal inset — close
// enough for a first pass; re-check against a live render before shipping a
// screen that leans on pixel-perfect placeholder alignment.
//
// Stateless leaf: `text` + `onChange` in, no local state, no ViewModel.
// ---------------------------------------------------------------------------
import SwiftUI

private let editorInset: CGFloat = 8
private let placeholderInsetH: CGFloat = 14
private let placeholderInsetV: CGFloat = 16
private let editorMinHeight: CGFloat = 160

struct MonoEditor: View {
    let text: String
    var placeholder: String?
    var maxLength: Int?
    let accessibilityId: String
    let onChange: (String) -> Void

    private var textBinding: Binding<String> {
        Binding(
            get: { text },
            set: { newValue in
                guard let cap = maxLength, newValue.count > cap else {
                    onChange(newValue)
                    return
                }
                onChange(String(newValue.prefix(cap)))
            }
        )
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: Space.xs) {
            editor
            if let cap = maxLength {
                Text("\(text.count) / \(cap)")
                    .font(Typo.mono(TypeScale.xs))
                    .foregroundStyle(text.count >= cap ? DuskColors.stop : DuskColors.ink3)
                    .accessibilityIdentifier("\(accessibilityId)-count")
            }
        }
    }

    private var editor: some View {
        ZStack(alignment: .topLeading) {
            if text.isEmpty, let placeholder {
                Text(placeholder)
                    .font(Typo.mono(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink4)
                    .padding(.horizontal, placeholderInsetH)
                    .padding(.vertical, placeholderInsetV)
                    .allowsHitTesting(false)
            }
            TextEditor(text: textBinding)
                .font(Typo.mono(TypeScale.sm))
                .foregroundStyle(DuskColors.ink)
                .scrollContentBackground(.hidden)
                .padding(editorInset)
        }
        .frame(minHeight: editorMinHeight)
        .background(DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.sm))
        .overlay(RoundedRectangle(cornerRadius: Radii.sm).stroke(DuskColors.lineSoft, lineWidth: 1))
        .accessibilityIdentifier(accessibilityId)
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
