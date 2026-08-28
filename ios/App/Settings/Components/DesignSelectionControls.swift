import SwiftUI

private struct DesignControlPressedKey: EnvironmentKey {
    static let defaultValue = false
}

private extension EnvironmentValues {
    var designControlPressed: Bool {
        get { self[DesignControlPressedKey.self] }
        set { self[DesignControlPressedKey.self] = newValue }
    }
}

private struct DesignToggleTrack: View {
    @Environment(\.designControlPressed) private var pressed
    let isOn: Bool
    let isEnabled: Bool

    private var trackFace: LinearGradient {
        LinearGradient(
            colors: isOn
                ? [
                    DuskColors.accentSoft.overlaying(DuskColors.bgSunk, opacity: 0.20),
                    DuskColors.accentSoft,
                ]
                : [
                    DuskColors.bgSunk.overlaying(.black, opacity: DesignMaterialAdapter.wellTopBlack),
                    DuskColors.bgSunk.overlaying(
                        DuskColors.bgElev,
                        opacity: DesignMaterialAdapter.wellBottomElevated
                    ),
                ],
            startPoint: .top,
            endPoint: .bottom
        )
    }

    var body: some View {
        ZStack(alignment: .leading) {
            Capsule()
                .fill(
                    trackFace.shadow(
                        .inner(
                            color: .black.opacity(DesignMaterialAdapter.wellInsetOpacity),
                            radius: DesignMaterialAdapter.wellInsetBlur,
                            y: DesignMaterialAdapter.wellInsetY
                        )
                    )
                )
                .overlay {
                    Capsule().stroke(
                        isOn
                            ? DuskColors.line.overlaying(DuskColors.accent, opacity: 0.52)
                            : DuskColors.line,
                        lineWidth: DesignMetrics.hairline
                    )
                }
                .shadow(
                    color: DuskColors.line.opacity(DesignMaterialAdapter.wellLineOpacity),
                    radius: 0,
                    y: 1
                )
                .frame(width: DesignMetrics.toggleWidth, height: DesignMetrics.toggleHeight)

            Circle()
                .fill(Color.clear)
                .frame(width: DesignMetrics.toggleKnobSize, height: DesignMetrics.toggleKnobSize)
                .background {
                    designSlateFace(
                        role: .action,
                        muted: !isEnabled,
                        hovered: false,
                        baseOverride: isOn ? DuskColors.accent : DuskColors.paper
                    )
                }
                .clipShape(Circle())
                .overlay {
                    Circle().stroke(
                        isOn
                            ? DuskColors.accent
                            : DuskColors.line.overlaying(DuskColors.ink, opacity: 0.20),
                        lineWidth: DesignMetrics.hairline
                    )
                }
                .background {
                    ZStack {
                        DesignSpreadShadow(
                            shape: Circle(),
                            color: .black.opacity(
                                isEnabled
                                    ? pressed
                                        ? DesignMaterialAdapter.slatePressedBlack
                                        : DesignMaterialAdapter.slateRestBlack
                                    : DesignMaterialAdapter.slateDisabledBlack
                            ),
                            geometry: !isEnabled
                                ? DesignMaterialShadowGeometry.slateDisabled
                                : pressed
                                    ? DesignMaterialShadowGeometry.slatePressed
                                    : DesignMaterialShadowGeometry.slateRest
                        )
                        DesignSpreadShadow(
                            shape: Circle(),
                            color: DuskColors.bgSunk.opacity(DesignMaterialAdapter.slateContactOpacity),
                            geometry: DesignDropShadowGeometry(radius: 0, y: 2, sourceInset: 1)
                        )
                    }
                }
                .offset(
                    x: isOn ? DesignMetrics.toggleTravel : 4,
                    y: pressed ? DesignMetrics.pressedDepth : 0
                )
        }
        .frame(width: DesignMetrics.toggleWidth, height: DesignMetrics.minimumTarget)
        .opacity(isEnabled ? 1 : DesignMaterialAdapter.selectDisabledOpacity)
    }
}

private struct DesignTogglePressStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .environment(\.designControlPressed, configuration.isPressed)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.99 : 1)
            .offset(y: configuration.isPressed ? DesignMetrics.pressedDepth : 0)
    }
}

private struct DesignToggleStyle: ToggleStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        Button(action: { configuration.isOn.toggle() }) {
            HStack(spacing: Space.md) {
                configuration.label
                Spacer(minLength: Space.sm)
                DesignToggleTrack(isOn: configuration.isOn, isEnabled: isEnabled)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(DesignTogglePressStyle())
        .animation(
            reduceMotion ? nil : .timingCurve(0.2, 0.8, 0.2, 1, duration: DesignMetrics.toggleAnimationDuration),
            value: configuration.isOn
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
            .toggleStyle(DesignToggleStyle())
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
                Text(title).font(Typo.ui(DesignMetrics.controlLabelSize, .medium))
                if let detail { Text(detail).font(Typo.ui(TypeScale.sm)).foregroundStyle(DuskColors.ink3) }
            }
        }
        .toggleStyle(DesignToggleStyle())
        .disabled(!isEnabled)
        .frame(minHeight: DesignMetrics.minimumTarget)
        .accessibilityLabel(title)
        .accessibilityValue(isEnabled ? (isOn ? "On" : "Off") : "Disabled")
        .accessibilityHint(detail ?? "")
        .accessibilityIdentifier(accessibilityId ?? "")
    }
}

private struct DesignSegmentButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            // Segment press feedback is deliberately immediate; selection
            // movement remains owned by the segmented control.
            .offset(y: configuration.isPressed && !reduceMotion ? DesignMetrics.pressedDepth : 0)
    }
}

struct DesignSegmentedPicker<Value: Hashable>: View {
    let title: String
    let options: [(value: Value, label: String)]
    @Binding var selection: Value
    var accessibilityId: String? = nil
    var isEnabled = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var selectionNamespace

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
        HStack(spacing: DesignMetrics.segmentGap) {
            ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                Button {
                    selection = option.value
                } label: {
                    Text(option.label)
                        .font(Typo.ui(DesignMetrics.segmentLabelSize))
                        .foregroundStyle(selection == option.value ? DuskColors.accent : DuskColors.ink2)
                        .frame(maxWidth: .infinity, minHeight: DesignMetrics.segmentHeight)
                        .padding(.horizontal, DesignMetrics.segmentHorizontalPadding)
                        .background {
                            if selection == option.value {
                                RoundedRectangle(cornerRadius: DesignMetrics.segmentCornerRadius, style: .continuous)
                                    .fill(Color.clear)
                                    .background {
                                        designSlateFace(
                                            role: .quiet,
                                            muted: false,
                                            hovered: false,
                                            baseOverride: DuskColors.accent50
                                        )
                                    }
                                    .clipShape(RoundedRectangle(cornerRadius: DesignMetrics.segmentCornerRadius, style: .continuous))
                                    .overlay {
                                        RoundedRectangle(cornerRadius: DesignMetrics.segmentCornerRadius, style: .continuous)
                                            .stroke(
                                                DuskColors.lineSoft.overlaying(DuskColors.accent, opacity: 0.22),
                                                lineWidth: DesignMetrics.hairline
                                            )
                                    }
                                    .background {
                                        let shape = RoundedRectangle(
                                            cornerRadius: DesignMetrics.segmentCornerRadius,
                                            style: .continuous
                                        )
                                        ZStack {
                                            DesignSpreadShadow(
                                                shape: shape,
                                                color: .black.opacity(DesignMaterialAdapter.slateRestBlack),
                                                geometry: DesignMaterialShadowGeometry.slateRest
                                            )
                                            DesignSpreadShadow(
                                                shape: shape,
                                                color: DuskColors.bgSunk.opacity(0.88),
                                                geometry: DesignDropShadowGeometry(
                                                    radius: 0,
                                                    y: 2,
                                                    sourceInset: 1
                                                )
                                            )
                                        }
                                    }
                                    .matchedGeometryEffect(id: "selected-segment", in: selectionNamespace)
                            }
                        }
                }
                .buttonStyle(DesignSegmentButtonStyle())
                .disabled(!isEnabled)
            }
        }
        .padding(DesignMetrics.segmentBedPadding)
        .frame(minHeight: DesignMetrics.minimumTarget)
        .designWell(cornerRadius: Radii.sm)
        .opacity(isEnabled ? 1 : DesignMaterialAdapter.selectDisabledOpacity)
        .animation(DesignV2.Motion.animation(duration: DesignV2.Motion.state, reduceMotion: reduceMotion), value: selection)
        .accessibilityLabel(title)
        .accessibilityValue(isEnabled ? selectedLabel : "Disabled")
        .accessibilityIdentifier(accessibilityId ?? "")
    }

    private var selectedLabel: String {
        options.first(where: { $0.value == selection })?.label ?? "Not selected"
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
                    .font(Typo.ui(DesignMetrics.controlLabelSize, .medium))
                    .foregroundStyle(DuskColors.ink)
                if let detail {
                    Text(detail)
                        .font(Typo.ui(TypeScale.sm))
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
                        .font(Typo.ui(DesignMetrics.controlLabelSize))
                        .foregroundStyle(DuskColors.ink)
                        .lineLimit(1)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(Typo.ui(TypeScale.sm, .medium))
                        .foregroundStyle(DuskColors.ink3)
                }
                .padding(.horizontal, Space.md)
                .frame(minHeight: DesignMetrics.minimumTarget)
                .designWell()
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

private struct DesignChipButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    let selected: Bool
    let hovered: Bool

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed && isEnabled
        let shape = Capsule()
        configuration.label
            // Keep font metrics invariant across states so selection never
            // changes the chip's intrinsic width.
            .font(Typo.ui(DesignMetrics.controlLabelSize, .regular))
            .foregroundStyle(isEnabled ? (selected ? DuskColors.accent : DuskColors.ink2) : DuskColors.ink4)
            .padding(.horizontal, Space.md)
            .frame(minHeight: DesignMetrics.minimumTarget)
            .background {
                if selected {
                    DesignWellFace(shape: shape, focused: false, showsInsetHighlights: true)
                } else {
                    designSlateFace(role: .secondary, muted: !isEnabled, hovered: hovered)
                }
            }
            .clipShape(shape)
            .overlay {
                shape.stroke(
                    selected || hovered ? Color.clear : DuskColors.line,
                    lineWidth: DesignMetrics.hairline
                )
            }
            .background {
                ZStack {
                    if selected {
                        if pressed {
                            DesignSpreadShadow(
                                shape: shape,
                                color: .black.opacity(DesignMaterialAdapter.slatePressedBlack),
                                geometry: DesignMaterialShadowGeometry.slatePressed
                            )
                        } else {
                            DesignSpreadShadow(
                                shape: shape,
                                color: DuskColors.accent.opacity(hovered ? 0.64 : 0.58),
                                geometry: DesignDropShadowGeometry(
                                    radius: hovered ? 18 : 16,
                                    y: 8,
                                    sourceInset: hovered ? 12 : 14
                                )
                            )
                        }
                    } else {
                        DesignSpreadShadow(
                            shape: shape,
                            color: .black.opacity(
                                isEnabled
                                    ? pressed
                                        ? DesignMaterialAdapter.slatePressedBlack
                                        : hovered
                                            ? DesignMaterialAdapter.slateHoverBlack
                                            : DesignMaterialAdapter.slateRestBlack
                                    : DesignMaterialAdapter.slateDisabledBlack
                            ),
                            geometry: !isEnabled
                                ? DesignMaterialShadowGeometry.slateDisabled
                                : pressed
                                    ? DesignMaterialShadowGeometry.slatePressed
                                    : hovered
                                        ? DesignMaterialShadowGeometry.slateHover
                                        : DesignMaterialShadowGeometry.slateRest
                        )
                    }
                    DesignSpreadShadow(
                        shape: shape,
                        color: selected
                            ? DuskColors.line.opacity(DesignMaterialAdapter.wellLineOpacity)
                            : DuskColors.bgSunk.opacity(0.88),
                        geometry: DesignDropShadowGeometry(
                            radius: 0,
                            y: selected ? 1 : 2,
                            sourceInset: 1
                        )
                    )
                }
            }
            .offset(y: selected ? (pressed ? 2 : 1) : (pressed ? DesignMetrics.pressedDepth : hovered ? -1 : 0))
            .opacity(isEnabled ? 1 : DesignMaterialAdapter.selectDisabledOpacity)
            // Keep press feedback discrete; chips should respond on touch-down.
    }
}

struct DesignChip: View {
    let title: String
    var selected = false
    var isEnabled = true
    var accessibilityId: String? = nil
    let action: () -> Void
    @State private var hovered = false

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
            .buttonStyle(DesignChipButtonStyle(selected: selected, hovered: hovered))
            .onHover { hovered = $0 }
            .disabled(!isEnabled)
            .accessibilityLabel(title)
            .accessibilityValue(isEnabled ? (selected ? "Selected" : "Not selected") : "Disabled")
            .accessibilityIdentifier(accessibilityId ?? "")
            .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private struct DesignCheckboxMark: View {
    @Environment(\.designControlPressed) private var pressed
    let isOn: Bool
    let isEnabled: Bool

    private var shape: RoundedRectangle {
        RoundedRectangle(
            cornerRadius: DesignMetrics.checkboxCornerRadius,
            style: .continuous
        )
    }

    var body: some View {
        ZStack {
            if !isEnabled {
                designSlateFace(role: .quiet, muted: true, hovered: false)
            } else if isOn {
                designSlateFace(
                    role: .action,
                    muted: false,
                    hovered: false,
                    baseOverride: DuskColors.accent
                )
            } else {
                DesignWellFace(shape: shape, focused: false, showsInsetHighlights: true)
            }
            shape.stroke(
                isOn && isEnabled
                    ? DuskColors.line.overlaying(DuskColors.accent, opacity: 0.48)
                    : DuskColors.line,
                lineWidth: DesignMetrics.hairline
            )
            if isOn {
                Image(systemName: "checkmark")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(isEnabled ? DuskColors.bgSunk : DuskColors.ink4)
            }
        }
        .frame(width: DesignMetrics.checkboxSize, height: DesignMetrics.checkboxSize)
        .clipShape(shape)
        .background {
            ZStack {
                if !isEnabled {
                    DesignSpreadShadow(
                        shape: shape,
                        color: .black.opacity(DesignMaterialAdapter.slateDisabledBlack),
                        geometry: DesignMaterialShadowGeometry.slateDisabled
                    )
                } else if pressed {
                    DesignSpreadShadow(
                        shape: shape,
                        color: .black.opacity(DesignMaterialAdapter.slatePressedBlack),
                        geometry: DesignMaterialShadowGeometry.slatePressed
                    )
                } else if isOn {
                    DesignSpreadShadow(
                        shape: shape,
                        color: .black.opacity(DesignMaterialAdapter.slateRestBlack),
                        geometry: DesignMaterialShadowGeometry.slateRest
                    )
                    DesignSpreadShadow(
                        shape: shape,
                        color: DuskColors.accent.opacity(0.50),
                        geometry: DesignDropShadowGeometry(radius: 15, y: 9, sourceInset: 12)
                    )
                }
                DesignSpreadShadow(
                    shape: shape,
                    color: DuskColors.bgSunk.opacity(0.88),
                    geometry: DesignDropShadowGeometry(radius: 0, y: pressed ? 1 : 2, sourceInset: 1)
                )
            }
        }
    }
}

private struct DesignCheckboxStyle: ToggleStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        Button(action: { configuration.isOn.toggle() }) {
            HStack(spacing: DesignMetrics.checkboxGap) {
                DesignCheckboxMark(isOn: configuration.isOn, isEnabled: isEnabled)
                configuration.label
                    .font(Typo.ui(DesignMetrics.controlLabelSize))
                    .foregroundStyle(isEnabled ? DuskColors.ink2 : DuskColors.ink4)
            }
            .frame(minHeight: DesignMetrics.minimumTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(DesignTogglePressStyle())
        .animation(
            DesignV2.Motion.animation(duration: DesignV2.Motion.feedback, reduceMotion: reduceMotion),
            value: configuration.isOn
        )
    }
}

struct DesignCheckbox: View {
    let title: String
    @Binding var isOn: Bool
    var isEnabled = true
    var accessibilityId: String? = nil

    var body: some View {
        Toggle(isOn: $isOn) { Text(title) }
            .toggleStyle(DesignCheckboxStyle())
            .disabled(!isEnabled)
            .accessibilityLabel(title)
            .accessibilityValue(isEnabled ? (isOn ? "Checked" : "Unchecked") : "Disabled")
            .accessibilityIdentifier(accessibilityId ?? "")
            .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}
