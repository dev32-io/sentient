import SwiftUI
import UIKit

enum DesignControlState: Equatable {
    case normal, loading, error(String), disabled

    var isInteractive: Bool {
        if case .normal = self { return true }
        return false
    }
}

enum DesignButtonRole { case action, destructive, quiet }

enum DesignNoticeKind { case loading, empty, error, success, warning }

/// Native projection of the reviewed v2 material recipes. Values mirror the named KMP
/// effects; SwiftUI layers replace CSS multi-background/inset-shadow primitives.
enum DesignMaterialMetrics {
    static let slateRadialScale = CGSize(width: 0.82, height: 1.05)
    static let slateRadialCenterY = 0.52
    static let slateCenterStop = 0.42
    static let slateFadeStop = 0.76
    static let slateCenterSunk = 0.20
    static let slateRingSunk = 0.12
    static let slateTopLight = 0.07
    static let slateContactY: CGFloat = 2
    static let slateCastY: CGFloat = 9
    static let slateCastBlur: CGFloat = 15
    static let slateEmberY: CGFloat = 12
    static let slateEmberBlur: CGFloat = 20
    static let wellMiddleStop = 0.56
    static let wellTopBlack = 0.05
    static let wellBottomElevated = 0.10
    static let wellInsetOpacity = 0.72
    static let plateCastY: CGFloat = 18
    static let plateCastBlur: CGFloat = 30
    static let floatCastY: CGFloat = 28
    static let floatCastBlur: CGFloat = 58
}

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
            if role == .destructive && !muted { DuskColors.stop.opacity(0.38) }
            if muted { DuskColors.ink4.opacity(0.08) }
            LinearGradient(colors: [DuskColors.ink.opacity(muted ? 0.03 : 0.04), .clear], startPoint: .top, endPoint: .bottom)
            RadialGradient(
                stops: [
                    .init(color: DuskColors.bgSunk.opacity(muted ? 0.16 : DesignMaterialMetrics.slateCenterSunk), location: 0),
                    .init(color: DuskColors.bgSunk.opacity(DesignMaterialMetrics.slateRingSunk), location: DesignMaterialMetrics.slateCenterStop),
                    .init(color: .clear, location: muted ? 0.74 : DesignMaterialMetrics.slateFadeStop),
                ],
                center: UnitPoint(x: 0.5, y: DesignMaterialMetrics.slateRadialCenterY),
                startRadius: 0,
                endRadius: 80
            )
            .scaleEffect(x: DesignMaterialMetrics.slateRadialScale.width, y: DesignMaterialMetrics.slateRadialScale.height)
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
            .overlay(alignment: .top) { DuskColors.ink.opacity(contrast == .increased ? 0.10 : 0.05).frame(height: DesignMetrics.hairline).clipShape(shape) }
            // plate-shadow contact + directional cast; elevated plates use float depth.
            .shadow(color: DuskColors.line.opacity(elevated ? 0.86 : 0.45), radius: 0, y: elevated ? 3 : 2)
            .shadow(color: .black.opacity(elevated ? 0.96 : 0.90), radius: elevated ? DesignMaterialMetrics.floatCastBlur : DesignMaterialMetrics.plateCastBlur, y: elevated ? DesignMaterialMetrics.floatCastY : DesignMaterialMetrics.plateCastY)
            .shadow(color: DuskColors.accent.opacity(elevated ? 0.38 : 0), radius: elevated ? 40 : 0, y: elevated ? 24 : 0)
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
                        .init(color: DuskColors.bgSunk.overlaying(.black, opacity: DesignMaterialMetrics.wellTopBlack), location: 0),
                        .init(color: DuskColors.bgSunk, location: DesignMaterialMetrics.wellMiddleStop),
                        .init(color: DuskColors.bgSunk.overlaying(DuskColors.bgElev, opacity: DesignMaterialMetrics.wellBottomElevated), location: 1),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
            .clipShape(shape)
            // well-shadow inset top recess and lower reflected highlight.
            .overlay(alignment: .top) { LinearGradient(colors: [.black.opacity(DesignMaterialMetrics.wellInsetOpacity), .clear], startPoint: .top, endPoint: .bottom).frame(height: 6).clipShape(shape) }
            .overlay(alignment: .bottom) { DuskColors.ink.opacity(focused ? 0.08 : 0.07).frame(height: DesignMetrics.hairline).clipShape(shape) }
            .overlay { shape.stroke(error ? DuskColors.stop : focused ? DuskColors.accent.overlaying(DuskColors.line, opacity: 0.44) : (contrast == .increased ? DuskColors.ink3 : DuskColors.line), lineWidth: DesignMetrics.hairline) }
            .shadow(color: DuskColors.line.opacity(0.45), radius: 0, y: 1)
            .shadow(color: focused ? DuskColors.accent.opacity(0.18) : .clear, radius: DesignMetrics.focusRing)
            .shadow(color: focused ? DuskColors.accent.opacity(0.48) : .clear, radius: 18, y: 8)
    }
}

private extension Color {
    /// Alpha-composite helper used to express the contract's color-mix weights natively.
    func overlaying(_ overlay: Color, opacity: Double) -> Color {
        // Layering in a ZStack is the native equivalent and keeps semantic colors adaptive.
        // This method is used only where ShapeStyle requires one color, so interpolate in sRGB.
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
        return UIColor(red: r1 * (1 - weight) + r2 * weight, green: g1 * (1 - weight) + g2 * weight, blue: b1 * (1 - weight) + b2 * weight, alpha: a1 * (1 - weight) + a2 * weight)
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
        let shape = RoundedRectangle(cornerRadius: DesignV2.Radius.sm, style: .continuous)
        configuration.label
            .font(Typo.ui(TypeScale.base, .semibold))
            .foregroundStyle(foreground)
            .frame(minHeight: DesignMetrics.minimumTarget)
            .padding(.horizontal, Space.lg)
            .background { SlateFace(role: role, muted: !isEnabled) }
            .clipShape(shape)
            .overlay(alignment: .top) {
                (pressed ? DuskColors.bgSunk.opacity(0.42) : DuskColors.ink.opacity(contrast == .increased ? 0.13 : DesignMaterialMetrics.slateTopLight))
                    .frame(height: pressed ? 3 : DesignMetrics.hairline).clipShape(shape)
            }
            .overlay { shape.stroke(border, lineWidth: DesignMetrics.hairline) }
            .overlay { shape.stroke(focused ? DuskColors.accent : .clear, lineWidth: 2).padding(-3) }
            .shadow(color: contact(pressed: pressed), radius: 0, y: pressed ? 1 : DesignMaterialMetrics.slateContactY)
            .shadow(color: .black.opacity(isEnabled ? (pressed ? 0.88 : 0.90) : 0.70), radius: pressed ? 6 : DesignMaterialMetrics.slateCastBlur, y: pressed ? 3 : DesignMaterialMetrics.slateCastY)
            .shadow(color: glow.opacity(isEnabled && !pressed ? (role == .action ? 0.58 : role == .destructive ? 0.72 : 0.42) : 0), radius: DesignMaterialMetrics.slateEmberBlur, y: DesignMaterialMetrics.slateEmberY)
            .offset(y: pressed ? DesignMetrics.pressedDepth : 0)
            .animation(DesignV2.Motion.animation(duration: DesignV2.Motion.feedback, reduceMotion: reduceMotion), value: pressed)
    }

    private var foreground: Color {
        if !isEnabled { return DuskColors.ink4 }
        return role == .action ? DuskColors.bgSunk : role == .quiet ? DuskColors.ink2 : DuskColors.ink
    }

    private var border: Color {
        if !isEnabled { return DuskColors.lineSoft.opacity(0.74) }
        return role == .destructive ? DuskColors.stop.opacity(0.76) : role == .action ? DuskColors.accent.opacity(0.64) : DuskColors.line
    }

    private var glow: Color { role == .destructive ? DuskColors.stop : DuskColors.accent }
    private func contact(pressed: Bool) -> Color {
        if role == .destructive { return DuskColors.stop.opacity(pressed ? 0.30 : 0.38) }
        return DuskColors.bgSunk.opacity(pressed ? 0.90 : 0.88)
    }
}

struct DesignActionButton: View {
    let title: String
    var role: DesignButtonRole = .action
    var state: DesignControlState = .normal
    var accessibilityId: String? = nil
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Space.sm) {
                if state == .loading { ProgressView().controlSize(.small) }
                Text(label).frame(maxWidth: .infinity)
            }
        }
        .buttonStyle(DesignButtonStyle(role: role))
        .disabled(!state.isInteractive)
        .accessibilityIdentifier(accessibilityId ?? "")
        .accessibilityValue(accessibilityValue)
    }

    private var label: String {
        if state == .loading { return "Loading" }
        return title
    }

    private var accessibilityValue: String {
        switch state {
        case .normal: "Ready"
        case .loading: "In progress"
        case .error(let message): "Error: \(message)"
        case .disabled: "Disabled"
        }
    }
}

struct DesignIconButton: View {
    let systemName: String
    let label: String
    var role: DesignButtonRole = .quiet
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .frame(width: DesignMetrics.minimumTarget, height: DesignMetrics.minimumTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(DesignButtonStyle(role: role))
        .accessibilityLabel(label)
    }
}

struct DesignField: View {
    let title: String
    var prompt: String = ""
    @Binding var text: String
    var error: String? = nil
    var accessibilityId: String? = nil
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(title).font(Typo.ui(TypeScale.base, .medium)).foregroundStyle(DuskColors.ink)
            TextField(prompt, text: $text)
                .font(Typo.ui(TypeScale.base))
                .textFieldStyle(.plain)
                .padding(.horizontal, Space.md)
                .frame(minHeight: DesignMetrics.minimumTarget)
                .designWell(focused: focused, error: error != nil)
                .focused($focused)
                .accessibilityIdentifier(accessibilityId ?? "")
            if let error {
                Label(error, systemImage: "exclamationmark.circle.fill")
                    .font(Typo.ui(TypeScale.sm))
                    .foregroundStyle(DuskColors.stop)
            }
        }
    }
}

struct DesignSecureField: View {
    let title: String
    var prompt: String = ""
    @Binding var text: String
    var error: String? = nil
    @State private var revealed = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(title).font(Typo.ui(TypeScale.base, .medium))
            HStack(spacing: Space.sm) {
                Group {
                    if revealed { TextField(prompt, text: $text) }
                    else { SecureField(prompt, text: $text) }
                }
                .font(Typo.ui(TypeScale.base))
                .textFieldStyle(.plain)
                .focused($focused)
                Button { revealed.toggle() } label: {
                    Image(systemName: revealed ? "eye.slash" : "eye")
                        .frame(width: DesignMetrics.minimumTarget, height: DesignMetrics.minimumTarget)
                }
                .accessibilityLabel(revealed ? "Hide value" : "Show value")
            }
            .padding(.leading, Space.md)
            .designWell(focused: focused, error: error != nil)
            if let error {
                Label(error, systemImage: "exclamationmark.circle.fill")
                    .font(Typo.ui(TypeScale.sm)).foregroundStyle(DuskColors.stop)
            }
        }
    }
}

struct DesignMultilineEditor: View {
    let title: String
    @Binding var text: String
    var error: String? = nil
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(title).font(Typo.ui(TypeScale.base, .medium))
            TextEditor(text: $text)
                .font(Typo.ui(TypeScale.base))
                .scrollContentBackground(.hidden)
                .padding(Space.sm)
                .frame(minHeight: DesignMetrics.minimumTarget * 3)
                .designWell(focused: focused, error: error != nil)
                .focused($focused)
        }
    }
}

struct DesignToggleRow: View {
    let title: String
    var detail: String? = nil
    @Binding var isOn: Bool

    var body: some View {
        Toggle(isOn: $isOn) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(title).font(Typo.ui(TypeScale.base, .medium))
                if let detail { Text(detail).font(Typo.ui(TypeScale.sm)).foregroundStyle(DuskColors.ink3) }
            }
        }
        .tint(DuskColors.accent)
        .frame(minHeight: DesignMetrics.minimumTarget)
    }
}

struct DesignSegmentedPicker<Value: Hashable>: View {
    let title: String
    let options: [(value: Value, label: String)]
    @Binding var selection: Value

    var body: some View {
        Picker(title, selection: $selection) {
            ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                Text(option.label).tag(option.value)
            }
        }
        .pickerStyle(.segmented)
        .frame(minHeight: DesignMetrics.minimumTarget)
        .accessibilityLabel(title)
    }
}

struct DesignSelect<Value: Hashable>: View {
    let title: String
    let options: [(value: Value, label: String)]
    @Binding var selection: Value

    var body: some View {
        Picker(title, selection: $selection) {
            ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                Text(option.label).tag(option.value)
            }
        }
        .pickerStyle(.menu)
        .font(Typo.ui(TypeScale.base))
        .frame(minHeight: DesignMetrics.minimumTarget)
    }
}

struct DesignSlider: View {
    let title: String
    @Binding var value: Double
    let range: ClosedRange<Double>
    var step: Double = 1

    var body: some View {
        Slider(value: $value, in: range, step: step) { Text(title) }
            .tint(DuskColors.accent)
            .frame(minHeight: DesignMetrics.minimumTarget)
            .accessibilityLabel(title)
    }
}

struct DesignChip: View {
    let title: String
    var selected: Bool = false
    let action: () -> Void

    var body: some View {
        Button(title, action: action)
            .font(Typo.ui(TypeScale.base, selected ? .semibold : .regular))
            .padding(.horizontal, Space.md)
            .frame(minHeight: DesignMetrics.minimumTarget)
            .background(selected ? DuskColors.accentSoft : DuskColors.bgElev, in: Capsule())
            .overlay(Capsule().stroke(selected ? DuskColors.accent : DuskColors.line, lineWidth: 1))
            .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct DesignCheckbox: View {
    let title: String
    @Binding var isOn: Bool

    var body: some View {
        Toggle(isOn: $isOn) { Text(title).font(Typo.ui(TypeScale.base)) }
            .toggleStyle(.button)
            .buttonStyle(DesignButtonStyle(role: .quiet))
            .accessibilityValue(isOn ? "Checked" : "Unchecked")
    }
}

struct DesignProgress: View {
    var title: String? = nil
    var value: Double? = nil

    var body: some View {
        HStack(spacing: Space.sm) {
            if let value { ProgressView(value: value) } else { ProgressView() }
            if let title { Text(title).font(Typo.ui(TypeScale.base)) }
        }
        .tint(DuskColors.accent)
        .accessibilityLabel(title ?? "In progress")
    }
}

struct DesignDivider: View {
    var body: some View { Rectangle().fill(DuskColors.lineSoft).frame(height: DesignMetrics.hairline) }
}

struct ElevatedUserAvatar: View {
    let name: String
    var size: CGFloat = DesignMetrics.minimumTarget
    var selected = false
    var disabled = false

    var body: some View {
        Text(initials)
            .font(Typo.ui(max(TypeScale.base, size * 0.34), .semibold))
            .foregroundStyle(DuskColors.ink)
            .frame(width: max(size, DesignMetrics.minimumTarget), height: max(size, DesignMetrics.minimumTarget))
            .background(
                RadialGradient(colors: [DuskColors.paper, DuskColors.bgSunk], center: .center, startRadius: 1, endRadius: size)
            )
            .clipShape(Circle())
            .overlay(Circle().stroke(selected ? DuskColors.accent : DuskColors.line, lineWidth: selected ? 3 : 1))
            .shadow(color: .black.opacity(0.72), radius: 8, y: 5)
            .opacity(disabled ? 0.48 : 1)
            .accessibilityLabel(name)
            .accessibilityValue(selected ? "Selected" : disabled ? "Disabled" : "")
    }

    private var initials: String {
        name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
    }
}
