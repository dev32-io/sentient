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

private struct DesignSliderThumb: View {
    let focused: Bool
    let enabled: Bool

    var body: some View {
        Circle()
            .fill(
                RadialGradient(
                    stops: [
                        .init(color: DuskColors.paper.overlaying(DuskColors.bgSunk, opacity: 0.22), location: 0),
                        .init(color: .clear, location: 0.72),
                    ],
                    center: UnitPoint(x: 0.5, y: 0.55),
                    startRadius: 0,
                    endRadius: DesignMetrics.sliderThumbSize
                )
            )
            .overlay {
                Circle()
                    .fill(
                        LinearGradient(
                            colors: [DuskColors.paper.overlaying(DuskColors.ink2, opacity: 0.05), DuskColors.paper],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                    .opacity(0.62)
            }
            .overlay {
                Circle().stroke(DuskColors.line, lineWidth: DesignMetrics.hairline)
            }
            .overlay {
                if focused {
                    Circle().stroke(DuskColors.accent, lineWidth: DesignMetrics.focusBorder).padding(DesignMetrics.focusBorderInset)
                }
            }
            .clipShape(Circle())
            .background {
                ZStack {
                    DesignSpreadShadow(
                        shape: Circle(),
                        color: .black.opacity(enabled ? 0.94 : DesignMaterialAdapter.slateDisabledBlack),
                        geometry: enabled
                            ? DesignMaterialShadowGeometry.slateRest
                            : DesignMaterialShadowGeometry.slateDisabled
                    )
                    if enabled {
                        DesignSpreadShadow(
                            shape: Circle(),
                            color: DuskColors.accent.opacity(0.20),
                            geometry: DesignDropShadowGeometry(radius: 16, y: 10, sourceInset: 13)
                        )
                    }
                    DesignSpreadShadow(
                        shape: Circle(),
                        color: DuskColors.bgSunk.opacity(0.88),
                        geometry: DesignDropShadowGeometry(radius: 0, y: 2, sourceInset: 1)
                    )
                }
            }
            .frame(width: DesignMetrics.sliderThumbSize, height: DesignMetrics.sliderThumbSize)
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
    @FocusState private var focused: Bool

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
            Text(title)
                .font(Typo.ui(DesignMetrics.controlLabelSize, .medium))
                .foregroundStyle(DuskColors.ink)
            HStack(spacing: Space.md) {
                ZStack {
                    GeometryReader { proxy in
                        let width = proxy.size.width
                        let thumbX = min(max(normalizedValue * width, DesignMetrics.sliderThumbSize / 2), width - DesignMetrics.sliderThumbSize / 2)
                        ZStack(alignment: .leading) {
                            Capsule()
                                .fill(DuskColors.bgSunk)
                                .frame(maxWidth: .infinity)
                                .frame(height: DesignMetrics.sliderTrackHeight)
                                .shadow(color: DuskColors.line.opacity(DesignMaterialAdapter.wellLineOpacity), radius: 0, y: 1)
                                .offset(y: 18)
                            Capsule()
                                .fill(
                                    DuskColors.accentSoft.overlaying(DuskColors.accent, opacity: 0.58)
                                )
                                .frame(width: max(0, width * normalizedValue), height: DesignMetrics.sliderTrackHeight)
                                .offset(y: 18)
                            DesignSliderThumb(focused: focused, enabled: isEnabled)
                                .position(x: thumbX, y: 22)
                        }
                    }
                    .allowsHitTesting(false)
                    Slider(value: $value, in: range, step: step) { Text(title) }
                        .labelsHidden()
                        .tint(.clear)
                        .opacity(0.01)
                        .focused($focused)
                        .disabled(!isEnabled)
                        .accessibilityLabel(title)
                        .accessibilityValue(isEnabled ? (format?(value) ?? String(value)) : "Disabled")
                        .accessibilityIdentifier(accessibilityId ?? "")
                }
                .frame(minWidth: DesignMetrics.sliderMinimumTrackWidth, minHeight: DesignMetrics.minimumTarget)
                if let format {
                    Text(format(value))
                        .font(Typo.mono(TypeScale.sm))
                        .foregroundStyle(DuskColors.ink2)
                        .frame(minWidth: DesignMetrics.sliderOutputWidth, alignment: .trailing)
                }
            }
            .opacity(isEnabled ? 1 : DesignMaterialAdapter.selectDisabledOpacity)
            .saturation(isEnabled ? 1 : 0.35)
        }
        .frame(minHeight: DesignMetrics.minimumTarget)
        .padding(.vertical, Space.sm)
    }

    private var normalizedValue: CGFloat {
        guard range.upperBound > range.lowerBound else { return 0 }
        return CGFloat(min(max((value - range.lowerBound) / (range.upperBound - range.lowerBound), 0), 1))
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
