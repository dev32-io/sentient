import SwiftUI

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
                designFieldError(message: error, accessibilityId: accessibilityId.map { "\($0)-error" })
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
                designFieldError(message: error, accessibilityId: accessibilityId.map { "\($0)-error" })
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

private enum DesignSliderMetrics {
    static let labelRowGap: CGFloat = 7
    // A nonzero mask keeps SwiftUI's platform Slider mounted and semantic;
    // this sub-pixel alpha rounds to transparent in an 8-bit output channel.
    static let nativeChromeMaskOpacity = 0.000_001
}

/// Projects caller-owned value, direction, focus, and availability into the
/// decorative range profile. The native Slider remains the only value owner.
struct DesignSliderCanvasProjection: Equatable {
    let normalizedProgress: CGFloat
    let layoutDirection: LayoutDirection
    let state: DesignCanvasControlState
    let increasedContrast: Bool
    let reduceMotion: Bool

    static func make(
        value: Double,
        range: ClosedRange<Double>,
        layoutDirection: LayoutDirection,
        isFocused: Bool,
        isEnabled: Bool,
        increasedContrast: Bool,
        reduceMotion: Bool
    ) -> DesignSliderCanvasProjection {
        DesignSliderCanvasProjection(
            normalizedProgress: DesignCanvasProgressGeometry.normalized(
                value: value,
                lowerBound: range.lowerBound,
                upperBound: range.upperBound
            ),
            layoutDirection: layoutDirection,
            state: DesignCanvasControlState(
                isFocused: isFocused && isEnabled,
                isDisabled: !isEnabled
            ),
            increasedContrast: increasedContrast,
            reduceMotion: reduceMotion
        )
    }

    var profile: DesignCanvasSmallControlProfile {
        .slider(
            normalizedProgress: normalizedProgress,
            layoutDirection: layoutDirection
        )
    }
}

/// Decorative-only adapter around the reviewed small-control slider profile.
/// It never receives a gesture, focus binding, accessibility value, or action.
private struct DesignSliderCanvasBackground: View {
    let projection: DesignSliderCanvasProjection

    var body: some View {
        DesignCanvasSmallControlKernel(
            profile: projection.profile,
            state: projection.state,
            increasedContrast: projection.increasedContrast,
            reduceMotion: projection.reduceMotion
        )
        .animation(
            DesignCanvasSmallControlKernel.transitionAnimation(
                for: .feedback,
                reduceMotion: projection.reduceMotion
            ),
            value: projection.state.isFocused
        )
        .animation(
            DesignCanvasSmallControlKernel.transitionAnimation(
                for: .material,
                reduceMotion: projection.reduceMotion
            ),
            value: projection.state.isDisabled
        )
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// Shared slider interaction body. This is the only place the transparent
/// native Slider and decorative Canvas track/thumb are composed. Callers keep
/// ownership of their surrounding label, detail, and formatted-output layout.
struct DesignSliderControlBody: View {
    @Binding var value: Double
    let range: ClosedRange<Double>
    let step: Double
    let accessibilityLabel: String
    let accessibilityValue: String
    var accessibilityHint = ""
    let accessibilityId: String
    var isEnabled = true

    @FocusState private var focused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.layoutDirection) private var layoutDirection

    var body: some View {
        // Keep the native Slider as the sole hit-testing, focus, keyboard,
        // adjustment, and accessibility owner. Only its chrome is transparent.
        Slider(value: $value, in: range, step: step) { Text(accessibilityLabel) }
            .labelsHidden()
            .tint(.clear)
            // A nonzero mask keeps the native control mounted while rounding
            // its platform chrome to transparent in an 8-bit output channel.
            .mask {
                Color.black.opacity(DesignSliderMetrics.nativeChromeMaskOpacity)
            }
            .focused($focused)
            .disabled(!isEnabled)
            .frame(
                minWidth: DesignMetrics.sliderMinimumTrackWidth,
                maxWidth: .infinity,
                minHeight: DesignMetrics.minimumTarget
            )
            .accessibilityLabel(accessibilityLabel)
            .accessibilityValue(accessibilityValue)
            .accessibilityHint(accessibilityHint)
            .accessibilityIdentifier(accessibilityId)
            // The Canvas receives the Slider's exact proposal and can neither
            // expand layout nor become a hit/accessibility owner.
            .background {
                DesignSliderCanvasBackground(projection: canvasProjection)
            }
    }

    private var canvasProjection: DesignSliderCanvasProjection {
        DesignSliderCanvasProjection.make(
            value: value,
            range: range,
            layoutDirection: layoutDirection,
            isFocused: focused,
            isEnabled: isEnabled,
            increasedContrast: contrast == .increased,
            reduceMotion: reduceMotion
        )
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
        VStack(alignment: .leading, spacing: DesignSliderMetrics.labelRowGap) {
            Text(title)
                // The handoff uses the 14px control size at the default
                // Dynamic Type scale; `.body` keeps that native size while
                // still scaling with the user's accessibility setting.
                .font(
                    .custom(
                        DesignTypographyAdapter.uiMediumFace,
                        size: DesignMetrics.controlLabelSize,
                        relativeTo: .body
                    )
                )
                // Align the native baseline with the CSS line box without
                // changing the slider row's measured height.
                .baselineOffset(1)
                .foregroundStyle(DuskColors.ink)
                .frame(
                    minHeight: DesignMetrics.controlLabelSize * CGFloat(DesignV2.Typography.lineNormal),
                    alignment: .leading
                )
            HStack(spacing: Space.md) {
                DesignSliderControlBody(
                    value: $value,
                    range: range,
                    step: step,
                    accessibilityLabel: title,
                    accessibilityValue: formattedValue,
                    accessibilityId: accessibilityId ?? "",
                    isEnabled: isEnabled
                )
                if format != nil {
                    Text(formattedValue)
                        .font(Typo.mono(TypeScale.sm))
                        .foregroundStyle(DuskColors.ink2)
                        .frame(minWidth: DesignMetrics.sliderOutputWidth, alignment: .trailing)
                        .accessibilityHidden(true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, minHeight: DesignMetrics.minimumTarget, alignment: .leading)
    }

    private var formattedValue: String {
        format?(value) ?? String(value)
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
