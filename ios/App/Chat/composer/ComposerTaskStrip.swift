import Foundation
import MobileData
import SwiftUI

/// Joined shelf for authoritative full-state task activity. It never infers
/// lifetime, associates tasks with bubbles, or couples Stop to task cancellation.
struct TaskShelf: View {
    let items: [TaskListItem]
    var body: some View { ComposerTaskStrip(items: items) }
}

func taskShelfSelection(current: String?, tapped: String) -> String? {
    current == tapped ? nil : tapped
}

/// Authoritative full-state task rows joined to the composer. Disclosure is
/// local presentation state; task lifetime remains owned by `tasklist.state`.
struct ComposerTaskStrip: View {
    let items: [TaskListItem]

    @State private var expandedTaskId: String?
    @ComposerReduceMotion private var reduceMotion

    init(items: [TaskListItem], initiallyExpandedTaskId: String? = nil) {
        self.items = items
        _expandedTaskId = State(initialValue: initiallyExpandedTaskId)
    }

    var body: some View {
        if !items.isEmpty {
            VStack(spacing: ComposerTaskShelfGeometry.sectionGap) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: ComposerTaskShelfGeometry.pillGap) {
                        ForEach(items, id: \.id) { item in
                            taskButton(item)
                        }
                    }
                }
                .scrollBounceBehavior(.basedOnSize, axes: .horizontal)

                if let selectedTask {
                    taskDetail(selectedTask)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .padding(.horizontal, ComposerTaskShelfGeometry.horizontalPadding)
            .padding(.top, ComposerTaskShelfGeometry.topPadding)
            .padding(.bottom, ComposerTaskShelfGeometry.bottomPadding)
            .background { TaskShelfFace() }
            .animation(
                reduceMotion ? nil : .spring(duration: DesignV2.Motion.state, bounce: 0),
                value: expandedTaskId
            )
            .onChange(of: items.map(\.id)) { _, ids in
                if let expandedTaskId, !ids.contains(expandedTaskId) {
                    self.expandedTaskId = nil
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Task activity")
            .accessibilityIdentifier("task-strip")
        }
    }

    private var selectedTask: TaskListItem? {
        guard let expandedTaskId else { return nil }
        return items.first { $0.id == expandedTaskId }
    }

    private func taskButton(_ item: TaskListItem) -> some View {
        let expanded = expandedTaskId == item.id
        return Button {
            expandedTaskId = taskShelfSelection(current: expandedTaskId, tapped: item.id)
        } label: {
            HStack(spacing: ComposerTaskShelfGeometry.pillContentGap) {
                TaskStatusIndicator(status: item.status)

                Text(formatToolName(rawName: item.toolName))
                    .font(Typo.ui(TypeScale.sm, .regular))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: ComposerTaskShelfGeometry.maximumLabelWidth, alignment: .leading)
            }
            .frame(minHeight: DesignMetrics.minimumTarget)
        }
        .buttonStyle(TaskPillButtonStyle(isExpanded: expanded))
        .accessibilityLabel("\(formatToolName(rawName: item.toolName)), \(taskStatusLabel(item.status))")
        .accessibilityValue(expanded ? "Expanded" : "Collapsed")
        .accessibilityHint(expanded ? "Collapses task details" : "Expands task details")
        .accessibilityIdentifier("task-pill-\(item.id)")
    }

    private func taskDetail(_ item: TaskListItem) -> some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Text("Task details")
                .font(Typo.ui(ComposerTaskShelfGeometry.detailTitleTypeSize, .medium))
                .foregroundStyle(DuskColors.ink3)

            Text(item.argsPreview.isEmpty ? "No argument summary" : item.argsPreview)
                .font(Typo.mono(TypeScale.sm))
                .foregroundStyle(DuskColors.ink2)
                .lineLimit(4)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(ComposerTaskShelfGeometry.detailPadding)
        .background {
            TaskDetailCanvas()
        }
        .accessibilityElement(children: .combine)
    }

    private func taskStatusLabel(_ status: String) -> String {
        switch status.lowercased() {
        case "running": return "Running"
        case "done": return "Completed"
        case "error": return "Failed"
        default: return "Unknown"
        }
    }
}

enum ComposerTaskShelfGeometry {
    static let horizontalPadding: CGFloat = 5
    static let topPadding: CGFloat = 7
    static let bottomPadding: CGFloat = 8
    static let sectionGap: CGFloat = 6
    static let pillGap: CGFloat = 4
    static let pillContentGap: CGFloat = 9
    static let maximumLabelWidth: CGFloat = 164
    static let detailPadding: CGFloat = 12
    static let detailRadius: CGFloat = 10
    static let detailTitleTypeSize: CGFloat = max(TypeScale.sm, 12.5)
    static let shelfRadius: CGFloat = 14
    static let joinedFaceExtension: CGFloat = 10
    static let pulseDiameter: CGFloat = 8

    static let shelfShadow = DesignDropShadowGeometry(
        radius: 18, y: -8, sourceInset: 16
    )
}

private struct TaskShelfFace: View {
    @Environment(\.colorSchemeContrast) private var contrast

    private var shape: UnevenRoundedRectangle {
        UnevenRoundedRectangle(
            topLeadingRadius: ComposerTaskShelfGeometry.shelfRadius,
            bottomLeadingRadius: 0,
            bottomTrailingRadius: 0,
            topTrailingRadius: ComposerTaskShelfGeometry.shelfRadius,
            style: .continuous
        )
    }

    var body: some View {
        TaskShelfCanvas(
            shape: shape,
            increasedContrast: contrast == .increased
        )
    }
}

private struct TaskPillButtonStyle: ButtonStyle {
    let isExpanded: Bool

    @Environment(\.isFocused) private var isFocused
    @ComposerReduceMotion private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
    }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(isExpanded ? DuskColors.ink : DuskColors.ink2)
            .padding(
                .horizontal,
                horizontalSizeClass == .regular ? 12 : 10
            )
            .background {
                TaskPillCanvas(
                    shape: shape,
                    expanded: isExpanded,
                    pressed: configuration.isPressed,
                    focused: isFocused,
                    increasedContrast: contrast == .increased
                )
            }
            .contentShape(shape)
            .offset(y: configuration.isPressed && !reduceMotion ? 1 : 0)
            .animation(
                reduceMotion ? nil : .easeOut(duration: DesignV2.Motion.feedback),
                value: configuration.isPressed
            )
    }
}

private enum TaskShelfCanvasDrawing {
    static func shadow<S: InsettableShape>(
        shape: S,
        color: Color,
        geometry: DesignDropShadowGeometry,
        in context: inout GraphicsContext,
        faceRect: CGRect
    ) {
        guard faceRect.width - 2 * geometry.sourceInset > 0,
              faceRect.height - 2 * geometry.sourceInset > 0 else { return }
        let source = shape.inset(by: geometry.sourceInset).path(in: faceRect)
        DesignCanvasEffects.outerShadow(
            in: &context,
            sourcePath: source,
            color: color,
            blur: geometry.radius,
            x: geometry.x,
            y: geometry.y
        )
    }

    static func topEdge<S: InsettableShape>(
        shape: S,
        color: Color,
        in context: inout GraphicsContext,
        faceRect: CGRect
    ) {
        let inner = shape.inset(by: DesignMetrics.hairline).path(in: faceRect)
        let translated = inner.applying(CGAffineTransform(
            translationX: 0,
            y: DesignMetrics.hairline
        ))
        var difference = inner
        difference.addPath(translated)
        var highlight = context
        highlight.clip(to: inner)
        highlight.fill(difference, with: .color(color), style: FillStyle(eoFill: true))
    }

    static func slateFace(
        path: Path,
        base: Color,
        in context: inout GraphicsContext,
        faceRect: CGRect
    ) {
        context.fill(path, with: .linearGradient(
            Gradient(colors: [
                base.overlaying(DuskColors.ink, opacity: DesignMaterialAdapter.slateBaseLight),
                base,
            ]),
            startPoint: CGPoint(x: faceRect.midX, y: faceRect.minY),
            endPoint: CGPoint(x: faceRect.midX, y: faceRect.maxY)
        ))
        var radial = context
        radial.clip(to: path)
        radial.translateBy(
            x: faceRect.minX + faceRect.width * DesignMaterialAdapter.slateRadialCenterX,
            y: faceRect.minY + faceRect.height * DesignMaterialAdapter.slateRadialCenterY
        )
        radial.scaleBy(
            x: faceRect.width * DesignMaterialAdapter.slateRadialScale.width,
            y: faceRect.height * DesignMaterialAdapter.slateRadialScale.height
        )
        let center = base.overlaying(DuskColors.bgSunk, opacity: DesignMaterialAdapter.slateCenterSunk)
        let ring = base.overlaying(DuskColors.bgSunk, opacity: DesignMaterialAdapter.slateRingSunk)
        radial.fill(
            Path(CGRect(x: -1, y: -1, width: 2, height: 2)),
            with: .radialGradient(
                Gradient(stops: [
                    .init(color: center, location: 0),
                    .init(color: ring, location: DesignMaterialAdapter.slateCenterStop),
                    .init(color: ring.opacity(0), location: DesignMaterialAdapter.slateFadeStop),
                ]),
                center: .zero,
                startRadius: 0,
                endRadius: 1
            )
        )
    }

    static func border<S: InsettableShape>(
        shape: S,
        color: Color,
        in context: inout GraphicsContext,
        faceRect: CGRect
    ) {
        context.stroke(
            shape.inset(by: DesignMetrics.hairline / 2).path(in: faceRect),
            with: .color(color),
            lineWidth: DesignMetrics.hairline
        )
    }

    static func focusRing<S: InsettableShape>(
        shape: S,
        in context: inout GraphicsContext,
        faceRect: CGRect
    ) {
        context.stroke(
            shape.inset(by: -3).path(in: faceRect),
            with: .color(DuskColors.accent),
            lineWidth: DesignMetrics.focusRing
        )
    }
}

private struct TaskShelfCanvas: View {
    let shape: UnevenRoundedRectangle
    let increasedContrast: Bool

    var body: some View {
        GeometryReader { proxy in
            let overflow = ComposerTaskShelfGeometry.shelfShadow.sourceInset
                + ComposerTaskShelfGeometry.shelfShadow.radius
                + abs(ComposerTaskShelfGeometry.shelfShadow.y)
            let joinedRect = CGRect(
                x: overflow,
                y: overflow,
                width: proxy.size.width,
                height: proxy.size.height + ComposerTaskShelfGeometry.joinedFaceExtension
            )

            Canvas(opaque: false, colorMode: .nonLinear, rendersAsynchronously: false) { context, _ in
                TaskShelfCanvasDrawing.shadow(
                    shape: shape,
                    color: Color.black.opacity(0.82),
                    geometry: ComposerTaskShelfGeometry.shelfShadow,
                    in: &context,
                    faceRect: joinedRect
                )
                let facePath = shape.path(in: joinedRect)
                context.fill(
                    facePath,
                    with: .color(DuskColors.bgSunk.overlaying(DuskColors.paper, opacity: 0.14))
                )
                context.fill(facePath, with: .linearGradient(
                    Gradient(colors: [DuskColors.ink.opacity(0.035), .clear]),
                    startPoint: CGPoint(x: joinedRect.midX, y: joinedRect.minY),
                    endPoint: CGPoint(x: joinedRect.midX, y: joinedRect.maxY)
                ))
                TaskShelfCanvasDrawing.border(
                    shape: shape,
                    color: increasedContrast ? DuskColors.ink3 : DuskColors.lineSoft,
                    in: &context,
                    faceRect: joinedRect
                )
                TaskShelfCanvasDrawing.topEdge(
                    shape: shape,
                    color: DuskColors.ink.opacity(0.1),
                    in: &context,
                    faceRect: joinedRect
                )
            }
            .frame(
                width: proxy.size.width + overflow * 2,
                height: proxy.size.height
                    + overflow * 2
                    + ComposerTaskShelfGeometry.joinedFaceExtension
            )
            .offset(x: -overflow, y: -overflow)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private struct TaskPillCanvas: View, Animatable {
    let shape: RoundedRectangle
    let focused: Bool
    let increasedContrast: Bool

    private var expansionAmount: CGFloat
    private var pressAmount: CGFloat

    init(
        shape: RoundedRectangle,
        expanded: Bool,
        pressed: Bool,
        focused: Bool,
        increasedContrast: Bool
    ) {
        self.shape = shape
        self.focused = focused
        self.increasedContrast = increasedContrast
        expansionAmount = expanded ? 1 : 0
        pressAmount = pressed ? 1 : 0
    }

    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(expansionAmount, pressAmount) }
        set {
            expansionAmount = newValue.first
            pressAmount = newValue.second
        }
    }

    var body: some View {
        GeometryReader { proxy in
            let overflow: CGFloat = 18
            let faceRect = CGRect(
                x: overflow,
                y: overflow,
                width: proxy.size.width,
                height: proxy.size.height
            )

            Canvas(opaque: false, colorMode: .nonLinear, rendersAsynchronously: false) { context, _ in
                let facePath = shape.path(in: faceRect)
                let shadowAmount = expansionAmount * (1 - pressAmount)
                TaskShelfCanvasDrawing.shadow(
                    shape: shape,
                    color: Color.black.opacity(0.9 * Double(shadowAmount)),
                    geometry: DesignDropShadowGeometry(radius: 10, y: 6, sourceInset: 9),
                    in: &context,
                    faceRect: faceRect
                )
                TaskShelfCanvasDrawing.shadow(
                    shape: shape,
                    color: DuskColors.bgSunk
                        .overlaying(DuskColors.line, opacity: 0.24)
                        .opacity(Double(expansionAmount)),
                    geometry: DesignDropShadowGeometry(radius: 0, y: 2, sourceInset: 0),
                    in: &context,
                    faceRect: faceRect
                )

                if expansionAmount > 0 {
                    var expandedContext = context
                    expandedContext.opacity = Double(expansionAmount)
                    let base = DuskColors.paper
                        .overlaying(DuskColors.bgSunk, opacity: 0.21)
                        .overlaying(
                            DuskColors.bgSunk,
                            opacity: 0.18 * Double(pressAmount)
                        )
                    expandedContext.fill(facePath, with: .linearGradient(
                        Gradient(colors: [
                            base.overlaying(DuskColors.ink, opacity: 0.035),
                            base,
                        ]),
                        startPoint: CGPoint(x: faceRect.midX, y: faceRect.minY),
                        endPoint: CGPoint(x: faceRect.midX, y: faceRect.maxY)
                    ))
                    TaskShelfCanvasDrawing.border(
                        shape: shape,
                        color: increasedContrast
                            ? DuskColors.ink3
                            : DuskColors.line.overlaying(DuskColors.bgSunk, opacity: 0.12),
                        in: &expandedContext,
                        faceRect: faceRect
                    )
                    TaskShelfCanvasDrawing.topEdge(
                        shape: shape,
                        color: DuskColors.ink.opacity(0.08 * Double(1 - pressAmount)),
                        in: &expandedContext,
                        faceRect: faceRect
                    )
                }

                let collapsedPress = pressAmount * (1 - expansionAmount)
                if collapsedPress > 0 {
                    var pressedContext = context
                    pressedContext.opacity = Double(collapsedPress)
                    TaskShelfCanvasDrawing.slateFace(
                        path: facePath,
                        base: DuskColors.paper.overlaying(DuskColors.bgSunk, opacity: 0.18),
                        in: &pressedContext,
                        faceRect: faceRect
                    )
                }

                if focused {
                    TaskShelfCanvasDrawing.focusRing(
                        shape: shape,
                        in: &context,
                        faceRect: faceRect
                    )
                }
            }
            .frame(
                width: proxy.size.width + overflow * 2,
                height: proxy.size.height + overflow * 2
            )
            .offset(x: -overflow, y: -overflow)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private struct TaskDetailCanvas: View {
    @Environment(\.colorSchemeContrast) private var contrast

    private var shape: RoundedRectangle {
        RoundedRectangle(
            cornerRadius: ComposerTaskShelfGeometry.detailRadius,
            style: .continuous
        )
    }

    var body: some View {
        GeometryReader { proxy in
            let shadow = DesignMaterialShadowGeometry.plate
            let overflow = shadow.sourceInset + shadow.radius + abs(shadow.y)
            let faceRect = CGRect(
                x: overflow,
                y: overflow,
                width: proxy.size.width,
                height: proxy.size.height
            )

            Canvas(opaque: false, colorMode: .nonLinear, rendersAsynchronously: false) { context, _ in
                TaskShelfCanvasDrawing.shadow(
                    shape: shape,
                    color: Color.black.opacity(0.9),
                    geometry: shadow,
                    in: &context,
                    faceRect: faceRect
                )
                TaskShelfCanvasDrawing.shadow(
                    shape: shape,
                    color: DuskColors.bgSunk.overlaying(DuskColors.line, opacity: 0.22),
                    geometry: DesignDropShadowGeometry(radius: 0, y: 2, sourceInset: 1),
                    in: &context,
                    faceRect: faceRect
                )
                let facePath = shape.path(in: faceRect)
                context.fill(
                    facePath,
                    with: .color(DuskColors.paper.overlaying(DuskColors.bgSunk, opacity: 0.28))
                )
                TaskShelfCanvasDrawing.border(
                    shape: shape,
                    color: contrast == .increased ? DuskColors.ink3 : DuskColors.lineSoft,
                    in: &context,
                    faceRect: faceRect
                )
                TaskShelfCanvasDrawing.topEdge(
                    shape: shape,
                    color: DuskColors.ink.opacity(0.05),
                    in: &context,
                    faceRect: faceRect
                )
            }
            .frame(
                width: proxy.size.width + overflow * 2,
                height: proxy.size.height + overflow * 2
            )
            .offset(x: -overflow, y: -overflow)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private struct TaskStatusIndicator: View {
    let status: String

    @ComposerReduceMotion private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 24, paused: reduceMotion || !isRunning)) { timeline in
            let phase = reduceMotion
                ? 0.0
                : (sin(timeline.date.timeIntervalSinceReferenceDate * 4.5) + 1) / 2
            ZStack {
                if isRunning {
                    Circle()
                        .fill(DuskColors.amber)
                        .opacity(reduceMotion ? 1 : 0.58 + phase * 0.42)
                        .scaleEffect(reduceMotion ? 1 : 0.76 + phase * 0.24)
                        .shadow(color: DuskColors.amber.opacity(0.45), radius: 4)
                } else {
                    Circle().fill(statusColor)
                }
            }
            .frame(
                width: ComposerTaskShelfGeometry.pulseDiameter,
                height: ComposerTaskShelfGeometry.pulseDiameter
            )
        }
        .accessibilityHidden(true)
    }

    private var isRunning: Bool { status.lowercased() == "running" }

    private var statusColor: Color {
        switch status.lowercased() {
        case "done": return DuskColors.sage
        case "error": return DuskColors.stop
        default: return DuskColors.ink4
        }
    }
}
