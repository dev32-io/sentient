import SwiftUI
import UIKit

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

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            if showsTitle {
                Text(title)
                    .font(Typo.ui(DesignMetrics.controlLabelSize, .medium))
                    .foregroundStyle(DuskColors.ink)
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
            .textFieldStyle(.plain)
            .padding(.horizontal, Space.md)
            .frame(minHeight: minimumHeight)
    }

    private var surfacedInput: some View {
        baseInput
            .lineLimit(lineLimit)
            .designWell(focused: isFocused, error: error != nil)
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

struct DesignMultilineEditor: View {
    let title: String?
    @Binding var text: String
    var placeholder: String? = nil
    var maxLength: Int? = nil
    var error: String? = nil
    var accessibilityId: String? = nil
    var isEnabled = true
    @FocusState private var focused: Bool

    init(
        title: String? = nil,
        text: Binding<String>,
        placeholder: String? = nil,
        maxLength: Int? = nil,
        error: String? = nil,
        accessibilityId: String? = nil,
        isEnabled: Bool = true
    ) {
        self.title = title
        _text = text
        self.placeholder = placeholder
        self.maxLength = maxLength
        self.error = error
        self.accessibilityId = accessibilityId
        self.isEnabled = isEnabled
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            if let title {
                Text(title)
                    .font(Typo.ui(DesignMetrics.controlLabelSize, .medium))
                    .foregroundStyle(DuskColors.ink)
            }
            ZStack(alignment: .topLeading) {
                if text.isEmpty, let placeholder {
                    Text(placeholder)
                        .font(Typo.mono(TypeScale.sm))
                        .foregroundStyle(DuskColors.ink4)
                        .padding(.horizontal, DesignMetrics.editorPlaceholderInsetH)
                        .padding(.vertical, DesignMetrics.editorPlaceholderInsetV)
                        .allowsHitTesting(false)
                }
                TextEditor(text: cappedBinding)
                    .font(Typo.mono(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink)
                    .scrollContentBackground(.hidden)
                    .padding(DesignMetrics.editorInset)
                    .disabled(!isEnabled)
                    .focused($focused)
                    .accessibilityLabel(title ?? "Text editor")
                    .accessibilityValue(!isEnabled ? "Disabled" : error.map { "Error: \($0)" } ?? (text.isEmpty ? "Empty" : text))
                    .accessibilityHint(!isEnabled ? "Disabled" : error.map { "Error: \($0)" } ?? "")
                    .accessibilityIdentifier(accessibilityId ?? "")
            }
            .frame(minHeight: DesignMetrics.multilineEditorMinHeight)
            .designWell(focused: focused, error: error != nil)
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
