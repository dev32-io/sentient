import SwiftUI
import UIKit

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
    // These values mirror the range input's source-authored CSS states and
    // geometry. They stay local because they do not change another control's
    // material recipe.
    static let labelRowGap: CGFloat = 7
    static let disabledOpacity = 0.58
    static let disabledSaturation = 0.3
    static let focusTrackRingWidth: CGFloat = 3
    // The CSS track uses a 3px/6px/-2px inner shadow. A direct SwiftUI inner
    // shadow over-darkens an 8pt capsule, so retain its directional falloff as
    // a shape-clipped native gradient instead of changing the track geometry.
    static let trackTopShadowOpacity = 0.44
    static let trackTopShadowMiddleOpacity = 0.03
    static let trackTopShadowMiddleStop: CGFloat = 0.45
    static let trackTopShadowLowerOpacity = 0.04
    static let trackTopShadowLowerStop: CGFloat = 0.55
    static let trackTopShadowBottomOpacity = 0.03
    static let trackBottomHighlight = 0.07
    static let thumbRadialFadeStop: CGFloat = 0.72
}

private func designSliderColor(_ color: Color, isEnabled: Bool) -> Color {
    guard !isEnabled else { return color }

    var red: CGFloat = 0
    var green: CGFloat = 0
    var blue: CGFloat = 0
    var alpha: CGFloat = 0
    guard UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha) else {
        return color
    }

    // CSS `saturate()` uses this luminance matrix. Applying it to the local
    // recipe colors keeps the disabled result independent of the destination
    // behind SwiftUI's transparent compositing group.
    let saturation = DesignSliderMetrics.disabledSaturation
    let luminance = red * 0.213 + green * 0.715 + blue * 0.072
    return Color(
        .sRGB,
        red: luminance + (red - luminance) * saturation,
        green: luminance + (green - luminance) * saturation,
        blue: luminance + (blue - luminance) * saturation,
        opacity: alpha
    )
}

private struct DesignSliderThumb: View {
    let focused: Bool
    let isEnabled: Bool

    private var radialEndRadius: CGFloat {
        // CSS radial gradients default to the farthest corner when no size is
        // supplied. The center is 50% / 55% of the 26pt thumb box.
        let size = DesignMetrics.sliderThumbSize
        let centerX = size * 0.5
        let centerY = size * 0.55
        return (centerX * centerX + centerY * centerY).squareRoot()
    }

    var body: some View {
        Circle()
            .fill(
                LinearGradient(
                    colors: [
                        designSliderColor(
                            DuskColors.paper.overlaying(DuskColors.ink2, opacity: 0.05),
                            isEnabled: isEnabled
                        ),
                        designSliderColor(DuskColors.paper, isEnabled: isEnabled),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
            .overlay {
                Circle()
                    .fill(
                        RadialGradient(
                            stops: [
                                .init(
                                    color: designSliderColor(
                                        DuskColors.paper.overlaying(DuskColors.bgSunk, opacity: 0.22),
                                        isEnabled: isEnabled
                                    ),
                                    location: 0
                                ),
                                .init(color: .clear, location: DesignSliderMetrics.thumbRadialFadeStop),
                            ],
                            center: UnitPoint(x: 0.5, y: 0.55),
                            startRadius: 0,
                            endRadius: radialEndRadius
                        )
                    )
            }
            .clipShape(Circle())
            .overlay {
                Circle().stroke(
                    designSliderColor(DuskColors.line, isEnabled: isEnabled),
                    lineWidth: DesignMetrics.hairline
                )
            }
            .overlay {
                if focused {
                    Circle()
                        .stroke(DuskColors.accent, lineWidth: DesignMetrics.focusBorder)
                        .padding(DesignMetrics.focusBorderInset)
                }
            }
            .background {
                ZStack {
                    DesignSpreadShadow(
                        shape: Circle(),
                        color: designSliderColor(
                            DuskColors.bgSunk.overlaying(DuskColors.line, opacity: 0.12),
                            isEnabled: isEnabled
                        ),
                        geometry: DesignDropShadowGeometry(radius: 0, y: 2, sourceInset: 1)
                    )
                    DesignSpreadShadow(
                        shape: Circle(),
                        color: .black.opacity(DesignMaterialAdapter.slateRestBlack),
                        geometry: DesignMaterialShadowGeometry.slateRest
                    )
                    DesignSpreadShadow(
                        shape: Circle(),
                        color: designSliderColor(DuskColors.accent, isEnabled: isEnabled).opacity(0.44),
                        geometry: DesignDropShadowGeometry(radius: 16, y: 10, sourceInset: 13)
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
    @Environment(\.layoutDirection) private var layoutDirection

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
                        "DMSans-Medium",
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
                ZStack {
                    GeometryReader { proxy in
                        let width = proxy.size.width
                        let thumbTravel = max(width - DesignMetrics.sliderThumbSize, 0)
                        let thumbLeading = min(max(thumbProgress * thumbTravel, 0), thumbTravel)
                        ZStack(alignment: .leading) {
                            sliderTrack
                                .frame(maxWidth: .infinity)
                                .frame(height: DesignMetrics.sliderTrackHeight)
                            HStack(spacing: 0) {
                                Color.clear
                                    .frame(width: thumbLeading)
                                DesignSliderThumb(focused: focused, isEnabled: isEnabled)
                                Spacer(minLength: 0)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(maxWidth: .infinity, minHeight: DesignMetrics.minimumTarget)
                        // The decorative geometry is laid out in a physical
                        // left-to-right space; the semantic Slider remains in
                        // the caller's layout direction below.
                        .environment(\.layoutDirection, .leftToRight)
                    }
                    .frame(height: DesignMetrics.minimumTarget)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                    // Match CSS opacity compositing for the complete range so
                    // its track cannot show through the disabled thumb.
                    .compositingGroup()
                    .opacity(isEnabled ? 1 : DesignSliderMetrics.disabledOpacity)
                    // Keep the native Slider as the sole interaction and
                    // accessibility owner; only its platform chrome is hidden
                    // so the source-authored track and thumb can be rendered.
                    Slider(value: $value, in: range, step: step) { Text(title) }
                        .labelsHidden()
                        .tint(.clear)
                        .opacity(0)
                        .focused($focused)
                        .disabled(!isEnabled)
                        .frame(maxWidth: .infinity, minHeight: DesignMetrics.minimumTarget)
                        .accessibilityLabel(title)
                        // Native disabled semantics announce availability;
                        // retain the explicit current value in every state.
                        .accessibilityValue(format?(value) ?? String(value))
                        .accessibilityIdentifier(accessibilityId ?? "")
                }
                .frame(minWidth: DesignMetrics.sliderMinimumTrackWidth, maxWidth: .infinity, minHeight: DesignMetrics.minimumTarget)
                if let format {
                    Text(format(value))
                        .font(Typo.mono(TypeScale.sm))
                        .foregroundStyle(DuskColors.ink2)
                        .frame(minWidth: DesignMetrics.sliderOutputWidth, alignment: .trailing)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, minHeight: DesignMetrics.minimumTarget, alignment: .leading)
    }

    private var sliderTrack: some View {
        let progressColor = designSliderColor(
            DuskColors.accentSoft.overlaying(DuskColors.accent, opacity: 0.58),
            isEnabled: isEnabled
        )
        let trackColor = designSliderColor(DuskColors.bgSunk, isEnabled: isEnabled)
        let isRightToLeft = layoutDirection == .rightToLeft
        let gradient = LinearGradient(
            stops: [
                .init(color: progressColor, location: 0),
                .init(color: progressColor, location: normalizedValue),
                .init(color: trackColor, location: normalizedValue),
                .init(color: trackColor, location: 1),
            ],
            startPoint: isRightToLeft ? .trailing : .leading,
            endPoint: isRightToLeft ? .leading : .trailing
        )

        return Capsule()
            .fill(gradient)
            .background {
                if focused {
                    Capsule()
                        .stroke(
                            DuskColors.accent.opacity(0.18),
                            lineWidth: DesignSliderMetrics.focusTrackRingWidth * 2
                        )
                }
            }
            .overlay {
                Capsule()
                    .fill(
                        LinearGradient(
                            stops: [
                                .init(color: .black.opacity(DesignSliderMetrics.trackTopShadowOpacity), location: 0),
                                .init(
                                    color: .black.opacity(DesignSliderMetrics.trackTopShadowMiddleOpacity),
                                    location: DesignSliderMetrics.trackTopShadowMiddleStop
                                ),
                                .init(
                                    color: .black.opacity(DesignSliderMetrics.trackTopShadowLowerOpacity),
                                    location: DesignSliderMetrics.trackTopShadowLowerStop
                                ),
                                .init(
                                    color: .black.opacity(DesignSliderMetrics.trackTopShadowBottomOpacity),
                                    location: 1
                                ),
                            ],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
            }
            .overlay(alignment: .bottom) {
                Capsule()
                    .fill(
                        designSliderColor(DuskColors.ink, isEnabled: isEnabled)
                            .opacity(DesignSliderMetrics.trackBottomHighlight)
                    )
                    .frame(height: DesignMetrics.hairline)
            }
            .shadow(
                color: designSliderColor(DuskColors.line, isEnabled: isEnabled)
                    .opacity(DesignMaterialAdapter.wellLineOpacity),
                radius: 0,
                y: DesignMaterialAdapter.wellLineY
            )
    }

    private var normalizedValue: CGFloat {
        guard range.upperBound > range.lowerBound else { return 0 }
        return CGFloat(min(max((value - range.lowerBound) / (range.upperBound - range.lowerBound), 0), 1))
    }

    private var thumbProgress: CGFloat {
        layoutDirection == .rightToLeft ? 1 - normalizedValue : normalizedValue
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
