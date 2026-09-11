import SwiftUI

enum DesignControlState: Equatable {
    case normal, loading, error(String), disabled

    var isInteractive: Bool {
        if case .normal = self { return true }
        return false
    }
}

enum DesignButtonRole { case action, destructive, quiet }

enum DesignNoticeKind { case loading, empty, error, success, warning }

private struct PlateSurface: ViewModifier {
    @Environment(\.colorSchemeContrast) private var contrast
    let elevated: Bool

    func body(content: Content) -> some View {
        content
            .background(elevated ? DuskColors.paper : DuskColors.bgElev)
            .clipShape(RoundedRectangle(cornerRadius: Radii.lg, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Radii.lg, style: .continuous)
                    .stroke(contrast == .increased ? DuskColors.ink3 : DuskColors.lineSoft,
                            lineWidth: DesignMetrics.hairline)
            }
            .shadow(color: .black.opacity(contrast == .increased ? 0.65 : 0.48), radius: 15, y: 9)
            .overlay(alignment: .top) {
                RoundedRectangle(cornerRadius: Radii.lg, style: .continuous)
                    .stroke(DuskColors.ink.opacity(contrast == .increased ? 0.12 : 0.05), lineWidth: 1)
                    .mask(alignment: .top) { Rectangle().frame(height: 1) }
            }
    }
}

private struct WellSurface: ViewModifier {
    @Environment(\.colorSchemeContrast) private var contrast
    let focused: Bool
    let error: Bool

    func body(content: Content) -> some View {
        content
            .background(
                LinearGradient(colors: [.black.opacity(0.28), DuskColors.bgSunk, DuskColors.bgElev.opacity(0.25)],
                               startPoint: .top, endPoint: .bottom)
            )
            .clipShape(RoundedRectangle(cornerRadius: Radii.md, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Radii.md, style: .continuous)
                    .stroke(error ? DuskColors.stop : focused ? DuskColors.accent : (contrast == .increased ? DuskColors.ink3 : DuskColors.line),
                            lineWidth: focused || error ? DesignMetrics.focusRing : DesignMetrics.hairline)
            }
            .shadow(color: .black.opacity(0.55), radius: 4, y: -2)
    }
}

extension View {
    func designPlate(elevated: Bool = false) -> some View { modifier(PlateSurface(elevated: elevated)) }
    func designWell(focused: Bool = false, error: Bool = false) -> some View {
        modifier(WellSurface(focused: focused, error: error))
    }
}

struct DesignButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast
    let role: DesignButtonRole

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed && isEnabled
        configuration.label
            .font(Typo.ui(TypeScale.base, .semibold))
            .foregroundStyle(foreground)
            .frame(minHeight: DesignMetrics.minimumTarget)
            .padding(.horizontal, Space.lg)
            .background(face(pressed: pressed))
            .clipShape(RoundedRectangle(cornerRadius: Radii.md, style: .continuous))
            .overlay(alignment: .top) {
                Rectangle().fill(DuskColors.ink.opacity(contrast == .increased ? 0.18 : 0.07))
                    .frame(height: DesignMetrics.hairline)
            }
            .overlay {
                RoundedRectangle(cornerRadius: Radii.md, style: .continuous)
                    .stroke(border, lineWidth: DesignMetrics.hairline)
            }
            .shadow(color: .black.opacity(pressed ? 0.34 : 0.72), radius: pressed ? 3 : 8, y: pressed ? 1 : 5)
            .offset(y: pressed ? DesignMetrics.pressedDepth : 0)
            .opacity(isEnabled ? 1 : 0.52)
            .animation(DesignV2.Motion.animation(duration: DesignV2.Motion.feedback, reduceMotion: reduceMotion), value: pressed)
    }

    private var foreground: Color {
        role == .action ? DuskColors.bgSunk : role == .destructive ? DuskColors.stop : DuskColors.ink
    }

    private var border: Color {
        role == .destructive ? DuskColors.stop : role == .action ? DuskColors.accent : DuskColors.line
    }

    private func face(pressed: Bool) -> some ShapeStyle {
        LinearGradient(
            colors: role == .action
                ? [DuskColors.accent.opacity(pressed ? 0.76 : 1), DuskColors.amber.opacity(0.72)]
                : [DuskColors.paper.opacity(pressed ? 0.72 : 1), DuskColors.bgElev],
            startPoint: .top,
            endPoint: .bottom
        )
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
