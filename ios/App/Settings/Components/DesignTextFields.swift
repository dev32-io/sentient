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

/// Projects only authority-approved, non-error native field states into the
/// decorative Canvas well. Error-present states deliberately return no
/// projection: generic field error/focus precedence has no reviewed authority,
/// so each wrapper keeps its complete legacy rendering branch instead of
/// mixing legacy and Canvas chrome in one state.
struct DesignTextFieldCanvasProjection: Equatable {
    let state: DesignCanvasWellState
    let increasedContrast: Bool
    let reduceMotion: Bool

    static func make(
        isEnabled: Bool,
        isFocused: Bool,
        hasError: Bool,
        increasedContrast: Bool,
        reduceMotion: Bool
    ) -> DesignTextFieldCanvasProjection? {
        guard !hasError else { return nil }
        return DesignTextFieldCanvasProjection(
            state: DesignCanvasWellState(
                isFocused: isFocused,
                isDisabled: !isEnabled
            ),
            increasedContrast: increasedContrast,
            reduceMotion: reduceMotion
        )
    }
}

/// Background-only adapter. Native TextField, SecureField, and TextEditor
/// views continue to own content, focus, keyboard, selection, hit testing, and
/// accessibility; this view paints only the measured face behind them.
private struct DesignTextFieldCanvasBackground: View {
    let isEnabled: Bool
    let isFocused: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast

    @ViewBuilder
    var body: some View {
        if let projection = DesignTextFieldCanvasProjection.make(
            isEnabled: isEnabled,
            isFocused: isFocused,
            hasError: false,
            increasedContrast: contrast == .increased,
            reduceMotion: reduceMotion
        ) {
            DesignCanvasWellKernel(
                shape: .roundedRectangle(cornerRadius: Radii.sm),
                state: projection.state,
                increasedContrast: projection.increasedContrast,
                reduceMotion: projection.reduceMotion
            )
            .animation(
                DesignCanvasWellKernel.transitionAnimation(
                    for: .focus,
                    reduceMotion: projection.reduceMotion
                ),
                value: projection.state.isFocused
            )
            .animation(
                DesignCanvasWellKernel.transitionAnimation(
                    for: .material,
                    reduceMotion: projection.reduceMotion
                ),
                value: projection.state.isDisabled
            )
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }
}

/// Canvas error well mounted behind a stable native editor. Error transitions
/// therefore change only decorative state, never responder or selection identity.
private struct DesignTextFieldErrorCanvasBackground: View {
    let focused: Bool

    var body: some View {
        Color.clear
            .designWell(focused: focused, error: true)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
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
            // Keep native content clipped to the authored face without
            // clipping Canvas focus overflow mounted by the later background.
            .clipShape(RoundedRectangle(cornerRadius: Radii.sm, style: .continuous))
            .background {
                if error != nil {
                    DesignTextFieldErrorCanvasBackground(focused: isFocused)
                } else {
                    DesignTextFieldCanvasBackground(
                        isEnabled: isEnabled,
                        isFocused: isFocused
                    )
                }
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
    @State private var restoreFocusAfterReveal = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(title)
                .font(Typo.ui(DesignMetrics.controlLabelSize, .medium))
                .foregroundStyle(DuskColors.ink)
            surfacedContent
            if let error {
                designFieldError(message: error, accessibilityId: accessibilityId.map { "\($0)-error" })
            }
        }
    }

    private var nativeContent: some View {
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
            .accessibilityValue(fieldAccessibilityValue)
            .accessibilityHint(!isEnabled ? "Disabled" : (revealed ? "Value is visible" : "Value is hidden"))
            .accessibilityIdentifier(accessibilityId ?? "")
            DesignIconButton(
                systemName: revealed ? "eye.slash" : "eye",
                label: revealed ? "Hide value" : "Show value",
                state: isEnabled ? .normal : .disabled,
                accessibilityId: accessibilityId.map { "\($0)-reveal" },
                action: toggleReveal
            )
        }
        .padding(.leading, Space.md)
        // This is the clip formerly supplied by the legacy well modifier.
        // It is stable across reveal and error transitions.
        .clipShape(RoundedRectangle(cornerRadius: Radii.sm, style: .continuous))
        .task(id: revealed) {
            guard restoreFocusAfterReveal else { return }
            await Task.yield()
            guard isEnabled else {
                restoreFocusAfterReveal = false
                return
            }
            focused = true
            restoreFocusAfterReveal = false
        }
    }

    private var surfacedContent: some View {
        nativeContent
            .background {
                if error != nil {
                    // Authority-gated compatibility exception: retain the
                    // complete legacy error/focus chrome with no Canvas layer.
                    DesignTextFieldErrorCanvasBackground(focused: focused)
                } else {
                    DesignTextFieldCanvasBackground(
                        isEnabled: isEnabled,
                        isFocused: focused
                    )
                }
            }
    }

    private func toggleReveal() {
        let shouldRestoreFocus = focused && isEnabled
        if shouldRestoreFocus {
            restoreFocusAfterReveal = true
            focused = false
        }
        revealed.toggle()
    }

    private var fieldAccessibilityValue: String {
        Self.accessibilityValue(
            text: text,
            isEnabled: isEnabled,
            error: error,
            revealed: revealed
        )
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
            focusableField
            if let error {
                designFieldError(message: error, accessibilityId: accessibilityId.map { "\($0)-error" })
            }
        }
        .task { if autoFocus { focused = true } }
    }

    private var nativeField: some View {
        SecureField(prompt, text: $text)
            .font(Typo.ui(TypeScale.base))
            .textFieldStyle(.plain)
            .keyboardType(keyboard)
            .padding(.horizontal, Space.md)
            .frame(minHeight: DesignMetrics.minimumTarget)
            .clipShape(RoundedRectangle(cornerRadius: Radii.sm, style: .continuous))
    }

    private var surfacedField: some View {
        nativeField
            .background {
                if error != nil {
                    // Authority-gated compatibility exception: retain the
                    // complete legacy error/focus chrome with no Canvas layer.
                    DesignTextFieldErrorCanvasBackground(focused: focused)
                } else {
                    DesignTextFieldCanvasBackground(
                        isEnabled: isEnabled,
                        isFocused: focused
                    )
                }
            }
    }

    private var focusableField: some View {
        surfacedField
            .focused($focused)
            .disabled(!isEnabled)
            .accessibilityLabel(title)
            .accessibilityValue(Self.accessibilityValue(
                text: text,
                isEnabled: isEnabled,
                error: error
            ))
            .accessibilityHint(!isEnabled ? "Disabled" : (error.map { "Error: \($0)" } ?? "Value is hidden"))
            .accessibilityIdentifier(accessibilityId ?? "")
    }

    /// Write-only fields never expose entered content through accessibility.
    static func accessibilityValue(text: String, isEnabled: Bool, error: String?) -> String {
        guard isEnabled else { return "Disabled" }
        if let error { return "Error: \(error)" }
        return text.isEmpty ? "Empty" : "Value entered"
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
            surfacedEditor
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
        .onChange(of: isFocused) { _, focused in
            if focused, !isEnabled { setFocus(false) }
        }
    }

    private var nativeEditorContent: some View {
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
        // TextEditor has a larger intrinsic height than the foundation field.
        // Keep its authored face height and native scrolling behavior.
        .frame(height: DesignMetrics.multilineEditorMinHeight)
    }

    private var surfacedEditor: some View {
        nativeEditorContent
            .clipShape(RoundedRectangle(cornerRadius: Radii.sm, style: .continuous))
            .background {
                if error != nil {
                    DesignTextFieldErrorCanvasBackground(focused: isFocused)
                } else {
                    DesignTextFieldCanvasBackground(
                        isEnabled: isEnabled,
                        isFocused: isFocused
                    )
                }
            }
    }

    private func setFocus(_ value: Bool) {
        if let focused {
            focused.wrappedValue = value
        } else {
            internalFocused = value
        }
    }

    private var cappedBinding: Binding<String> {
        Binding(
            get: { text },
            set: { newValue in
                guard isEnabled else { return }
                text = Self.cappedText(newValue, maxLength: maxLength)
            }
        )
    }

    static func cappedText(_ text: String, maxLength: Int?) -> String {
        guard let maxLength, text.count > maxLength else { return text }
        return String(text.prefix(maxLength))
    }
}
