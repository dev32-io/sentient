import SwiftUI
import UIKit

/// Shared semantic state for controls. The visual primitive owns how a state is
/// drawn; the state also supplies the VoiceOver value so disabled, loading,
/// error, selected, and on states cannot drift between controls.
enum DesignControlState: Equatable {
    case normal
    case loading
    case error(String)
    case selected
    case on
    case disabled

    var isInteractive: Bool {
        switch self {
        case .normal, .selected, .on: true
        case .loading, .error, .disabled: false
        }
    }

    var accessibilityValue: String {
        switch self {
        case .normal: "Ready"
        case .loading: "In progress"
        case .error(let message): "Error: \(message)"
        case .selected: "Selected"
        case .on: "On"
        case .disabled: "Disabled"
        }
    }

    var isSelected: Bool {
        switch self {
        case .selected, .on: true
        case .normal, .loading, .error, .disabled: false
        }
    }
}

enum DesignButtonRole { case action, destructive, quiet }

enum DesignNoticeKind { case loading, empty, error, success, warning }

private struct SlateFace: View {
    let role: DesignButtonRole
    let muted: Bool

    private var base: Color {
        if muted { return DuskColors.bgElev }
        switch role {
        case .action: return DuskColors.accent
        case .destructive: return DuskColors.paper
        case .quiet: return DuskColors.bgElev
        }
    }

    var body: some View {
        ZStack {
            base
            if role == .destructive && !muted { DuskColors.stop.opacity(DesignMaterialAdapter.slateDestructiveOverlay) }
            if muted { DuskColors.ink4.opacity(DesignMaterialAdapter.slateMutedInk) }
            LinearGradient(colors: [DuskColors.ink.opacity(muted ? DesignMaterialAdapter.slateMutedBaseLight : DesignMaterialAdapter.slateBaseLight), .clear], startPoint: .top, endPoint: .bottom)
            RadialGradient(
                stops: [
                    .init(color: DuskColors.bgSunk.opacity(muted ? DesignMaterialAdapter.slateMutedCenterSunk : DesignMaterialAdapter.slateCenterSunk), location: DesignMaterialAdapter.slateRadialStartRadius),
                    .init(color: DuskColors.bgSunk.opacity(DesignMaterialAdapter.slateRingSunk), location: DesignMaterialAdapter.slateCenterStop),
                    .init(color: .clear, location: muted ? DesignMaterialAdapter.slateMutedFadeStop : DesignMaterialAdapter.slateFadeStop),
                ],
                center: UnitPoint(x: DesignMaterialAdapter.slateRadialCenterX, y: DesignMaterialAdapter.slateRadialCenterY),
                startRadius: DesignMaterialAdapter.slateRadialStartRadius,
                endRadius: DesignMaterialAdapter.slateRadialEndRadius
            )
            .scaleEffect(x: DesignMaterialAdapter.slateRadialScale.width, y: DesignMaterialAdapter.slateRadialScale.height)
        }
    }
}

private struct PlateSurface: ViewModifier {
    @Environment(\.colorSchemeContrast) private var contrast
    let elevated: Bool

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: Radii.md, style: .continuous)
        content
            .background(DuskColors.paper)
            .clipShape(shape)
            .overlay { shape.stroke(contrast == .increased ? DuskColors.ink3 : DuskColors.lineSoft, lineWidth: DesignMetrics.hairline) }
            .overlay(alignment: .top) { DuskColors.ink.opacity(contrast == .increased ? DesignMaterialAdapter.slateElevatedTopLight : DesignMaterialAdapter.slateTopLightOpacity).frame(height: DesignMetrics.hairline).clipShape(shape) }
            .shadow(color: DuskColors.line.opacity(elevated ? DesignMaterialAdapter.slateElevatedContact : DesignMaterialAdapter.plateContactOpacity), radius: 0, y: elevated ? DesignMaterialAdapter.slateElevatedContactY : DesignMaterialAdapter.slateRestContactY)
            .shadow(
                color: .black.opacity(elevated ? DesignMaterialAdapter.slateElevatedBlack : DesignMaterialAdapter.slateRestBlack),
                radius: elevated ? DesignMaterialAdapter.floatCastBlur : DesignMaterialAdapter.plateCastBlur,
                y: elevated ? DesignMaterialAdapter.floatCastY : DesignMaterialAdapter.plateCastY
            )
            .shadow(
                color: DuskColors.accent.opacity(elevated ? DesignMaterialAdapter.slateElevatedEmber : DesignMaterialAdapter.slateNoEmber),
                radius: elevated ? DesignMaterialAdapter.floatEmberBlur : 0,
                y: elevated ? DesignMaterialAdapter.floatEmberY : 0
            )
    }
}

private struct WellSurface: ViewModifier {
    @Environment(\.colorSchemeContrast) private var contrast
    let focused: Bool
    let error: Bool

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: Radii.sm, style: .continuous)
        content
            .background(
                LinearGradient(
                    stops: [
                        .init(color: DuskColors.bgSunk.overlaying(.black, opacity: DesignMaterialAdapter.wellTopBlack), location: 0),
                        .init(color: DuskColors.bgSunk, location: DesignMaterialAdapter.wellMiddleStop),
                        .init(color: DuskColors.bgSunk.overlaying(DuskColors.bgElev, opacity: DesignMaterialAdapter.wellBottomElevated), location: 1),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
            .clipShape(shape)
            .overlay(alignment: .top) {
                LinearGradient(
                    colors: [.black.opacity(focused ? DesignMaterialAdapter.wellInsetFocusOpacity : DesignMaterialAdapter.wellInsetOpacity), .clear],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .frame(height: DesignMaterialAdapter.wellInsetHeight)
                .clipShape(shape)
            }
            .overlay(alignment: .bottom) {
                DuskColors.ink.opacity(focused ? DesignMaterialAdapter.wellBottomHighlightFocused : DesignMaterialAdapter.wellBottomHighlight)
                    .frame(height: DesignMetrics.hairline)
                    .clipShape(shape)
            }
            .overlay {
                shape.stroke(
                    error
                        ? DuskColors.stop
                        : focused
                            ? DuskColors.accent.overlaying(DuskColors.line, opacity: DesignMaterialAdapter.wellFocusMix)
                            : (contrast == .increased ? DuskColors.ink3 : DuskColors.line),
                    lineWidth: DesignMetrics.hairline
                )
            }
            .shadow(color: DuskColors.line.opacity(DesignMaterialAdapter.wellLineOpacity), radius: 0, y: 1)
            .shadow(color: focused ? DuskColors.accent.opacity(DesignMaterialAdapter.wellFocusRingOpacity) : .clear, radius: DesignMetrics.focusRing)
            .shadow(
                color: focused ? DuskColors.accent.opacity(DesignMaterialAdapter.wellFocusCastOpacity) : .clear,
                radius: DesignMaterialAdapter.wellFocusCastBlur,
                y: DesignMaterialAdapter.wellFocusCastY
            )
    }
}

private extension Color {
    /// Alpha-composite helper used to express the contract's color-mix weights natively.
    func overlaying(_ overlay: Color, opacity: Double) -> Color {
        UIColor(self).mixed(with: UIColor(overlay), overlayWeight: opacity).swiftUIColor
    }
}

private extension UIColor {
    func mixed(with other: UIColor, overlayWeight: Double) -> UIColor {
        var r1: CGFloat = 0; var g1: CGFloat = 0; var b1: CGFloat = 0; var a1: CGFloat = 0
        var r2: CGFloat = 0; var g2: CGFloat = 0; var b2: CGFloat = 0; var a2: CGFloat = 0
        getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
        other.getRed(&r2, green: &g2, blue: &b2, alpha: &a2)
        let weight = CGFloat(overlayWeight)
        return UIColor(
            red: r1 * (1 - weight) + r2 * weight,
            green: g1 * (1 - weight) + g2 * weight,
            blue: b1 * (1 - weight) + b2 * weight,
            alpha: a1 * (1 - weight) + a2 * weight
        )
    }

    var swiftUIColor: Color { Color(self) }
}

extension View {
    func designPlate(elevated: Bool = false) -> some View { modifier(PlateSurface(elevated: elevated)) }
    func designFloat() -> some View { modifier(PlateSurface(elevated: true)) }
    func designWell(focused: Bool = false, error: Bool = false) -> some View { modifier(WellSurface(focused: focused, error: error)) }
}

struct DesignButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.isFocused) private var focused
    let role: DesignButtonRole

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed && isEnabled
        let shape = RoundedRectangle(cornerRadius: Radii.sm, style: .continuous)
        configuration.label
            .font(Typo.ui(TypeScale.base, .semibold))
            .foregroundStyle(foreground)
            .frame(minHeight: DesignMetrics.minimumTarget)
            .padding(.horizontal, Space.lg)
            .background { SlateFace(role: role, muted: !isEnabled) }
            .clipShape(shape)
            .overlay(alignment: .top) {
                (pressed ? DuskColors.bgSunk.opacity(DesignMaterialAdapter.slatePressedTop) : DuskColors.ink.opacity(contrast == .increased ? DesignMaterialAdapter.slateTopLightContrast : DesignMaterialAdapter.slateTopLight))
                    .frame(height: pressed ? 3 : DesignMetrics.hairline)
                    .clipShape(shape)
            }
            .overlay { shape.stroke(border, lineWidth: DesignMetrics.hairline) }
            .overlay { shape.stroke(focused ? DuskColors.accent : .clear, lineWidth: DesignMetrics.focusBorder).padding(DesignMetrics.focusBorderInset) }
            .shadow(color: contact(pressed: pressed), radius: 0, y: pressed ? 1 : DesignMaterialAdapter.slateContactY)
            .shadow(
                color: .black.opacity(isEnabled ? (pressed ? DesignMaterialAdapter.slatePressedBlack : DesignMaterialAdapter.slateRestBlack) : DesignMaterialAdapter.slateDisabledBlack),
                radius: pressed ? DesignMaterialAdapter.slatePressedShadowRadius : DesignMaterialAdapter.slateCastBlur,
                y: pressed ? DesignMaterialAdapter.slatePressedShadowY : DesignMaterialAdapter.slateCastY
            )
            .shadow(
                color: glow.opacity(isEnabled && !pressed ? (role == .action ? DesignMaterialAdapter.slateActionGlow : role == .destructive ? DesignMaterialAdapter.slateDestructiveGlow : DesignMaterialAdapter.slateQuietGlow) : 0),
                radius: DesignMaterialAdapter.slateEmberBlur,
                y: DesignMaterialAdapter.slateEmberY
            )
            .offset(y: pressed ? DesignMetrics.pressedDepth : 0)
            .animation(DesignV2.Motion.animation(duration: DesignV2.Motion.feedback, reduceMotion: reduceMotion), value: pressed)
    }

    private var foreground: Color {
        if !isEnabled { return DuskColors.ink4 }
        return role == .action ? DuskColors.bgSunk : role == .quiet ? DuskColors.ink2 : DuskColors.ink
    }

    private var border: Color {
        if !isEnabled { return DuskColors.lineSoft.opacity(DesignMaterialAdapter.slateDisabledBorder) }
        return role == .destructive ? DuskColors.stop.opacity(DesignMaterialAdapter.slateDestructiveBorder) : role == .action ? DuskColors.accent.opacity(DesignMaterialAdapter.slateActionBorder) : DuskColors.line
    }

    private var glow: Color { role == .destructive ? DuskColors.stop : DuskColors.accent }

    private func contact(pressed: Bool) -> Color {
        if role == .destructive {
            return DuskColors.stop.opacity(pressed ? DesignMaterialAdapter.slateDestructivePressedContact : DesignMaterialAdapter.slateDestructiveContact)
        }
        return DuskColors.bgSunk.opacity(pressed ? DesignMaterialAdapter.slatePressedContactOpacity : DesignMaterialAdapter.slateContactOpacity)
    }
}

struct DesignActionButton: View {
    let title: String
    var role: DesignButtonRole = .action
    var state: DesignControlState = .normal
    var accessibilityId: String? = nil
    var fillsWidth = true
    let action: () -> Void

    var body: some View {
        Button(role: role == .destructive ? .destructive : nil, action: action) {
            HStack(spacing: Space.sm) {
                if state == .loading { ProgressView().controlSize(.small) }
                Text(state == .loading ? "Loading" : title)
                    .frame(maxWidth: fillsWidth ? .infinity : nil)
            }
        }
        .buttonStyle(DesignButtonStyle(role: role))
        .disabled(!state.isInteractive)
        .accessibilityLabel(title)
        .accessibilityValue(state.accessibilityValue)
        .accessibilityIdentifier(accessibilityId ?? "")
        .accessibilityAddTraits(state.isSelected ? .isSelected : [])
    }
}

struct DesignIconButton: View {
    let systemName: String
    let label: String
    var role: DesignButtonRole = .quiet
    var state: DesignControlState = .normal
    var accessibilityId: String? = nil
    let action: () -> Void

    var body: some View {
        Button(role: role == .destructive ? .destructive : nil, action: action) {
            Image(systemName: systemName)
                .frame(width: DesignMetrics.minimumTarget, height: DesignMetrics.minimumTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(DesignButtonStyle(role: role))
        .disabled(!state.isInteractive)
        .accessibilityLabel(label)
        .accessibilityValue(state.accessibilityValue)
        .accessibilityIdentifier(accessibilityId ?? "")
        .accessibilityAddTraits(state.isSelected ? .isSelected : [])
    }
}

/// Plain, minimum-target actions for compact product controls. The primitive
/// owns press motion and state semantics while callers supply only the
/// product-specific label composition.
struct DesignCompactButton<Label: View>: View {
    let accessibilityLabel: String
    var state: DesignControlState = .normal
    var isEnabled = true
    var accessibilityId: String? = nil
    var minimumWidth: CGFloat? = nil
    var minimumHeight: CGFloat = DesignMetrics.minimumTarget
    var pressedScale: CGFloat = 0.985
    let action: () -> Void
    @ViewBuilder let label: () -> Label

    init(
        accessibilityLabel: String,
        state: DesignControlState = .normal,
        isEnabled: Bool = true,
        accessibilityId: String? = nil,
        minimumWidth: CGFloat? = nil,
        minimumHeight: CGFloat = DesignMetrics.minimumTarget,
        pressedScale: CGFloat = 0.985,
        action: @escaping () -> Void,
        @ViewBuilder label: @escaping () -> Label
    ) {
        self.accessibilityLabel = accessibilityLabel
        self.state = state
        self.isEnabled = isEnabled
        self.accessibilityId = accessibilityId
        self.minimumWidth = minimumWidth
        self.minimumHeight = minimumHeight
        self.pressedScale = pressedScale
        self.action = action
        self.label = label
    }

    private var effectiveState: DesignControlState {
        isEnabled ? state : .disabled
    }

    var body: some View {
        Button(action: action) {
            label()
                .frame(minWidth: minimumWidth, minHeight: minimumHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(DesignCompactButtonStyle(pressedScale: pressedScale))
        .disabled(!effectiveState.isInteractive)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(effectiveState.accessibilityValue)
        .accessibilityIdentifier(accessibilityId ?? "")
        .accessibilityAddTraits(effectiveState.isSelected ? .isSelected : [])
    }
}

/// The compact icon action used for close, clear, and navigation affordances.
struct DesignCompactIconButton: View {
    let systemName: String
    let label: String
    var state: DesignControlState = .normal
    var isEnabled = true
    var accessibilityId: String? = nil
    var pressedScale: CGFloat = 0.985
    let action: () -> Void

    var body: some View {
        DesignCompactButton(
            accessibilityLabel: label,
            state: state,
            isEnabled: isEnabled,
            accessibilityId: accessibilityId,
            minimumWidth: DesignMetrics.minimumTarget,
            minimumHeight: DesignMetrics.minimumTarget,
            pressedScale: pressedScale,
            action: action
        ) {
            Image(systemName: systemName)
                .font(Typo.ui(TypeScale.base, .semibold))
                .frame(width: DesignMetrics.minimumTarget, height: DesignMetrics.minimumTarget)
        }
    }
}

/// Selection semantics for compact filters and segmented-looking product
/// controls. The label remains product-owned so Calendar can retain its
/// existing geometry while the button, state, target, and accessibility stay
/// centralized.
struct DesignSelectableButton<Label: View>: View {
    let accessibilityLabel: String
    let state: DesignControlState
    var isEnabled = true
    var accessibilityId: String? = nil
    var minimumWidth: CGFloat? = nil
    var minimumHeight: CGFloat = DesignMetrics.minimumTarget
    var pressedScale: CGFloat = 0.985
    let action: () -> Void
    @ViewBuilder let label: () -> Label

    init(
        accessibilityLabel: String,
        state: DesignControlState,
        isEnabled: Bool = true,
        accessibilityId: String? = nil,
        minimumWidth: CGFloat? = nil,
        minimumHeight: CGFloat = DesignMetrics.minimumTarget,
        pressedScale: CGFloat = 0.985,
        action: @escaping () -> Void,
        @ViewBuilder label: @escaping () -> Label
    ) {
        self.accessibilityLabel = accessibilityLabel
        self.state = state
        self.isEnabled = isEnabled
        self.accessibilityId = accessibilityId
        self.minimumWidth = minimumWidth
        self.minimumHeight = minimumHeight
        self.pressedScale = pressedScale
        self.action = action
        self.label = label
    }

    private var effectiveState: DesignControlState {
        isEnabled ? state : .disabled
    }

    private var selectionValue: String {
        switch effectiveState {
        case .normal: "Not selected"
        default: effectiveState.accessibilityValue
        }
    }

    var body: some View {
        Button(action: action) {
            label()
                .frame(minWidth: minimumWidth, minHeight: minimumHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(DesignCompactButtonStyle(pressedScale: pressedScale))
        .disabled(!effectiveState.isInteractive)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(selectionValue)
        .accessibilityIdentifier(accessibilityId ?? "")
        .accessibilityAddTraits(effectiveState.isSelected ? .isSelected : [])
    }
}

struct DesignCompactButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let pressedScale: CGFloat

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && isEnabled && !reduceMotion ? pressedScale : 1)
            .opacity(isEnabled ? 1 : DesignMaterialAdapter.selectDisabledOpacity)
            .animation(
                DesignV2.Motion.animation(duration: DesignV2.Motion.feedback, reduceMotion: reduceMotion),
                value: configuration.isPressed
            )
    }
}

private struct DesignFieldError: View {
    let message: String
    let accessibilityId: String?

    var body: some View {
        Label(message, systemImage: "exclamationmark.circle.fill")
            .font(Typo.ui(TypeScale.sm))
            .foregroundStyle(DuskColors.stop)
            .accessibilityLabel("Error: \(message)")
            .accessibilityIdentifier(accessibilityId ?? "")
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

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            if showsTitle {
                Text(title)
                    .font(Typo.ui(TypeScale.base, .medium))
                    .foregroundStyle(DuskColors.ink)
            }
            focusableField
            if let error {
                DesignFieldError(message: error, accessibilityId: accessibilityId.map { "\($0)-error" })
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
                .font(Typo.ui(TypeScale.base, .medium))
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
                .accessibilityValue(!isEnabled ? "Disabled" : error.map { "Error: \($0)" } ?? (text.isEmpty ? "Empty" : text))
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
                DesignFieldError(message: error, accessibilityId: accessibilityId.map { "\($0)-error" })
            }
        }
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
                .font(Typo.ui(TypeScale.base, .medium))
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
                DesignFieldError(message: error, accessibilityId: accessibilityId.map { "\($0)-error" })
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
                    .font(Typo.ui(TypeScale.base, .medium))
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
                DesignFieldError(message: error, accessibilityId: accessibilityId.map { "\($0)-error" })
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

struct DesignToggleSwitch: View {
    let label: String
    @Binding var isOn: Bool
    var accessibilityId: String? = nil
    var isEnabled = true

    var body: some View {
        Toggle(label, isOn: $isOn)
            .labelsHidden()
            .tint(DuskColors.accent)
            .disabled(!isEnabled)
            .frame(minHeight: DesignMetrics.minimumTarget)
            .accessibilityLabel(label)
            .accessibilityValue(isEnabled ? (isOn ? "On" : "Off") : "Disabled")
            .accessibilityIdentifier(accessibilityId ?? "")
    }
}

struct DesignToggleRow: View {
    let title: String
    var detail: String? = nil
    @Binding var isOn: Bool
    var accessibilityId: String? = nil
    var isEnabled = true

    var body: some View {
        Toggle(isOn: $isOn) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(title).font(Typo.ui(TypeScale.base, .medium))
                if let detail { Text(detail).font(Typo.ui(TypeScale.sm)).foregroundStyle(DuskColors.ink3) }
            }
        }
        .tint(DuskColors.accent)
        .disabled(!isEnabled)
        .frame(minHeight: DesignMetrics.minimumTarget)
        .accessibilityLabel(title)
        .accessibilityValue(isEnabled ? (isOn ? "On" : "Off") : "Disabled")
        .accessibilityHint(detail ?? "")
        .accessibilityIdentifier(accessibilityId ?? "")
    }
}

struct DesignSegmentedPicker<Value: Hashable>: View {
    let title: String
    let options: [(value: Value, label: String)]
    @Binding var selection: Value
    var accessibilityId: String? = nil
    var isEnabled = true

    init(
        title: String,
        options: [(value: Value, label: String)],
        selection: Binding<Value>,
        accessibilityId: String? = nil,
        isEnabled: Bool = true
    ) {
        self.title = title
        self.options = options
        _selection = selection
        self.accessibilityId = accessibilityId
        self.isEnabled = isEnabled
    }

    var body: some View {
        Picker(title, selection: $selection) {
            ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                Text(option.label).tag(option.value)
            }
        }
        .pickerStyle(.segmented)
        .disabled(!isEnabled)
        .frame(minHeight: DesignMetrics.minimumTarget)
        .accessibilityLabel(title)
        .accessibilityValue(isEnabled ? selectedLabel : "Disabled")
        .accessibilityIdentifier(accessibilityId ?? "")
    }

    private var selectedLabel: String {
        options.first(where: { $0.value == selection })?.label ?? "Not selected"
    }
}

private struct DesignStateAccessibilityModifier: ViewModifier {
    let state: DesignControlState

    @ViewBuilder
    func body(content: Content) -> some View {
        switch state {
        case .normal:
            content
        default:
            content.accessibilityValue(state.accessibilityValue)
        }
    }
}

/// Native date selection with shared state, error, target, and accessibility
/// semantics. The DatePicker itself remains SwiftUI-native so locale, calendar,
/// time-zone, Dynamic Type, and system editing behavior are untouched.
struct DesignDatePicker: View {
    let title: String
    @Binding var selection: Date
    var range: PartialRangeFrom<Date>? = nil
    let displayedComponents: DatePickerComponents
    var timeZone: TimeZone = .current
    var labelsHidden = false
    var error: String? = nil
    var state: DesignControlState = .normal
    var isEnabled = true
    var accessibilityId: String? = nil
    var minimumHeight: CGFloat = DesignMetrics.minimumTarget

    init(
        title: String,
        selection: Binding<Date>,
        range: PartialRangeFrom<Date>? = nil,
        displayedComponents: DatePickerComponents,
        timeZone: TimeZone = .current,
        labelsHidden: Bool = false,
        error: String? = nil,
        state: DesignControlState = .normal,
        isEnabled: Bool = true,
        accessibilityId: String? = nil,
        minimumHeight: CGFloat = DesignMetrics.minimumTarget
    ) {
        self.title = title
        _selection = selection
        self.range = range
        self.displayedComponents = displayedComponents
        self.timeZone = timeZone
        self.labelsHidden = labelsHidden
        self.error = error
        self.state = state
        self.isEnabled = isEnabled
        self.accessibilityId = accessibilityId
        self.minimumHeight = minimumHeight
    }

    private var effectiveState: DesignControlState {
        if !isEnabled { return .disabled }
        if let error { return .error(error) }
        return state
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            picker
                .environment(\.timeZone, timeZone)
                .disabled(!effectiveState.isInteractive)
                .frame(minHeight: minimumHeight)
                .accessibilityLabel(title)
                .accessibilityHint(accessibilityHint)
                .accessibilityIdentifier(accessibilityId ?? "")
                .accessibilityAddTraits(effectiveState.isSelected ? .isSelected : [])
                .modifier(DesignStateAccessibilityModifier(state: effectiveState))
            if let error {
                DesignFieldError(message: error, accessibilityId: accessibilityId.map { "\($0)-error" })
            }
        }
    }

    private var accessibilityHint: String {
        switch effectiveState {
        case .error(let message): "Error: \(message)"
        case .disabled: "Disabled"
        default: ""
        }
    }

    @ViewBuilder
    private var picker: some View {
        if let range {
            if labelsHidden {
                DatePicker(title, selection: $selection, in: range, displayedComponents: displayedComponents)
                    .labelsHidden()
            } else {
                DatePicker(title, selection: $selection, in: range, displayedComponents: displayedComponents)
            }
        } else if labelsHidden {
            DatePicker(title, selection: $selection, displayedComponents: displayedComponents)
                .labelsHidden()
        } else {
            DatePicker(title, selection: $selection, displayedComponents: displayedComponents)
        }
    }
}

/// Native integer stepper with shared state, error, target, and accessibility
/// semantics. Callers retain ownership of value mapping and change handling.
struct DesignStepper: View {
    let title: String
    @Binding var value: Int
    let range: ClosedRange<Int>
    var error: String? = nil
    var state: DesignControlState = .normal
    var isEnabled = true
    var accessibilityId: String? = nil
    var valueDescription: (Int) -> String = { String($0) }

    init(
        title: String,
        value: Binding<Int>,
        range: ClosedRange<Int>,
        error: String? = nil,
        state: DesignControlState = .normal,
        isEnabled: Bool = true,
        accessibilityId: String? = nil,
        valueDescription: @escaping (Int) -> String = { String($0) }
    ) {
        self.title = title
        _value = value
        self.range = range
        self.error = error
        self.state = state
        self.isEnabled = isEnabled
        self.accessibilityId = accessibilityId
        self.valueDescription = valueDescription
    }

    private var effectiveState: DesignControlState {
        if !isEnabled { return .disabled }
        if let error { return .error(error) }
        return state
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Stepper(title, value: $value, in: range)
                .disabled(!effectiveState.isInteractive)
                .frame(minHeight: DesignMetrics.minimumTarget)
                .accessibilityLabel(title)
                .accessibilityValue(accessibilityValue)
                .accessibilityHint(accessibilityHint)
                .accessibilityIdentifier(accessibilityId ?? "")
                .accessibilityAddTraits(effectiveState.isSelected ? .isSelected : [])
            if let error {
                DesignFieldError(message: error, accessibilityId: accessibilityId.map { "\($0)-error" })
            }
        }
    }

    private var accessibilityValue: String {
        switch effectiveState {
        case .normal: valueDescription(value)
        default: effectiveState.accessibilityValue
        }
    }

    private var accessibilityHint: String {
        switch effectiveState {
        case .error(let message): "Error: \(message)"
        case .disabled: "Disabled"
        default: ""
        }
    }
}

struct DesignSelect<Value: Hashable>: View {
    let title: String
    var detail: String? = nil
    let options: [(value: Value, label: String)]
    @Binding var selection: Value
    var isEnabled = true
    var accessibilityId: String? = nil
    var optionAccessibilityId: ((Value) -> String)? = nil

    init(
        title: String,
        detail: String? = nil,
        options: [(value: Value, label: String)],
        selection: Binding<Value>,
        isEnabled: Bool = true,
        accessibilityId: String? = nil,
        optionAccessibilityId: ((Value) -> String)? = nil
    ) {
        self.title = title
        self.detail = detail
        self.options = options
        _selection = selection
        self.isEnabled = isEnabled
        self.accessibilityId = accessibilityId
        self.optionAccessibilityId = optionAccessibilityId
    }

    var body: some View {
        HStack(spacing: Space.lg) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(title)
                    .font(Typo.ui(TypeScale.base, .medium))
                    .foregroundStyle(DuskColors.ink)
                if let detail {
                    Text(detail)
                        .font(Typo.ui(TypeScale.xs))
                        .foregroundStyle(DuskColors.ink3)
                }
            }
            Spacer(minLength: Space.sm)
            Menu {
                ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                    Button {
                        selection = option.value
                    } label: {
                        if option.value == selection {
                            Label(option.label, systemImage: "checkmark")
                        } else {
                            Text(option.label)
                        }
                    }
                    .accessibilityIdentifier(optionAccessibilityId?(option.value) ?? "")
                }
            } label: {
                HStack(spacing: Space.xs) {
                    Text(currentLabel)
                        .font(Typo.mono(TypeScale.base))
                        .foregroundStyle(DuskColors.ink)
                        .lineLimit(1)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(Typo.mono(TypeScale.xs))
                        .foregroundStyle(DuskColors.ink3)
                }
                .padding(.horizontal, Space.sm)
                .padding(.vertical, Space.xs)
                .background(DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.sm))
                .overlay(RoundedRectangle(cornerRadius: Radii.sm).stroke(DuskColors.lineSoft, lineWidth: DesignMetrics.hairline))
            }
            .disabled(!isEnabled)
            .opacity(isEnabled ? 1 : DesignMaterialAdapter.selectDisabledOpacity)
            .accessibilityLabel(title)
            .accessibilityValue(isEnabled ? currentLabel : "Disabled")
            .accessibilityHint(detail ?? "")
            .accessibilityIdentifier(accessibilityId ?? "")
        }
        .frame(minHeight: DesignMetrics.minimumTarget)
        .padding(.vertical, Space.sm)
    }

    private var currentLabel: String {
        options.first(where: { $0.value == selection })?.label ?? "Select…"
    }
}

struct DesignSlider: View {
    let title: String
    @Binding var value: Double
    let range: ClosedRange<Double>
    var step: Double = 1
    var format: ((Double) -> String)? = nil
    var accessibilityId: String? = nil
    var isEnabled = true

    init(
        title: String,
        value: Binding<Double>,
        range: ClosedRange<Double>,
        step: Double = 1,
        format: ((Double) -> String)? = nil,
        accessibilityId: String? = nil,
        isEnabled: Bool = true
    ) {
        self.title = title
        _value = value
        self.range = range
        self.step = step
        self.format = format
        self.accessibilityId = accessibilityId
        self.isEnabled = isEnabled
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            HStack {
                Text(title)
                    .font(Typo.ui(TypeScale.base, .medium))
                    .foregroundStyle(DuskColors.ink)
                Spacer(minLength: Space.sm)
                if let format {
                    Text(format(value))
                        .font(Typo.mono(TypeScale.base))
                        .foregroundStyle(DuskColors.ink)
                        .padding(.horizontal, Space.sm)
                        .padding(.vertical, Space.xs)
                        .background(DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.sm))
                        .overlay(RoundedRectangle(cornerRadius: Radii.sm).stroke(DuskColors.lineSoft, lineWidth: DesignMetrics.hairline))
                }
            }
            Slider(value: $value, in: range, step: step) { Text(title) }
                .tint(DuskColors.accent)
                .disabled(!isEnabled)
                .accessibilityLabel(title)
                .accessibilityValue(isEnabled ? (format?(value) ?? String(value)) : "Disabled")
        }
        .frame(minHeight: DesignMetrics.minimumTarget)
        .padding(.vertical, Space.sm)
        .accessibilityIdentifier(accessibilityId ?? "")
    }
}

struct DesignChip: View {
    let title: String
    var selected = false
    var isEnabled = true
    var accessibilityId: String? = nil
    let action: () -> Void

    init(
        title: String,
        selected: Bool = false,
        isEnabled: Bool = true,
        accessibilityId: String? = nil,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.selected = selected
        self.isEnabled = isEnabled
        self.accessibilityId = accessibilityId
        self.action = action
    }

    var body: some View {
        Button(title, action: action)
            .font(Typo.ui(TypeScale.base, selected ? .semibold : .regular))
            .foregroundStyle(isEnabled ? DuskColors.ink : DuskColors.ink4)
            .padding(.horizontal, Space.md)
            .frame(minHeight: DesignMetrics.minimumTarget)
            .background(selected ? DuskColors.accentSoft : DuskColors.bgElev, in: Capsule())
            .overlay(Capsule().stroke(selected ? DuskColors.accent : DuskColors.line, lineWidth: DesignMetrics.hairline))
            .disabled(!isEnabled)
            .accessibilityLabel(title)
            .accessibilityValue(isEnabled ? (selected ? "Selected" : "Not selected") : "Disabled")
            .accessibilityIdentifier(accessibilityId ?? "")
            .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct DesignCheckbox: View {
    let title: String
    @Binding var isOn: Bool
    var isEnabled = true
    var accessibilityId: String? = nil

    var body: some View {
        Toggle(isOn: $isOn) { Text(title).font(Typo.ui(TypeScale.base)) }
            .toggleStyle(.button)
            .buttonStyle(DesignButtonStyle(role: .quiet))
            .disabled(!isEnabled)
            .accessibilityLabel(title)
            .accessibilityValue(isEnabled ? (isOn ? "Checked" : "Unchecked") : "Disabled")
            .accessibilityIdentifier(accessibilityId ?? "")
            .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}

struct DesignProgress: View {
    var title: String? = nil
    var value: Double? = nil
    var accessibilityId: String? = nil

    var body: some View {
        HStack(spacing: Space.sm) {
            if let value { ProgressView(value: value) } else { ProgressView() }
            if let title { Text(title).font(Typo.ui(TypeScale.base)) }
        }
        .tint(DuskColors.accent)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title ?? "In progress")
        .accessibilityValue(progressValue)
        .accessibilityIdentifier(accessibilityId ?? "")
    }

    private var progressValue: String {
        guard let value else { return "In progress" }
        return "\(Int((value * 100).rounded())) percent"
    }
}

struct DesignDivider: View {
    var body: some View {
        Rectangle()
            .fill(DuskColors.lineSoft)
            .frame(height: DesignMetrics.hairline)
            .accessibilityHidden(true)
    }
}

struct ElevatedUserAvatar: View {
    let name: String
    var size: CGFloat = DesignMetrics.minimumTarget
    var selected = false
    var disabled = false

    var body: some View {
        Text(initials)
            .font(Typo.ui(max(TypeScale.base, size * DesignMaterialAdapter.avatarGlyphRatio), .semibold))
            .foregroundStyle(DuskColors.ink)
            .frame(width: max(size, DesignMetrics.minimumTarget), height: max(size, DesignMetrics.minimumTarget))
            .background(RadialGradient(colors: [DuskColors.paper, DuskColors.bgSunk], center: .center, startRadius: DesignMaterialAdapter.avatarGradientStartRadius, endRadius: size))
            .clipShape(Circle())
            .overlay(Circle().stroke(selected ? DuskColors.accent : DuskColors.line, lineWidth: selected ? DesignMaterialAdapter.avatarSelectedBorder : DesignMetrics.hairline))
            .shadow(color: .black.opacity(DesignMaterialAdapter.avatarShadowOpacity), radius: DesignMaterialAdapter.avatarShadowRadius, y: DesignMaterialAdapter.avatarShadowY)
            .opacity(disabled ? DesignMaterialAdapter.avatarDisabledOpacity : 1)
            .accessibilityLabel(name)
            .accessibilityValue(disabled ? "Disabled" : selected ? "Selected" : "")
            .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var initials: String {
        name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
    }
}
