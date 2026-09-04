import SwiftUI
import UIKit

private enum DesignFieldMetrics {
    // The web input's 40px minimum grows to its inherited 1.55 line-height
    // plus its 9px vertical padding and 1px border at the reviewed content
    // size. Preserve that source-derived face while keeping a separate 44pt
    // semantic target.
    static let labelGap: CGFloat = 7
    static let labelLineHeight = DesignMetrics.controlLabelSize * CGFloat(DesignV2.Typography.lineNormal)
    // The native well border is centered on its shape, so one hairline is
    // removed from the CSS border-box height to preserve the visible extent.
    static let visualHeight = TypeScale.base * CGFloat(DesignV2.Typography.lineNormal) + 18 + DesignMetrics.hairline
    static let focusCastRadius: CGFloat = 18
    static let focusCastSourceInset: CGFloat = 14
}

struct DesignField: View {
    let title: String
    var prompt: String = ""
    @Binding var text: String
    var error: String? = nil
    var accessibilityId: String? = nil
    var isEnabled = true
    var showsTitle = true
    var accessibilityLabel: String? = nil
    var axis: Axis? = nil
    var lineLimit: ClosedRange<Int> = 1...1
    var autocapitalization: TextInputAutocapitalization? = nil
    var autocorrectionDisabled = false
    var minimumHeight: CGFloat = DesignMetrics.minimumTarget
    var focused: FocusState<Bool>.Binding? = nil
    var submitLabel: SubmitLabel? = nil
    var onSubmit: (() -> Void)? = nil
    var onChange: ((String) -> Void)? = nil
    @FocusState private var internalFocused: Bool

    init(
        title: String,
        prompt: String = "",
        text: Binding<String>,
        error: String? = nil,
        accessibilityId: String? = nil,
        isEnabled: Bool = true,
        showsTitle: Bool = true,
        accessibilityLabel: String? = nil,
        axis: Axis? = nil,
        lineLimit: ClosedRange<Int> = 1...1,
        autocapitalization: TextInputAutocapitalization? = nil,
        autocorrectionDisabled: Bool = false,
        minimumHeight: CGFloat = DesignMetrics.minimumTarget,
        focused: FocusState<Bool>.Binding? = nil,
        submitLabel: SubmitLabel? = nil,
        onSubmit: (() -> Void)? = nil,
        onChange: ((String) -> Void)? = nil
    ) {
        self.title = title
        self.prompt = prompt
        _text = text
        self.error = error
        self.accessibilityId = accessibilityId
        self.isEnabled = isEnabled
        self.showsTitle = showsTitle
        self.accessibilityLabel = accessibilityLabel
        self.axis = axis
        self.lineLimit = lineLimit
        self.autocapitalization = autocapitalization
        self.autocorrectionDisabled = autocorrectionDisabled
        self.minimumHeight = minimumHeight
        self.focused = focused
        self.submitLabel = submitLabel
        self.onSubmit = onSubmit
        self.onChange = onChange
    }

    private var isFocused: Bool {
        focused?.wrappedValue ?? internalFocused
    }

    private var faceHeight: CGFloat {
        min(
            minimumHeight == DesignMetrics.minimumTarget ? DesignFieldMetrics.visualHeight : minimumHeight,
            minimumHeight
        )
    }

    private var semanticHeight: CGFloat {
        max(minimumHeight, DesignMetrics.minimumTarget)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DesignFieldMetrics.labelGap) {
            if showsTitle {
                Text(title)
                    .font(.custom(
                        DesignTypographyAdapter.uiMediumFace,
                        size: DesignMetrics.controlLabelSize,
                        relativeTo: .footnote
                    ))
                    // Native custom-font line metrics sit one half-point below
                    // the CSS label baseline at the reviewed scale.
                    .baselineOffset(0.5)
                    .foregroundStyle(DuskColors.ink)
                    .frame(minHeight: DesignFieldMetrics.labelLineHeight)
            }
            focusableField
            if let error {
                designFieldError(message: error, accessibilityId: accessibilityId.map { "\($0)-error" })
            }
        }
    }

    @ViewBuilder
    private var focusableField: some View {
        if let focused {
            input.focused(focused)
        } else {
            input.focused($internalFocused)
        }
    }

    @ViewBuilder
    private var nativeField: some View {
        if let axis {
            TextField(prompt, text: $text, axis: axis)
        } else {
            TextField(prompt, text: $text)
        }
    }

    private var baseInput: some View {
        nativeField
            .font(Typo.ui(TypeScale.base))
            // Match the CSS border-box content inset: 1px border + 12px pad.
            // Native TextField centers its glyph run below the browser line
            // box; this positive baseline adjustment restores the source's
            // 9px top inset without changing the semantic target.
            .baselineOffset(0.5)
            .foregroundStyle(DuskColors.ink)
            .textFieldStyle(.plain)
            .padding(.horizontal, Space.md + DesignMetrics.hairline)
            .frame(minHeight: faceHeight)
    }

    private var surfacedInput: some View {
        baseInput
            .lineLimit(lineLimit)
            // Keep the shared well face and rest construction. Its focused
            // cast uses a native blur without CSS's negative spread, so the
            // field supplies that one focused layer through the shared
            // spread-shadow renderer below.
            .designWell(focused: false, error: error != nil)
            .background {
                if isFocused {
                    ZStack {
                        // The focused well has the source's positive three-pixel
                        // spread behind the native outline. A six-point stroke
                        // supplies that outside ring while the well face covers
                        // its inward half.
                        RoundedRectangle(cornerRadius: Radii.sm, style: .continuous)
                            .stroke(
                                DuskColors.accent.opacity(DesignMaterialAdapter.wellFocusRingOpacity),
                                lineWidth: DesignMetrics.focusRing * 2
                            )
                        DesignSpreadShadow(
                            shape: RoundedRectangle(cornerRadius: Radii.sm, style: .continuous),
                            color: DuskColors.accent.opacity(DesignMaterialAdapter.wellFocusCastOpacity),
                            geometry: DesignDropShadowGeometry(
                                radius: DesignFieldMetrics.focusCastRadius,
                                y: DesignMaterialAdapter.wellFocusCastY,
                                sourceInset: DesignFieldMetrics.focusCastSourceInset
                            )
                        )
                    }
                }
            }
            .overlay {
                if isFocused {
                    RoundedRectangle(cornerRadius: Radii.sm, style: .continuous)
                        .stroke(
                            DuskColors.accent.overlaying(
                                DuskColors.line,
                                opacity: DesignMaterialAdapter.wellFocusMix
                            ),
                            lineWidth: DesignMetrics.hairline
                        )
                }
                // The web field's keyboard-focus outline is a 2px ember
                // stroke with a 3px outside offset; native focus supplies the
                // same cue without changing the control's hit target.
                RoundedRectangle(cornerRadius: Radii.sm + DesignMetrics.focusRing, style: .continuous)
                    .stroke(
                        isFocused ? DuskColors.accent : .clear,
                        lineWidth: DesignMetrics.focusBorder
                    )
                    .padding(DesignMetrics.focusBorderInset - DesignMetrics.hairline)
            }
            .frame(minHeight: semanticHeight)
            .contentShape(Rectangle())
            .disabled(!isEnabled)
    }

    private var input: some View {
        surfacedInput
            .submitLabel(submitLabel ?? .return)
            .onSubmit { onSubmit?() }
            .onChange(of: text) { _, value in onChange?(value) }
            .textInputAutocapitalization(autocapitalization ?? .sentences)
            .autocorrectionDisabled(autocorrectionDisabled)
            .accessibilityLabel(accessibilityLabel ?? title)
            .accessibilityValue(fieldAccessibilityValue)
            .accessibilityHint(fieldAccessibilityHint)
            .accessibilityIdentifier(accessibilityId ?? "")
    }

    private var fieldAccessibilityValue: String {
        if !isEnabled { return "Disabled" }
        if let error { return "Error: \(error)" }
        return text.isEmpty ? "Empty" : text
    }

    private var fieldAccessibilityHint: String {
        if !isEnabled { return "Disabled" }
        if let error { return "Error: \(error)" }
        return ""
    }
}

struct DesignSecureField: View {
    let title: String
    var prompt: String = ""
    @Binding var text: String
    var error: String? = nil
    var accessibilityId: String? = nil
    var isEnabled = true
    @State private var revealed = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(title)
                .font(Typo.ui(DesignMetrics.controlLabelSize, .medium))
                .foregroundStyle(DuskColors.ink)
            HStack(spacing: Space.sm) {
                Group {
                    if revealed { TextField(prompt, text: $text) }
                    else { SecureField(prompt, text: $text) }
                }
                .font(Typo.ui(TypeScale.base))
                .textFieldStyle(.plain)
                .focused($focused)
                .disabled(!isEnabled)
                .accessibilityLabel(title)
                .accessibilityValue(Self.accessibilityValue(text: text, isEnabled: isEnabled, error: error, revealed: revealed))
                .accessibilityHint(!isEnabled ? "Disabled" : (revealed ? "Value is visible" : "Value is hidden"))
                .accessibilityIdentifier(accessibilityId ?? "")
                DesignIconButton(
                    systemName: revealed ? "eye.slash" : "eye",
                    label: revealed ? "Hide value" : "Show value",
                    state: isEnabled ? .normal : .disabled,
                    action: { revealed.toggle() }
                )
            }
            .padding(.leading, Space.md)
            .designWell(focused: focused, error: error != nil)
            if let error {
                designFieldError(message: error, accessibilityId: accessibilityId.map { "\($0)-error" })
            }
        }
    }

    /// Keeps hidden credentials content-free to assistive technologies. A raw
    /// value is returned only while the user has explicitly enabled reveal.
    static func accessibilityValue(text: String, isEnabled: Bool, error: String?, revealed: Bool) -> String {
        guard isEnabled else { return "Disabled" }
        if let error { return "Error: \(error)" }
        if text.isEmpty { return "Empty" }
        return revealed ? text : "Value entered"
    }
}

/// Secure entry that never offers a reveal action. Use for PINs and write-only
/// credentials whose raw value must not return to display.
struct DesignMaskedField: View {
    let title: String
    var prompt: String = ""
    @Binding var text: String
    var error: String? = nil
    var accessibilityId: String? = nil
    var keyboard: UIKeyboardType = .default
    var autoFocus = false
    var isEnabled = true
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(title)
                .font(Typo.ui(DesignMetrics.controlLabelSize, .medium))
                .foregroundStyle(DuskColors.ink)
            SecureField(prompt, text: $text)
                .font(Typo.ui(TypeScale.base))
                .textFieldStyle(.plain)
                .keyboardType(keyboard)
                .padding(.horizontal, Space.md)
                .frame(minHeight: DesignMetrics.minimumTarget)
                .designWell(focused: focused, error: error != nil)
                .focused($focused)
                .disabled(!isEnabled)
                .accessibilityLabel(title)
                .accessibilityValue(!isEnabled ? "Disabled" : error.map { "Error: \($0)" } ?? (text.isEmpty ? "Empty" : "Value entered"))
                .accessibilityHint(!isEnabled ? "Disabled" : (error.map { "Error: \($0)" } ?? "Value is hidden"))
                .accessibilityIdentifier(accessibilityId ?? "")
            if let error {
                designFieldError(message: error, accessibilityId: accessibilityId.map { "\($0)-error" })
            }
        }
        .task { if autoFocus { focused = true } }
    }
}

private enum DesignMultilineEditorMetrics {
    // `.snt-field` uses a seven-point label-to-control grid gap and inherits
    // the foundation's normal line-height for its label.
    static let labelGap: CGFloat = 7
    static let labelLineHeight = DesignMetrics.controlLabelSize * CGFloat(DesignV2.Typography.lineNormal)
    // The native text container supplies the remaining vertical inset.
    static let editorVerticalInset: CGFloat = 3
}

struct DesignMultilineEditor: View {
    let title: String?
    @Binding var text: String
    var placeholder: String? = nil
    var maxLength: Int? = nil
    var error: String? = nil
    var accessibilityId: String? = nil
    var isEnabled = true
    /// Callers may own focus when a flow needs to move focus explicitly;
    /// otherwise the editor keeps its own native FocusState.
    var focused: FocusState<Bool>.Binding? = nil
    @Environment(\.colorSchemeContrast) private var contrast
    /// Text areas use the UI face by default; mono remains available to the
    /// compatibility editor used for system-style text.
    var usesMonospacedText = false
    @FocusState private var internalFocused: Bool

    init(
        title: String? = nil,
        text: Binding<String>,
        placeholder: String? = nil,
        maxLength: Int? = nil,
        error: String? = nil,
        accessibilityId: String? = nil,
        isEnabled: Bool = true,
        usesMonospacedText: Bool = false,
        focused: FocusState<Bool>.Binding? = nil
    ) {
        self.title = title
        _text = text
        self.placeholder = placeholder
        self.maxLength = maxLength
        self.error = error
        self.accessibilityId = accessibilityId
        self.isEnabled = isEnabled
        self.usesMonospacedText = usesMonospacedText
        self.focused = focused
    }

    private var isFocused: Bool {
        focused?.wrappedValue ?? internalFocused
    }

    private var editorFont: Font {
        usesMonospacedText ? Typo.mono(TypeScale.sm) : Typo.ui(TypeScale.base)
    }

    private var wellBorderColor: Color {
        if error != nil { return DuskColors.stop }
        if isFocused {
            return DuskColors.accent.overlaying(
                DuskColors.line,
                opacity: DesignMaterialAdapter.wellFocusMix
            )
        }
        return contrast == .increased ? DuskColors.ink3 : DuskColors.line
    }

    private var editor: some View {
        TextEditor(text: cappedBinding)
            .font(editorFont)
            .foregroundStyle(DuskColors.ink)
            .scrollContentBackground(.hidden)
            // TextEditor supplies a native vertical text-container
            // inset; keep the explicit horizontal inset while using
            // half the shared inset vertically to match the authored
            // field padding without moving the native editor itself.
            .padding(.horizontal, DesignMetrics.editorInset)
            .padding(.vertical, DesignMultilineEditorMetrics.editorVerticalInset)
            .disabled(!isEnabled)
            .accessibilityLabel(title ?? "Text editor")
            .accessibilityValue(!isEnabled ? "Disabled" : error.map { "Error: \($0)" } ?? (text.isEmpty ? "Empty" : text))
            .accessibilityHint(!isEnabled ? "Disabled" : error.map { "Error: \($0)" } ?? "")
            .accessibilityIdentifier(accessibilityId ?? "")
    }

    @ViewBuilder
    private var focusableEditor: some View {
        if let focused {
            editor.focused(focused)
        } else {
            editor.focused($internalFocused)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DesignMultilineEditorMetrics.labelGap) {
            if let title {
                Text(title)
                    .font(Typo.ui(DesignMetrics.controlLabelSize, .medium))
                    .foregroundStyle(DuskColors.ink)
                    .frame(
                        minHeight: DesignMultilineEditorMetrics.labelLineHeight,
                        alignment: .topLeading
                    )
            }
            ZStack(alignment: .topLeading) {
                if text.isEmpty, let placeholder {
                    Text(placeholder)
                        .font(editorFont)
                        .foregroundStyle(DuskColors.ink4)
                        .padding(.horizontal, DesignMetrics.editorPlaceholderInsetH)
                        .padding(.vertical, DesignMetrics.editorPlaceholderInsetV)
                        .allowsHitTesting(false)
                }
                focusableEditor
            }
            // TextEditor has a larger intrinsic height than the foundation
            // field. Give the well its authored visual height and let the
            // native editor scroll when its content needs more room.
            .frame(height: DesignMetrics.multilineEditorMinHeight)
            // Keep the shared face, inset, and contact layers, but replace
            // its generic focus blur with the source's negative-spread cast.
            .designWell(
                focused: false,
                error: error != nil,
                showsBorder: false
            )
            .background {
                if isFocused {
                    DesignSpreadShadow(
                        shape: RoundedRectangle(cornerRadius: Radii.sm, style: .continuous),
                        color: DuskColors.accent.opacity(DesignMaterialAdapter.wellFocusCastOpacity),
                        geometry: DesignDropShadowGeometry(
                            radius: 18,
                            y: DesignMaterialAdapter.wellFocusCastY,
                            sourceInset: 14
                        )
                    )
                }
            }
            .overlay {
                if isFocused {
                    RoundedRectangle(cornerRadius: Radii.sm, style: .continuous)
                        .stroke(DuskColors.accent.opacity(0.18), lineWidth: 6)
                        .padding(-3)
                }
            }
            .overlay {
                RoundedRectangle(cornerRadius: Radii.sm, style: .continuous)
                    .strokeBorder(wellBorderColor, lineWidth: DesignMetrics.hairline)
                    .allowsHitTesting(false)
            }
            .overlay {
                RoundedRectangle(cornerRadius: Radii.sm + DesignMetrics.focusRing, style: .continuous)
                    .stroke(
                        isFocused ? DuskColors.accent : .clear,
                        lineWidth: DesignMetrics.focusBorder
                    )
                    .padding(DesignMetrics.focusBorderInset - DesignMetrics.hairline)
                    .allowsHitTesting(false)
            }
            if let maxLength {
                Text("\(text.count) / \(maxLength)")
                    .font(Typo.mono(TypeScale.xs))
                    .foregroundStyle(text.count >= maxLength ? DuskColors.stop : DuskColors.ink3)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .accessibilityLabel("\(text.count) of \(maxLength) characters")
                    .accessibilityIdentifier(accessibilityId.map { "\($0)-count" } ?? "")
            }
            if let error {
                designFieldError(message: error, accessibilityId: accessibilityId.map { "\($0)-error" })
            }
        }
    }

    private var cappedBinding: Binding<String> {
        Binding(
            get: { text },
            set: { newValue in
                guard let maxLength, newValue.count > maxLength else {
                    text = newValue
                    return
                }
                text = String(newValue.prefix(maxLength))
            }
        )
    }
}
