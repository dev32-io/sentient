import SwiftUI
import UIKit

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
    var visualHeight: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var selectionNamespace
    @State private var indicatorProgress: CGFloat = 0

    private let selectionAnimationDuration = 0.22

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
        ZStack {
            HStack(spacing: DesignMetrics.segmentGap) {
            ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                Button {
                    selection = option.value
                } label: {
                    Text(option.label)
                        // A 15pt native DM Sans run preserves the reviewed
                        // 14px browser label's intrinsic visual footprint.
                        .font(Typo.ui(TypeScale.base))
                        // Match the source line box without moving the
                        // control's 44pt target; the shared action text
                        // adaptation is one half-point high for this face.
                        .baselineOffset(DesignMetrics.actionButtonTextBaselineOffset - DesignMetrics.hairline / 2)
                        .foregroundStyle(selection == option.value ? DuskColors.accent : DuskColors.ink)
                        .frame(maxWidth: .infinity, minHeight: segmentFaceHeight)
                        // CSS reserves one transparent border point on each
                        // segment. SwiftUI's overlay stroke does not consume
                        // layout, so include that source border-box space in
                        // the native label's horizontal measurement.
                        .padding(.horizontal, DesignMetrics.segmentHorizontalPadding + DesignMetrics.hairline)
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
                                        let shape = RoundedRectangle(
                                            cornerRadius: DesignMetrics.segmentCornerRadius,
                                            style: .continuous
                                        )
                                        ZStack {
                                            shape.stroke(
                                                DuskColors.lineSoft.overlaying(DuskColors.accent, opacity: 0.22),
                                                lineWidth: DesignMetrics.hairline
                                            )
                                            DesignTopEdgeLight(
                                                shape: shape,
                                                color: DuskColors.ink.opacity(DesignMaterialAdapter.slateTopLightRest)
                                            )
                                        }
                                    }
                                    .background {
                                        let shape = RoundedRectangle(
                                            cornerRadius: DesignMetrics.segmentCornerRadius,
                                            style: .continuous
                                        )
                                        ZStack {
                                            DesignSpreadShadow(
                                                shape: shape,
                                                color: DuskColors.accent.opacity(DesignMaterialAdapter.slateQuietGlow),
                                                geometry: DesignMaterialShadowGeometry.slateGlow
                                            )
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
                                    // The prototype's first layout grows the
                                    // measured slate from zero width while its
                                    // opacity comes in; keep that reveal on
                                    // the native surface, not in the fixture.
                                    .scaleEffect(x: indicatorProgress, y: 1, anchor: .leading)
                                    .opacity(indicatorProgress)
                            }
                        }
                }
                .buttonStyle(DesignSegmentButtonStyle())
                .disabled(!isEnabled)
            }
            }
            .padding(DesignMetrics.segmentBedPadding)
            // Keep the native control's 44pt semantic target while allowing
            // the standard handoff to retain its 40pt visual bed. Compact
            // layouts use the full 44pt bed through the same public variant.
            .frame(minHeight: visualHeight)
            .designWell(cornerRadius: Radii.sm)
        }
        .frame(minHeight: DesignMetrics.minimumTarget)
        .opacity(isEnabled ? 1 : DesignMaterialAdapter.selectDisabledOpacity)
        .animation(selectionAnimation, value: selection)
        .onAppear {
            guard indicatorProgress == 0 else { return }
            withAnimation(selectionAnimation) {
                indicatorProgress = 1
            }
        }
        .accessibilityLabel(title)
        .accessibilityValue(isEnabled ? selectedLabel : "Disabled")
        .accessibilityIdentifier(accessibilityId ?? "")
    }

    private var selectionAnimation: Animation? {
        reduceMotion
            ? nil
            : .timingCurve(0.2, 0.8, 0.2, 1, duration: selectionAnimationDuration)
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

private enum DesignChipMaterial {
    // The prototype paints a 34pt chip face. The native control keeps a
    // separate 44pt semantic target around that face.
    static let visualHeight: CGFloat = 34

    // Chip-specific shadows mirror the CSS recipe rather than borrowing the
    // larger action-key cast from the shared button material.
    static let restCast = DesignDropShadowGeometry(radius: 12, y: 7, sourceInset: 10)
    static let hoverCast = DesignDropShadowGeometry(radius: 18, y: 11, sourceInset: 10)
    static let pressedCast = DesignDropShadowGeometry(radius: 6, y: 3, sourceInset: 5)
    static let restContact = DesignDropShadowGeometry(radius: 0, y: 1, sourceInset: 1)
    static let hoverContact = DesignDropShadowGeometry(radius: 0, y: 2, sourceInset: 1)
    static let pressedContact = DesignDropShadowGeometry(radius: 0, y: 1, sourceInset: 1)
    static let selectedGlow = DesignDropShadowGeometry(radius: 16, y: 8, sourceInset: 14)
    static let selectedHoverGlow = DesignDropShadowGeometry(radius: 18, y: 8, sourceInset: 12)
    static let hoverGlow = DesignDropShadowGeometry(radius: 22, y: 14, sourceInset: 14)
}

private struct DesignChipInsetShadow<S: InsettableShape>: UIViewRepresentable {
    let shape: S
    let geometry: DesignDropShadowGeometry
    let color: Color

    func makeUIView(context: Context) -> DesignChipInsetShadowView {
        DesignChipInsetShadowView(
            outerPath: outerPath,
            sourcePath: sourcePath,
            geometry: geometry,
            color: color
        )
    }

    func updateUIView(_ view: DesignChipInsetShadowView, context: Context) {
        view.outerPath = outerPath
        view.sourcePath = sourcePath
        view.geometry = geometry
        view.color = color
        view.setNeedsDisplay()
    }

    private var outerPath: (CGRect) -> CGPath {
        { rect in shape.path(in: rect).cgPath }
    }

    private var sourcePath: (CGRect) -> CGPath {
        { rect in shape.inset(by: geometry.sourceInset).path(in: rect).cgPath }
    }
}

private final class DesignChipInsetShadowView: UIView {
    var outerPath: (CGRect) -> CGPath
    var sourcePath: (CGRect) -> CGPath
    var geometry: DesignDropShadowGeometry
    var color: Color

    init(
        outerPath: @escaping (CGRect) -> CGPath,
        sourcePath: @escaping (CGRect) -> CGPath,
        geometry: DesignDropShadowGeometry,
        color: Color
    ) {
        self.outerPath = outerPath
        self.sourcePath = sourcePath
        self.geometry = geometry
        self.color = color
        super.init(frame: .zero)
        isOpaque = false
        backgroundColor = .clear
        contentMode = .redraw
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext(), bounds.width > 0, bounds.height > 0 else { return }

        let outer = outerPath(bounds)
        let source = sourcePath(bounds)
        context.saveGState()
        context.addPath(outer)
        context.clip()
        context.setShadow(
            offset: CGSize(width: geometry.x, height: geometry.y),
            blur: geometry.radius,
            color: UIColor(color).cgColor
        )
        context.setFillColor(UIColor.white.cgColor)
        context.addPath(source)
        context.fillPath()
        context.restoreGState()

        // The source path only seeds the inset shadow. Remove that seed so the
        // underlying well gradient remains the face owner.
        context.saveGState()
        context.setBlendMode(.clear)
        context.addPath(source)
        context.fillPath()
        context.restoreGState()
    }
}

private struct DesignChipWellFace: View {
    let shape: Capsule
    let pressed: Bool

    private var face: LinearGradient {
        LinearGradient(
            stops: [
                .init(
                    color: DuskColors.bgSunk.overlaying(
                        .black,
                        opacity: DesignMaterialAdapter.wellTopBlack
                    ),
                    location: 0
                ),
                .init(color: DuskColors.bgSunk, location: DesignMaterialAdapter.wellMiddleStop),
                .init(
                    color: DuskColors.bgSunk.overlaying(
                        DuskColors.bgElev,
                        opacity: DesignMaterialAdapter.wellBottomElevated
                    ),
                    location: 1
                ),
            ],
            startPoint: .top,
            endPoint: .bottom
        )
    }

    var body: some View {
        shape
            .fill(face)
            .overlay {
                DesignChipInsetShadow(
                    shape: shape,
                    geometry: DesignDropShadowGeometry(
                        radius: pressed ? 7 : 6,
                        y: pressed ? -3 : -2,
                        sourceInset: 2
                    ),
                    color: .black.opacity(pressed ? 0.78 : DesignMaterialAdapter.wellInsetOpacity)
                )
            }
            .overlay {
                if !pressed {
                    shape
                        .stroke(
                            DuskColors.ink.opacity(DesignMaterialAdapter.wellBottomHighlight),
                            lineWidth: DesignMetrics.hairline
                        )
                        .mask(
                            LinearGradient(
                                colors: [.clear, .clear, .white],
                                startPoint: .top,
                                endPoint: .bottom
                            )
                        )
                }
            }
            .accessibilityHidden(true)
    }
}

private struct DesignChipButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.isFocused) private var focused
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast
    let selected: Bool
    let hovered: Bool

    private var raised: Bool { hovered && isEnabled }
    private var selectedFace: Bool { selected && isEnabled }

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed && isEnabled
        let shape = Capsule()
        configuration.label
            // Keep font metrics and inline padding identical in every state;
            // selection changes only the material and semantic treatment.
            .font(Typo.ui(TypeScale.base, .regular))
            // `.snt-surface button` wins the prototype cascade for the
            // unselected label, so the approved rendering uses primary ink.
            .foregroundStyle(isEnabled ? (selected ? DuskColors.accent : DuskColors.ink) : DuskColors.ink4)
            .padding(.horizontal, Space.md + DesignMetrics.hairline)
            .frame(minHeight: DesignChipMaterial.visualHeight)
            .background {
                if selectedFace {
                    DesignChipWellFace(shape: shape, pressed: pressed)
                } else {
                    designSlateFace(
                        role: .secondary,
                        muted: !isEnabled,
                        hovered: raised,
                        baseOverride: DuskColors.paper
                    )
                }
            }
            .clipShape(shape)
            .overlay {
                shape.strokeBorder(border, lineWidth: DesignMetrics.hairline)
            }
            .overlay {
                if !selectedFace, let topLight = topLight(pressed: pressed, raised: raised) {
                    DesignTopEdgeLight(shape: shape, color: topLight)
                }
            }
            .overlay {
                if pressed {
                    // These are the source pressed inset shadows. They close
                    // the face without introducing a second raised layer.
                    shape.fill(
                        Color.clear.shadow(
                            .inner(
                                color: selectedFace
                                    ? .black.opacity(0.78)
                                    : DuskColors.bgSunk.opacity(0.42),
                                radius: selectedFace ? 4 : 3,
                                y: selectedFace ? 4 : 2
                            )
                        )
                    )
                }
            }
            .overlay {
                if focused {
                    shape
                        .stroke(
                            DuskColors.accent,
                            lineWidth: contrast == .increased ? 3 : DesignMetrics.focusBorder
                        )
                        .padding(DesignMetrics.focusBorderInset)
                }
            }
            .background {
                ZStack {
                    if selectedFace {
                        // The selected pressed recipe is an inset well only;
                        // the resting ember cast is intentionally collapsed.
                        if !pressed {
                            DesignSpreadShadow(
                                shape: shape,
                                color: DuskColors.accent.opacity(raised ? 0.64 : 0.58),
                                geometry: raised
                                    ? DesignChipMaterial.selectedHoverGlow
                                    : DesignChipMaterial.selectedGlow
                            )
                        }
                    } else {
                        if raised && !pressed {
                            DesignSpreadShadow(
                                shape: shape,
                                color: DuskColors.accent.opacity(0.48),
                                geometry: DesignChipMaterial.hoverGlow
                            )
                        }
                        DesignSpreadShadow(
                            shape: shape,
                            color: .black.opacity(castOpacity(pressed: pressed, raised: raised)),
                            geometry: castGeometry(pressed: pressed, raised: raised)
                        )
                    }

                    if !selectedFace || !pressed {
                        DesignSpreadShadow(
                            shape: shape,
                            color: contactColor(pressed: pressed, raised: raised),
                            geometry: contactGeometry(pressed: pressed, raised: raised)
                        )
                    }
                }
            }
            .offset(y: selectedFace ? (pressed ? 1 : 0) : (pressed ? DesignMetrics.pressedDepth : raised ? -1 : 0))
            .opacity(isEnabled ? 1 : DesignMaterialAdapter.selectDisabledOpacity)
            .animation(
                DesignV2.Motion.animation(duration: DesignV2.Motion.feedback, reduceMotion: reduceMotion),
                value: raised
            )
            // Keep press feedback discrete; chips should respond on touch-down.
    }

    private var border: Color {
        if selectedFace || raised { return .clear }
        if !isEnabled {
            return DuskColors.lineSoft.overlaying(
                DuskColors.bg,
                opacity: 1 - DesignMaterialAdapter.slateDisabledBorder
            )
        }
        return contrast == .increased ? DuskColors.ink3 : DuskColors.line
    }

    private func topLight(pressed: Bool, raised: Bool) -> Color? {
        guard !pressed else { return nil }
        return DuskColors.ink.opacity(
            !isEnabled
                ? DesignMaterialAdapter.slateDisabledTopLight
                : raised
                    ? DesignMaterialAdapter.slateHoverTopLight
                    : DesignMaterialAdapter.slateTopLightRest
        )
    }

    private func castOpacity(pressed: Bool, raised: Bool) -> Double {
        if !isEnabled { return DesignMaterialAdapter.slateDisabledBlack }
        if pressed { return DesignMaterialAdapter.slatePressedBlack }
        return raised ? DesignMaterialAdapter.slateHoverBlack : DesignMaterialAdapter.slateRestBlack
    }

    private func castGeometry(pressed: Bool, raised: Bool) -> DesignDropShadowGeometry {
        if !isEnabled { return DesignMaterialShadowGeometry.slateDisabled }
        if pressed { return DesignChipMaterial.pressedCast }
        return raised ? DesignChipMaterial.hoverCast : DesignChipMaterial.restCast
    }

    private func contactColor(pressed: Bool, raised: Bool) -> Color {
        if selectedFace {
            return DuskColors.line.opacity(DesignMaterialAdapter.wellLineOpacity)
        }
        if !isEnabled {
            return DuskColors.bgSunk.overlaying(
                DuskColors.line,
                opacity: DesignMaterialAdapter.slateDisabledContactMix
            )
        }
        if pressed || raised {
            return DuskColors.bgSunk.overlaying(DuskColors.line, opacity: 0.10)
        }
        return DuskColors.bgSunk
    }

    private func contactGeometry(pressed: Bool, raised: Bool) -> DesignDropShadowGeometry {
        if selectedFace { return DesignChipMaterial.restContact }
        if pressed { return DesignChipMaterial.pressedContact }
        return raised ? DesignChipMaterial.hoverContact : DesignChipMaterial.restContact
    }
}

struct DesignChip: View {
    let title: String
    var selected = false
    var isEnabled = true
    var accessibilityId: String? = nil
    let action: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
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
            .frame(minHeight: DesignMetrics.minimumTarget)
            .onHover { hovered = $0 }
            .disabled(!isEnabled)
            .accessibilityLabel(title)
            .accessibilityValue(isEnabled ? (selected ? "Selected" : "Not selected") : "Disabled")
            .accessibilityIdentifier(accessibilityId ?? "")
            .accessibilityAddTraits(selected ? .isSelected : [])
            .animation(
                DesignV2.Motion.animation(duration: DesignV2.Motion.feedback, reduceMotion: reduceMotion),
                value: selected
            )
    }
}

private struct DesignCheckboxMark: View {
    @Environment(\.designControlPressed) private var pressed
    @Environment(\.colorSchemeContrast) private var contrast
    let isOn: Bool
    let isEnabled: Bool
    let hovered: Bool
    let focused: Bool

    private var shape: RoundedRectangle {
        RoundedRectangle(
            cornerRadius: DesignMetrics.checkboxCornerRadius,
            style: .continuous
        )
    }

    private var isPressed: Bool { pressed && isEnabled }
    private var isHovered: Bool { hovered && isEnabled && !isPressed }

    var body: some View {
        ZStack {
            if !isEnabled {
                // Keep a disabled checked value visually truthful if a future
                // owner supplies one; the current iOS surfaces are binary and
                // do not manufacture an indeterminate state locally.
                designSlateFace(role: .quiet, muted: true, hovered: false)
            } else if isOn {
                designSlateFace(
                    role: .action,
                    muted: false,
                    hovered: isHovered,
                    baseOverride: DuskColors.accent
                )
            } else {
                DesignWellFace(shape: shape, focused: false, showsInsetHighlights: true)
            }
            shape.strokeBorder(borderColor, lineWidth: DesignMetrics.hairline)
            Image(systemName: "checkmark")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(isEnabled ? DuskColors.bgSunk : DuskColors.ink4)
                .opacity(isOn ? 1 : 0)
                .scaleEffect(isOn ? 1 : 0.7)
                .accessibilityHidden(true)
        }
        .frame(width: DesignMetrics.checkboxSize, height: DesignMetrics.checkboxSize)
        .clipShape(shape)
        .overlay {
            if focused {
                shape
                    .stroke(
                        DuskColors.accent,
                        lineWidth: contrast == .increased ? 3 : DesignMetrics.focusBorder
                    )
                    .padding(-DesignMetrics.focusRing)
            }
        }
        .background {
            ZStack {
                if !isEnabled {
                    DesignSpreadShadow(
                        shape: shape,
                        color: .black.opacity(DesignMaterialAdapter.slateDisabledBlack),
                        geometry: DesignMaterialShadowGeometry.slateDisabled
                    )
                } else if isPressed {
                    DesignSpreadShadow(
                        shape: shape,
                        color: .black.opacity(DesignMaterialAdapter.slatePressedBlack),
                        geometry: DesignMaterialShadowGeometry.slatePressed
                    )
                } else if isOn {
                    DesignSpreadShadow(
                        shape: shape,
                        color: .black.opacity(
                            isHovered
                                ? DesignMaterialAdapter.slateHoverBlack
                                : DesignMaterialAdapter.slateRestBlack
                        ),
                        geometry: isHovered
                            ? DesignMaterialShadowGeometry.slateHover
                            : DesignMaterialShadowGeometry.slateRest
                    )
                    DesignSpreadShadow(
                        shape: shape,
                        color: DuskColors.accent.opacity(isHovered ? 0.56 : 0.50),
                        geometry: isHovered
                            ? DesignMaterialShadowGeometry.slateHoverGlow
                            : DesignDropShadowGeometry(radius: 15, y: 9, sourceInset: 12)
                    )
                } else if isHovered {
                    DesignSpreadShadow(
                        shape: shape,
                        color: DuskColors.accent,
                        geometry: DesignDropShadowGeometry(radius: 12, y: 0, sourceInset: 8)
                    )
                }
                DesignSpreadShadow(
                    shape: shape,
                    color: isOn
                        ? DuskColors.bgSunk.opacity(0.88)
                        : DuskColors.line.opacity(DesignMaterialAdapter.wellLineOpacity),
                    geometry: DesignDropShadowGeometry(
                        radius: 0,
                        y: !isEnabled || isPressed ? 1 : 2,
                        sourceInset: 1
                    )
                )
            }
        }
        .offset(y: isPressed ? DesignMetrics.pressedDepth : isHovered && isOn ? -DesignMetrics.pressedDepth : 0)
    }

    private var borderColor: Color {
        if contrast == .increased { return DuskColors.ink3 }
        if !isEnabled {
            return DuskColors.lineSoft.overlaying(
                DuskColors.bg,
                opacity: 1 - DesignMaterialAdapter.slateDisabledBorder
            )
        }
        if isHovered && isOn { return .clear }
        if isOn {
            return DuskColors.line.overlaying(DuskColors.accent, opacity: 0.48)
        }
        if isHovered { return DuskColors.line.overlaying(DuskColors.accent, opacity: 0.26) }
        return DuskColors.line
    }
}

private struct DesignCheckboxPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            // The source presses only the checkbox face. The label remains in
            // place while the mark closes its air gap through the environment.
            .environment(\.designControlPressed, configuration.isPressed)
    }
}

private struct DesignCheckboxStyle: ToggleStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
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
            }
            .frame(minHeight: DesignMetrics.minimumTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(DesignCheckboxPressStyle())
        .animation(
            DesignV2.Motion.animation(duration: DesignV2.Motion.feedback, reduceMotion: reduceMotion),
            value: configuration.isOn
        )
        .animation(
            DesignV2.Motion.animation(duration: DesignV2.Motion.state, reduceMotion: reduceMotion),
            value: hovered
        )
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
            .accessibilityLabel(title)
            .accessibilityValue(isEnabled ? (isOn ? "Checked" : "Unchecked") : "Disabled")
            .accessibilityIdentifier(accessibilityId ?? "")
    }
}
