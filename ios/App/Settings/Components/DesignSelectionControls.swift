import SwiftUI

/// Stable projection from native interaction state into the decorative
/// selection-control kernels. Native Button, Toggle, and Menu views remain the
/// only interaction and accessibility owners.
struct DesignSelectionControlProjection: Equatable {
    let state: DesignCanvasControlState
    let increasedContrast: Bool
    let reduceMotion: Bool

    static func make(
        isEnabled: Bool,
        isPressed: Bool = false,
        isFocused: Bool = false,
        isHovered: Bool = false,
        increasedContrast: Bool,
        reduceMotion: Bool
    ) -> DesignSelectionControlProjection {
        DesignSelectionControlProjection(
            state: DesignCanvasControlState(
                isHovered: isHovered && isEnabled,
                isPressed: isPressed && isEnabled,
                isFocused: isFocused && isEnabled,
                isDisabled: !isEnabled
            ),
            increasedContrast: increasedContrast,
            reduceMotion: reduceMotion
        )
    }
}

struct DesignChipCanvasProjection: Equatable {
    let profile: DesignCanvasSmallControlProfile
    let control: DesignSelectionControlProjection
    let yOffset: CGFloat

    static func make(
        selected: Bool,
        isEnabled: Bool,
        isPressed: Bool,
        isFocused: Bool,
        isHovered: Bool,
        increasedContrast: Bool,
        reduceMotion: Bool
    ) -> DesignChipCanvasProjection {
        let control = DesignSelectionControlProjection.make(
            isEnabled: isEnabled,
            isPressed: isPressed,
            isFocused: isFocused,
            isHovered: isHovered,
            increasedContrast: increasedContrast,
            reduceMotion: reduceMotion
        )
        let yOffset: CGFloat
        if control.state.isPressed {
            // The selected receiver closes a second point into its well; the
            // raised chip closes only its one-point air gap.
            yOffset = selected ? DesignMetrics.pressedDepth * 2 : DesignMetrics.pressedDepth
        } else if control.state.isHovered && !selected {
            yOffset = -DesignMetrics.pressedDepth
        } else {
            yOffset = 0
        }
        return DesignChipCanvasProjection(
            profile: selected ? .selectedChip : .raisedChip,
            control: control,
            yOffset: yOffset
        )
    }
}

struct DesignToggleCanvasProjection: Equatable {
    let onAmount: CGFloat
    let layoutDirection: LayoutDirection
    let control: DesignSelectionControlProjection

    static func make(
        isOn: Bool,
        layoutDirection: LayoutDirection,
        isEnabled: Bool,
        isPressed: Bool,
        isFocused: Bool,
        increasedContrast: Bool,
        reduceMotion: Bool
    ) -> DesignToggleCanvasProjection {
        DesignToggleCanvasProjection(
            onAmount: isOn ? 1 : 0,
            layoutDirection: layoutDirection,
            control: DesignSelectionControlProjection.make(
                isEnabled: isEnabled,
                isPressed: isPressed,
                isFocused: isFocused,
                increasedContrast: increasedContrast,
                reduceMotion: reduceMotion
            )
        )
    }

    var profile: DesignCanvasSmallControlProfile {
        .toggle(onAmount: onAmount, layoutDirection: layoutDirection)
    }
}

struct DesignCheckboxCanvasProjection: Equatable {
    let isChecked: Bool
    let control: DesignSelectionControlProjection
    let yOffset: CGFloat

    static func make(
        isChecked: Bool,
        isEnabled: Bool,
        isPressed: Bool,
        isFocused: Bool,
        isHovered: Bool,
        increasedContrast: Bool,
        reduceMotion: Bool
    ) -> DesignCheckboxCanvasProjection {
        let control = DesignSelectionControlProjection.make(
            isEnabled: isEnabled,
            isPressed: isPressed,
            isFocused: isFocused,
            isHovered: isHovered,
            increasedContrast: increasedContrast,
            reduceMotion: reduceMotion
        )
        return DesignCheckboxCanvasProjection(
            isChecked: isChecked,
            control: control,
            yOffset: control.state.isPressed
                ? DesignMetrics.pressedDepth
                : control.state.isHovered && isChecked
                    ? -DesignMetrics.pressedDepth
                    : 0
        )
    }

    var profile: DesignCanvasSmallControlProfile { .checkbox(isChecked: isChecked) }
}

struct DesignSelectCanvasProjection: Equatable {
    let state: DesignCanvasWellState
    let increasedContrast: Bool
    let reduceMotion: Bool

    static func make(
        isEnabled: Bool,
        isFocused: Bool,
        increasedContrast: Bool,
        reduceMotion: Bool
    ) -> DesignSelectCanvasProjection {
        DesignSelectCanvasProjection(
            state: DesignCanvasWellState(
                isFocused: isFocused && isEnabled,
                isDisabled: !isEnabled
            ),
            increasedContrast: increasedContrast,
            reduceMotion: reduceMotion
        )
    }
}

private struct DesignControlPressedKey: EnvironmentKey {
    static let defaultValue = false
}

private extension EnvironmentValues {
    var designControlPressed: Bool {
        get { self[DesignControlPressedKey.self] }
        set { self[DesignControlPressedKey.self] = newValue }
    }
}

private struct DesignToggleCanvasBackground: View, Animatable {
    var onAmount: CGFloat
    let layoutDirection: LayoutDirection
    let control: DesignSelectionControlProjection

    init(projection: DesignToggleCanvasProjection) {
        onAmount = projection.onAmount
        layoutDirection = projection.layoutDirection
        control = projection.control
    }

    var animatableData: CGFloat {
        get { onAmount }
        set { onAmount = newValue }
    }

    private var projection: DesignToggleCanvasProjection {
        DesignToggleCanvasProjection(
            onAmount: onAmount,
            layoutDirection: layoutDirection,
            control: control
        )
    }

    var body: some View {
        DesignCanvasSmallControlKernel(
            profile: projection.profile,
            state: control.state,
            increasedContrast: control.increasedContrast,
            reduceMotion: control.reduceMotion
        )
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private struct DesignToggleTrack: View {
    @Environment(\.designControlPressed) private var pressed
    @Environment(\.layoutDirection) private var layoutDirection
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast

    let isOn: Bool
    let isEnabled: Bool
    let isFocused: Bool

    private var projection: DesignToggleCanvasProjection {
        DesignToggleCanvasProjection.make(
            isOn: isOn,
            layoutDirection: layoutDirection,
            isEnabled: isEnabled,
            isPressed: pressed,
            isFocused: isFocused,
            increasedContrast: contrast == .increased,
            reduceMotion: reduceMotion
        )
    }

    var body: some View {
        DesignToggleCanvasBackground(projection: projection)
            .frame(width: DesignMetrics.toggleWidth, height: DesignMetrics.toggleHeight)
            .animation(
                DesignCanvasSmallControlKernel.transitionAnimation(
                    for: .toggleTravel,
                    reduceMotion: reduceMotion
                ),
                value: projection.onAmount
            )
            .animation(
                DesignCanvasSmallControlKernel.transitionAnimation(
                    for: .feedback,
                    reduceMotion: reduceMotion
                ),
                value: projection.control.state.isFocused
            )
            .animation(
                DesignCanvasSmallControlKernel.transitionAnimation(
                    for: .material,
                    reduceMotion: reduceMotion
                ),
                value: isEnabled
            )
            .transaction { transaction in
                if reduceMotion {
                    transaction.animation = nil
                    transaction.disablesAnimations = true
                }
            }
    }
}

private struct DesignTogglePressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        // Press state is projected into the knob material. The native Toggle
        // target and its label do not scale or move.
        configuration.label
            .environment(\.designControlPressed, configuration.isPressed)
    }
}

private struct DesignToggleStyle: ToggleStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.isFocused) private var focused

    func makeBody(configuration: Configuration) -> some View {
        Button(action: { configuration.isOn.toggle() }) {
            HStack(spacing: Space.md) {
                configuration.label
                Spacer(minLength: Space.sm)
                DesignToggleTrack(
                    isOn: configuration.isOn,
                    isEnabled: isEnabled,
                    isFocused: focused
                )
            }
            .frame(minHeight: DesignMetrics.minimumTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(DesignTogglePressStyle())
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
                if let detail {
                    Text(detail)
                        .font(Typo.ui(TypeScale.sm))
                        .foregroundStyle(DuskColors.ink2)
                }
            }
        }
        .toggleStyle(DesignToggleStyle())
        .disabled(!isEnabled)
        .frame(minHeight: DesignMetrics.minimumTarget)
        .contentShape(Rectangle())
        .accessibilityLabel(title)
        .accessibilityValue(isEnabled ? (isOn ? "On" : "Off") : "Disabled")
        .accessibilityHint(detail ?? "")
        .accessibilityIdentifier(accessibilityId ?? "")
    }
}

private struct DesignSegmentBoundsPreferenceKey: PreferenceKey {
    static var defaultValue: [Int: Anchor<CGRect>] = [:]

    static func reduce(
        value: inout [Int: Anchor<CGRect>],
        nextValue: () -> [Int: Anchor<CGRect>]
    ) {
        value.merge(nextValue(), uniquingKeysWith: { _, next in next })
    }
}

private struct DesignSegmentPressedPreferenceKey: PreferenceKey {
    static var defaultValue: [Int: Bool] = [:]

    static func reduce(value: inout [Int: Bool], nextValue: () -> [Int: Bool]) {
        value.merge(nextValue(), uniquingKeysWith: { _, next in next })
    }
}

private struct DesignSegmentFocusedPreferenceKey: PreferenceKey {
    static var defaultValue: [Int: Bool] = [:]

    static func reduce(value: inout [Int: Bool], nextValue: () -> [Int: Bool]) {
        value.merge(nextValue(), uniquingKeysWith: { _, next in next })
    }
}

private struct DesignSegmentButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isFocused) private var focused
    let index: Int

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            // Segment press feedback is immediate and independent from the
            // selected slate's caller-owned 220ms travel.
            .offset(
                y: configuration.isPressed && !reduceMotion
                    ? DesignMetrics.pressedDepth
                    : 0
            )
            .preference(
                key: DesignSegmentPressedPreferenceKey.self,
                value: [index: configuration.isPressed]
            )
            .preference(
                key: DesignSegmentFocusedPreferenceKey.self,
                value: [index: focused]
            )
    }
}

private struct DesignSegmentedCanvasBackground: View, Animatable {
    var selectionBounds: CGRect?
    let focusBounds: CGRect?
    let pressedBounds: CGRect?
    let control: DesignSelectionControlProjection

    private var animatedRect: CGRect {
        selectionBounds ?? .zero
    }

    var animatableData: AnimatablePair<
        AnimatablePair<CGFloat, CGFloat>,
        AnimatablePair<CGFloat, CGFloat>
    > {
        get {
            AnimatablePair(
                AnimatablePair(animatedRect.origin.x, animatedRect.origin.y),
                AnimatablePair(animatedRect.size.width, animatedRect.size.height)
            )
        }
        set {
            guard selectionBounds != nil else { return }
            selectionBounds = CGRect(
                x: newValue.first.first,
                y: newValue.first.second,
                width: newValue.second.first,
                height: newValue.second.second
            )
        }
    }

    private var profile: DesignCanvasSmallControlProfile {
        .segmented(geometry: DesignCanvasSegmentGeometry(
            selectionBounds: selectionBounds,
            focusBounds: focusBounds,
            pressedBounds: pressedBounds
        ))
    }

    var body: some View {
        DesignCanvasSmallControlKernel(
            profile: profile,
            state: control.state,
            increasedContrast: control.increasedContrast,
            reduceMotion: control.reduceMotion
        )
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

struct DesignSegmentedPicker<Value: Hashable>: View {
    let title: String
    let options: [(value: Value, label: String)]
    @Binding var selection: Value
    var accessibilityId: String? = nil
    var isEnabled = true
    var visualHeight: CGFloat

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast
    @State private var pressedSegments: [Int: Bool] = [:]
    @State private var focusedSegments: [Int: Bool] = [:]

    init(
        title: String,
        options: [(value: Value, label: String)],
        selection: Binding<Value>,
        accessibilityId: String? = nil,
        isEnabled: Bool = true,
        visualHeight: CGFloat = DesignMetrics.minimumTarget
    ) {
        self.title = title
        self.options = options
        _selection = selection
        self.accessibilityId = accessibilityId
        self.isEnabled = isEnabled
        self.visualHeight = visualHeight
    }

    var body: some View {
        HStack(spacing: DesignMetrics.segmentGap) {
            ForEach(Array(options.enumerated()), id: \.offset) { index, option in
                let selected = selection == option.value
                Button {
                    selection = option.value
                } label: {
                    Text(option.label)
                        // A 15pt native DM Sans run preserves the reviewed
                        // 14px browser label's intrinsic visual footprint.
                        .font(Typo.ui(TypeScale.base))
                        .baselineOffset(
                            DesignMetrics.actionButtonTextBaselineOffset
                                - DesignMetrics.hairline / 2
                        )
                        .foregroundStyle(selected ? DuskColors.accent : DuskColors.ink)
                        .frame(maxWidth: .infinity, minHeight: segmentFaceHeight)
                        .padding(
                            .horizontal,
                            DesignMetrics.segmentHorizontalPadding + DesignMetrics.hairline
                        )
                        .contentShape(Rectangle())
                        .anchorPreference(
                            key: DesignSegmentBoundsPreferenceKey.self,
                            value: .bounds,
                            transform: { [index: $0] }
                        )
                }
                .buttonStyle(DesignSegmentButtonStyle(index: index))
                .frame(
                    minWidth: DesignMetrics.minimumTarget,
                    minHeight: DesignMetrics.minimumTarget
                )
                .contentShape(Rectangle())
                .disabled(!isEnabled)
                .accessibilityLabel(option.label)
                .accessibilityValue(selected ? "Selected" : "Not selected")
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(.horizontal, DesignMetrics.segmentBedPadding)
        .frame(minHeight: DesignMetrics.minimumTarget)
        .backgroundPreferenceValue(DesignSegmentBoundsPreferenceKey.self) { anchors in
            GeometryReader { proxy in
                let semanticAirGap = max(
                    0,
                    DesignMetrics.minimumTarget - segmentFaceHeight
                )
                let measuredFrames = anchors.mapValues { anchor in
                    let semanticFrame = proxy[anchor]
                    let faceHeight = max(
                        segmentFaceHeight,
                        semanticFrame.height - semanticAirGap
                    )
                    return CGRect(
                        x: semanticFrame.minX,
                        y: semanticFrame.midY - faceHeight / 2,
                        width: semanticFrame.width,
                        height: faceHeight
                    )
                }
                let measuredFaceHeight = measuredFrames.values
                    .map(\.height)
                    .max() ?? 0
                let adaptiveBedHeight = measuredFaceHeight
                    + DesignMetrics.segmentBedPadding * 2
                let bedHeight = min(
                    max(max(visualHeight, adaptiveBedHeight), 0),
                    proxy.size.height
                )
                let bedOriginY = (proxy.size.height - bedHeight) / 2
                let measurements = measuredFrames.map { index, frame in
                    DesignCanvasMeasuredSelection(
                        id: AnyHashable(index),
                        bounds: frame.offsetBy(dx: 0, dy: -bedOriginY)
                    )
                }
                let selectedIndex = options.firstIndex(where: { $0.value == selection })
                let selectionBounds = DesignCanvasMeasuredSelectionGeometry.bounds(
                    selectedID: selectedIndex.map(AnyHashable.init),
                    measurements: measurements
                )
                let focusIndex = focusedSegments.first(where: { $0.value })?.key
                let pressedIndex = pressedSegments.first(where: { $0.value })?.key
                let focusBounds = DesignCanvasMeasuredSelectionGeometry.bounds(
                    selectedID: focusIndex.map(AnyHashable.init),
                    measurements: measurements
                )
                let pressedBounds = DesignCanvasMeasuredSelectionGeometry.bounds(
                    selectedID: pressedIndex.map(AnyHashable.init),
                    measurements: measurements
                )
                let control = DesignSelectionControlProjection.make(
                    isEnabled: isEnabled,
                    isPressed: pressedIndex != nil,
                    isFocused: focusIndex != nil,
                    increasedContrast: contrast == .increased,
                    reduceMotion: reduceMotion
                )

                DesignSegmentedCanvasBackground(
                    selectionBounds: selectionBounds,
                    focusBounds: focusBounds,
                    pressedBounds: pressedBounds,
                    control: control
                )
                .frame(width: proxy.size.width, height: bedHeight)
                .position(x: proxy.size.width / 2, y: proxy.size.height / 2)
                .animation(
                    DesignCanvasSmallControlKernel.transitionAnimation(
                        for: .selectionTravel,
                        reduceMotion: reduceMotion
                    ),
                    value: selectionBounds
                )
                .animation(
                    DesignCanvasSmallControlKernel.transitionAnimation(
                        for: .feedback,
                        reduceMotion: reduceMotion
                    ),
                    value: focusIndex
                )
                .transaction { transaction in
                    if reduceMotion {
                        transaction.animation = nil
                        transaction.disablesAnimations = true
                    }
                }
            }
        }
        .onPreferenceChange(DesignSegmentPressedPreferenceKey.self) {
            pressedSegments = $0
        }
        .onPreferenceChange(DesignSegmentFocusedPreferenceKey.self) {
            focusedSegments = $0
        }
        .opacity(isEnabled ? 1 : DesignMaterialAdapter.selectDisabledOpacity)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title)
        .accessibilityValue(isEnabled ? selectedLabel : "Disabled")
        .accessibilityIdentifier(accessibilityId ?? "")
    }

    private var segmentFaceHeight: CGFloat {
        visualHeight == DesignMetrics.actionButtonVisualHeight
            ? DesignMetrics.segmentHeight - DesignMetrics.segmentBedPadding
            : DesignMetrics.segmentHeight
    }

    private var selectedLabel: String {
        options.first(where: { $0.value == selection })?.label ?? "Not selected"
    }
}

enum DesignMenuTriggerWidth: Equatable {
    case intrinsic
    case fixed(CGFloat)
    case flexible(minimum: CGFloat)
}

private struct DesignMenuTriggerCanvasBackground: View {
    let projection: DesignSelectCanvasProjection

    var body: some View {
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

/// The single closed-trigger label used by native Menu wrappers. Canvas owns
/// only the well pixels; the selected text and chevron are hidden from AX so
/// the enclosing Menu announces its explicit label/value exactly once.
struct DesignMenuTriggerLabel: View {
    let currentLabel: String
    let isEnabled: Bool
    var width: DesignMenuTriggerWidth = .intrinsic

    @Environment(\.isFocused) private var focused
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast

    private var projection: DesignSelectCanvasProjection {
        DesignSelectCanvasProjection.make(
            isEnabled: isEnabled,
            isFocused: focused,
            increasedContrast: contrast == .increased,
            reduceMotion: reduceMotion
        )
    }

    var body: some View {
        sizedLabel
            .padding(.horizontal, Space.md)
            .frame(
                minWidth: DesignMetrics.minimumTarget,
                minHeight: DesignMetrics.minimumTarget
            )
            .contentShape(Rectangle())
            .background {
                DesignMenuTriggerCanvasBackground(projection: projection)
            }
    }

    @ViewBuilder
    private var sizedLabel: some View {
        switch width {
        case .intrinsic:
            label
        case .fixed(let width):
            label.frame(width: max(0, width - Space.md * 2))
        case .flexible(let minimum):
            label.frame(
                minWidth: max(0, minimum - Space.md * 2),
                maxWidth: .infinity
            )
        }
    }

    private var label: some View {
        HStack(spacing: Space.xs) {
            Text(currentLabel)
                .font(Typo.ui(DesignMetrics.controlLabelSize))
                .foregroundStyle(isEnabled ? DuskColors.ink : DuskColors.ink4)
                .lineLimit(1)
                .accessibilityHidden(true)
            if width != .intrinsic {
                Spacer(minLength: Space.sm)
            }
            Image(systemName: "chevron.up.chevron.down")
                .font(Typo.ui(TypeScale.sm, .medium))
                .foregroundStyle(isEnabled ? DuskColors.ink2 : DuskColors.ink4)
                .accessibilityHidden(true)
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
                    .font(Typo.ui(DesignMetrics.controlLabelSize, .medium))
                    .foregroundStyle(DuskColors.ink)
                if let detail {
                    Text(detail)
                        .font(Typo.ui(TypeScale.sm))
                        .foregroundStyle(DuskColors.ink2)
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
                DesignMenuTriggerLabel(
                    currentLabel: currentLabel,
                    isEnabled: isEnabled
                )
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
    @Environment(\.isFocused) private var focused
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast

    let selected: Bool
    let hovered: Bool

    func makeBody(configuration: Configuration) -> some View {
        let projection = DesignChipCanvasProjection.make(
            selected: selected,
            isEnabled: isEnabled,
            isPressed: configuration.isPressed,
            isFocused: focused,
            isHovered: hovered,
            increasedContrast: contrast == .increased,
            reduceMotion: reduceMotion
        )

        configuration.label
            // Material state never changes the label's intrinsic footprint.
            .font(Typo.ui(TypeScale.base, .regular))
            .foregroundStyle(
                isEnabled
                    ? selected ? DuskColors.accent : DuskColors.ink
                    : DuskColors.ink4
            )
            .padding(.horizontal, Space.md + DesignMetrics.hairline)
            .frame(minHeight: DesignMaterialAdapter.chipVisualHeight)
            .contentShape(Capsule())
            .background {
                DesignCanvasSmallControlKernel(
                    profile: projection.profile,
                    state: projection.control.state,
                    increasedContrast: projection.control.increasedContrast,
                    reduceMotion: projection.control.reduceMotion
                )
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
            .offset(y: projection.yOffset)
            .animation(
                DesignCanvasSmallControlKernel.transitionAnimation(
                    for: .feedback,
                    reduceMotion: reduceMotion
                ),
                value: projection.control.state.isHovered
            )
            .animation(
                DesignCanvasSmallControlKernel.transitionAnimation(
                    for: .feedback,
                    reduceMotion: reduceMotion
                ),
                value: projection.control.state.isFocused
            )
            .animation(
                DesignCanvasSmallControlKernel.transitionAnimation(
                    for: .material,
                    reduceMotion: reduceMotion
                ),
                value: selected
            )
            .animation(nil, value: projection.control.state.isPressed)
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
            .frame(
                minWidth: DesignMetrics.minimumTarget,
                minHeight: DesignMetrics.minimumTarget
            )
            .contentShape(Rectangle())
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
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let isOn: Bool
    let isEnabled: Bool
    let hovered: Bool
    let focused: Bool

    private var projection: DesignCheckboxCanvasProjection {
        DesignCheckboxCanvasProjection.make(
            isChecked: isOn,
            isEnabled: isEnabled,
            isPressed: pressed,
            isFocused: focused,
            isHovered: hovered,
            increasedContrast: contrast == .increased,
            reduceMotion: reduceMotion
        )
    }

    var body: some View {
        ZStack {
            DesignCanvasSmallControlKernel(
                profile: projection.profile,
                state: projection.control.state,
                increasedContrast: projection.control.increasedContrast,
                reduceMotion: projection.control.reduceMotion
            )
            .allowsHitTesting(false)
            .accessibilityHidden(true)

            Image(systemName: "checkmark")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(isEnabled ? DuskColors.bgSunk : DuskColors.ink4)
                .opacity(isOn ? 1 : 0)
                .scaleEffect(isOn ? 1 : 0.7)
                .accessibilityHidden(true)
        }
        .frame(width: DesignMetrics.checkboxSize, height: DesignMetrics.checkboxSize)
        .offset(y: projection.yOffset)
        .animation(
            DesignCanvasSmallControlKernel.transitionAnimation(
                for: .material,
                reduceMotion: reduceMotion
            ),
            value: isOn
        )
        .animation(
            DesignCanvasSmallControlKernel.transitionAnimation(
                for: .feedback,
                reduceMotion: reduceMotion
            ),
            value: hovered
        )
        .animation(nil, value: pressed)
    }
}

private struct DesignCheckboxPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        // Only the mark closes its air gap; the full native label target stays
        // stationary while receiving the press through this environment value.
        configuration.label
            .environment(\.designControlPressed, configuration.isPressed)
    }
}

private struct DesignCheckboxStyle: ToggleStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.isFocused) private var focused

    let hovered: Bool

    func makeBody(configuration: Configuration) -> some View {
        Button(action: { configuration.isOn.toggle() }) {
            HStack(spacing: DesignMetrics.checkboxGap) {
                DesignCheckboxMark(
                    isOn: configuration.isOn,
                    isEnabled: isEnabled,
                    hovered: hovered,
                    focused: focused
                )
                configuration.label
                    .font(Typo.ui(DesignMetrics.controlLabelSize))
                    .foregroundStyle(isEnabled ? DuskColors.ink2 : DuskColors.ink4)
                    .multilineTextAlignment(.leading)
            }
            .frame(minHeight: DesignMetrics.minimumTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(DesignCheckboxPressStyle())
    }
}

struct DesignCheckbox: View {
    let title: String
    @Binding var isOn: Bool
    var isEnabled = true
    var accessibilityId: String? = nil

    @State private var hovered = false

    var body: some View {
        Toggle(isOn: $isOn) { Text(title) }
            .toggleStyle(DesignCheckboxStyle(hovered: hovered))
            .onHover { hovered = $0 }
            .disabled(!isEnabled)
            .frame(minHeight: DesignMetrics.minimumTarget)
            .contentShape(Rectangle())
            .accessibilityLabel(title)
            .accessibilityValue(isEnabled ? (isOn ? "Checked" : "Unchecked") : "Disabled")
            .accessibilityIdentifier(accessibilityId ?? "")
            .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}
