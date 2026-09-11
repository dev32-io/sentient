// ---------------------------------------------------------------------------
// MessageBubbleShell — the shared message row and bubble surface.
//
// Role-specific message views supply only content and (for outbox rows) a
// footer. Alignment, avatar placement, metadata, width, material, shape, and
// accessibility stay here so committed and pending user bubbles cannot drift
// apart.
// ---------------------------------------------------------------------------
import SwiftUI

/// The only role decision the shared shell needs. Unknown gateway roles retain
/// the existing assistant-side rendering path at the call site.
enum MessageBubbleRole {
    case user
    case assistant

    var isUser: Bool {
        self == .user
    }
}

struct MessageBubbleShell<Content: View, Footer: View>: View {
    let role: MessageBubbleRole
    let name: String
    let timestamp: Int64?
    let isStreaming: Bool
    let cutoffLabel: String?
    let index: Int
    let total: Int
    let continuation: Bool
    let avatarMode: SentientIdentityState
    let accessibilityIdentifier: String?
    let metadataMuted: Bool
    let hasInteractiveFooter: Bool
    @ViewBuilder let content: () -> Content
    @ViewBuilder let footer: () -> Footer

    @Environment(\.bubbleMaxWidth) private var bubbleMaxWidth

    init(
        role: MessageBubbleRole,
        name: String,
        timestamp: Int64?,
        isStreaming: Bool,
        cutoffLabel: String?,
        index: Int,
        total: Int,
        continuation: Bool,
        avatarMode: SentientIdentityState,
        accessibilityIdentifier: String? = nil,
        metadataMuted: Bool = false,
        @ViewBuilder content: @escaping () -> Content
    ) where Footer == EmptyView {
        self.role = role
        self.name = name
        self.timestamp = timestamp
        self.isStreaming = isStreaming
        self.cutoffLabel = cutoffLabel
        self.index = index
        self.total = total
        self.continuation = continuation
        self.avatarMode = avatarMode
        self.accessibilityIdentifier = accessibilityIdentifier
        self.metadataMuted = metadataMuted
        self.hasInteractiveFooter = false
        self.content = content
        self.footer = { EmptyView() }
    }

    init(
        role: MessageBubbleRole,
        name: String,
        timestamp: Int64?,
        isStreaming: Bool,
        cutoffLabel: String?,
        index: Int,
        total: Int,
        continuation: Bool,
        avatarMode: SentientIdentityState,
        accessibilityIdentifier: String? = nil,
        metadataMuted: Bool = false,
        @ViewBuilder content: @escaping () -> Content,
        @ViewBuilder footer: @escaping () -> Footer
    ) {
        self.role = role
        self.name = name
        self.timestamp = timestamp
        self.isStreaming = isStreaming
        self.cutoffLabel = cutoffLabel
        self.index = index
        self.total = total
        self.continuation = continuation
        self.avatarMode = avatarMode
        self.accessibilityIdentifier = accessibilityIdentifier
        self.metadataMuted = metadataMuted
        self.hasInteractiveFooter = true
        self.content = content
        self.footer = footer
    }

    var body: some View {
        if let accessibilityIdentifier {
            accessibleRow.accessibilityIdentifier(accessibilityIdentifier)
        } else {
            accessibleRow
        }
    }

    private var accessibleRow: some View {
        row
            // A retry footer must remain a separate actionable accessibility
            // element. Committed bubbles have no interactive footer and keep
            // their established single chronology element.
            .accessibilityElement(children: hasInteractiveFooter ? .contain : .combine)
            .accessibilityLabel(accessibilityChronology)
    }

    private var row: some View {
        HStack(alignment: .top, spacing: 0) {
            if role.isUser {
                Spacer(minLength: BubbleLayout.edgeMin)
                VStack(alignment: .trailing, spacing: Space.xs) {
                    if !continuation {
                        MessageMeta(name: name, timestamp: timestamp, hidesTimestamp: isStreaming, muted: metadataMuted)
                    }
                    bubbleBody
                    footer()
                }
                avatarColumn
            } else {
                avatarColumn
                VStack(alignment: .leading, spacing: Space.xs) {
                    if !continuation {
                        MessageMeta(name: name, timestamp: timestamp, hidesTimestamp: isStreaming, muted: metadataMuted)
                    }
                    bubbleBody
                    footer()
                }
                Spacer(minLength: BubbleLayout.edgeMin)
            }
        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private var avatarColumn: some View {
        if continuation {
            Color.clear
                .frame(width: BubbleLayout.avatarSize + Space.md, height: 1)
                .accessibilityHidden(true)
        } else if role.isUser {
            UserAvatar(name: name, size: BubbleLayout.avatarSize)
                .padding(.leading, Space.md)
                .accessibilityHidden(true)
        } else {
            SentientMark(size: BubbleLayout.avatarSize, mode: avatarMode)
                .padding(.trailing, Space.md)
                .accessibilityHidden(true)
        }
    }

    private var bubbleBody: some View {
        content()
            .padding(Space.padMsg)
            .frame(maxWidth: bubbleMaxWidth, alignment: .leading)
            // Content remains native and independently accessible. Only the
            // decorative face is delegated to Canvas.
            .clipShape(bubbleShape)
            .fixedSize(horizontal: false, vertical: true)
            .background {
                BubbleCanvasChrome(
                    shape: bubbleShape,
                    style: bubbleChromeStyle,
                    breathes: !role.isUser && avatarMode == .responding
                )
            }
    }

    private var bubbleChromeStyle: BubbleChromeStyle {
        if role.isUser { return .user }
        if cutoffLabel != nil { return .interrupted }
        if isStreaming || avatarMode == .responding { return .activeAssistant }
        return .assistant
    }

    private var accessibilityChronology: String {
        let position = "Message \(index + 1) of \(max(total, index + 1)) from \(name)"
        if isStreaming {
            return "\(position), responding"
        }
        if let timestamp {
            let time = Date(timeIntervalSince1970: Double(timestamp) / 1000)
                .formatted(date: .omitted, time: .shortened)
            return "\(position) at \(time)\(cutoffLabel.map { ", \($0)" } ?? "")"
        }
        return "\(position), pending"
    }

    /// Flush the corner nearest the sender while retaining the central radius
    /// tokens used by the committed and pending user surfaces.
    private var bubbleShape: UnevenRoundedRectangle {
        let r = Radii.lg
        let flush = BubbleLayout.flushCorner
        if role.isUser {
            return UnevenRoundedRectangle(
                topLeadingRadius: r, bottomLeadingRadius: r,
                bottomTrailingRadius: r, topTrailingRadius: flush
            )
        }
        return UnevenRoundedRectangle(
            topLeadingRadius: flush, bottomLeadingRadius: r,
            bottomTrailingRadius: r, topTrailingRadius: r
        )
    }
}

private enum BubbleChromeStyle: Equatable {
    case assistant
    case user
    case activeAssistant
    case interrupted
}

/// One decorative Canvas owns each bubble's face, edge, shadows, active cast,
/// and contained speaking sweep. Native content remains the layout authority,
/// so streaming keeps its established inline measure and grows only vertically.
private struct BubbleCanvasChrome: View {
    let shape: UnevenRoundedRectangle
    let style: BubbleChromeStyle
    let breathes: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.layoutDirection) private var layoutDirection

    var body: some View {
        TimelineView(.animation(paused: reduceMotion || !breathes)) { timeline in
            GeometryReader { proxy in
                let overflow = BubbleLayout.chromeOverflow
                let faceRect = CGRect(
                    x: overflow, y: overflow,
                    width: proxy.size.width, height: proxy.size.height
                )
                let phase = breathPhase(at: timeline.date)

                Canvas(opaque: false, colorMode: .nonLinear, rendersAsynchronously: false) { context, _ in
                    draw(phase: phase, in: &context, faceRect: faceRect)
                }
                .frame(
                    width: proxy.size.width + overflow * 2,
                    height: proxy.size.height + overflow * 2
                )
                .offset(x: -overflow, y: -overflow)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func breathPhase(at date: Date) -> Double? {
        guard breathes, !reduceMotion else { return nil }
        let period = max(Motion.respondingCadence, 0.001)
        return date.timeIntervalSinceReferenceDate
            .truncatingRemainder(dividingBy: period) / period
    }

    private func draw(
        phase: Double?,
        in context: inout GraphicsContext,
        faceRect: CGRect
    ) {
        let facePath = path(in: faceRect)
        drawRoleShadow(phase: phase, in: &context, faceRect: faceRect)
        drawShadow(
            color: .black, opacity: 0.90, blur: 30, y: 18, sourceInset: 22,
            in: &context, faceRect: faceRect
        )
        drawShadow(
            color: DuskColors.bgSunk.overlaying(DuskColors.line, opacity: 0.22),
            opacity: 1, blur: 0, y: 2, sourceInset: 1,
            in: &context, faceRect: faceRect
        )

        let face = faceColors
        context.fill(facePath, with: .linearGradient(
            Gradient(colors: [face.top, face.bottom]),
            startPoint: CGPoint(x: faceRect.midX, y: faceRect.minY),
            endPoint: CGPoint(x: faceRect.midX, y: faceRect.maxY)
        ))
        drawRoleRadial(in: &context, faceRect: faceRect, facePath: facePath)
        if let phase, breathes {
            drawSpeakingWave(phase: phase, in: &context, faceRect: faceRect, facePath: facePath)
        }
        drawTopLight(in: &context, faceRect: faceRect)

        var border = context
        border.clip(to: facePath)
        border.stroke(facePath, with: .color(borderColor), lineWidth: 1)
    }

    private var faceColors: (top: Color, bottom: Color) {
        switch style {
        case .assistant:
            (DuskColors.paper.overlaying(DuskColors.ink2, opacity: 0.03), DuskColors.paper)
        case .user:
            (DuskColors.accent50.overlaying(DuskColors.paper, opacity: 0.10), DuskColors.accent50)
        case .activeAssistant:
            (DuskColors.paper.overlaying(DuskColors.accentSoft, opacity: 0.04), DuskColors.paper)
        case .interrupted:
            (DuskColors.paper.overlaying(DuskColors.clay, opacity: 0.08), DuskColors.paper)
        }
    }

    private var borderColor: Color {
        if contrast == .increased { return DuskColors.ink3 }
        return switch style {
        case .assistant: DuskColors.lineSoft
        case .user: DuskColors.lineSoft.overlaying(DuskColors.accent, opacity: 0.18)
        case .activeAssistant: DuskColors.lineSoft.overlaying(DuskColors.accent, opacity: 0.22)
        case .interrupted: DuskColors.lineSoft.overlaying(DuskColors.clay, opacity: 0.28)
        }
    }

    private func drawRoleShadow(
        phase: Double?,
        in context: inout GraphicsContext,
        faceRect: CGRect
    ) {
        switch style {
        case .user:
            drawShadow(
                color: DuskColors.accent, opacity: 0.34,
                blur: 22, y: 14, sourceInset: 18,
                in: &context, faceRect: faceRect
            )
        case .activeAssistant:
            let shadow = activeShadow(phase: phase)
            drawShadow(
                color: DuskColors.accent, opacity: shadow.opacity,
                blur: shadow.blur, y: shadow.y, sourceInset: shadow.inset,
                in: &context, faceRect: faceRect
            )
        case .assistant, .interrupted:
            break
        }
    }

    private func activeShadow(phase: Double?) -> (opacity: Double, blur: CGFloat, y: CGFloat, inset: CGFloat) {
        guard let phase else {
            // Reduced Motion and thinking retain a clear active cast without a cycle.
            return (0.52, 24, 15, 18)
        }
        let energy = CGFloat((sin(phase * 2 * .pi - .pi / 2) + 1) / 2)
        return (
            0.34 + 0.24 * Double(energy),
            21 + 10 * energy,
            12 + 7 * energy,
            18 - 3 * energy
        )
    }

    private func drawShadow(
        color: Color,
        opacity: Double,
        blur: CGFloat,
        y: CGFloat,
        sourceInset: CGFloat,
        in context: inout GraphicsContext,
        faceRect: CGRect
    ) {
        DesignCanvasEffects.outerShadow(
            in: &context,
            sourcePath: path(in: faceRect, inset: sourceInset),
            color: color.opacity(opacity),
            blur: blur,
            y: y
        )
    }

    private func drawRoleRadial(
        in context: inout GraphicsContext,
        faceRect: CGRect,
        facePath: Path
    ) {
        switch style {
        case .assistant:
            drawRadial(
                color: DuskColors.paper.overlaying(DuskColors.bgSunk, opacity: 0.16),
                center: CGPoint(x: 0.50, y: 0.55), scale: CGSize(width: 0.90, height: 1.20),
                fadeStop: 0.78, in: &context, faceRect: faceRect, facePath: facePath
            )
        case .user:
            drawRadial(
                color: DuskColors.accent50.overlaying(DuskColors.bgSunk, opacity: 0.22),
                center: CGPoint(x: 0.50, y: 0.55), scale: CGSize(width: 0.90, height: 1.20),
                fadeStop: 0.78, in: &context, faceRect: faceRect, facePath: facePath
            )
        case .activeAssistant:
            let origin = CGPoint(
                x: faceRect.minX + faceRect.width * 0.10,
                y: faceRect.midY
            )
            let radius = hypot(
                max(origin.x - faceRect.minX, faceRect.maxX - origin.x),
                max(origin.y - faceRect.minY, faceRect.maxY - origin.y)
            )
            drawRadial(
                color: DuskColors.accent.opacity(0.08),
                center: CGPoint(x: 0.10, y: 0.50),
                scale: CGSize(width: radius / faceRect.width, height: radius / faceRect.height),
                fadeStop: 0.42, in: &context, faceRect: faceRect, facePath: facePath
            )
        case .interrupted:
            break
        }
    }

    private func drawRadial(
        color: Color,
        center: CGPoint,
        scale: CGSize,
        fadeStop: CGFloat,
        in context: inout GraphicsContext,
        faceRect: CGRect,
        facePath: Path
    ) {
        let origin = CGPoint(
            x: faceRect.minX + faceRect.width * center.x,
            y: faceRect.minY + faceRect.height * center.y
        )
        let radius = CGSize(width: faceRect.width * scale.width, height: faceRect.height * scale.height)
        guard radius.width > 0, radius.height > 0 else { return }

        var layer = context
        layer.clip(to: facePath)
        layer.translateBy(x: origin.x, y: origin.y)
        layer.scaleBy(x: radius.width, y: radius.height)
        layer.fill(
            Path(CGRect(x: -1, y: -1, width: 2, height: 2)),
            with: .radialGradient(
                Gradient(stops: [
                    .init(color: color, location: 0),
                    .init(color: color.opacity(0), location: fadeStop),
                ]),
                center: .zero, startRadius: 0, endRadius: 1
            )
        )
    }

    private func drawSpeakingWave(
        phase: Double,
        in context: inout GraphicsContext,
        faceRect: CGRect,
        facePath: Path
    ) {
        let width = faceRect.width
        let x = faceRect.minX + CGFloat(phase) * width * 2.2 - width * 0.7
        var wave = context
        wave.clip(to: facePath)
        wave.fill(
            Path(CGRect(x: x, y: faceRect.minY, width: width * 1.2, height: faceRect.height)),
            with: .linearGradient(
                Gradient(stops: [
                    .init(color: .clear, location: 0),
                    .init(color: DuskColors.accent.opacity(0.22), location: 0.5),
                    .init(color: .clear, location: 1),
                ]),
                startPoint: CGPoint(x: x, y: faceRect.midY),
                endPoint: CGPoint(x: x + width * 1.2, y: faceRect.midY)
            )
        )
    }

    private func drawTopLight(in context: inout GraphicsContext, faceRect: CGRect) {
        let inner = path(in: faceRect, inset: 1)
        var translated = Path()
        translated.addPath(inner, transform: CGAffineTransform(translationX: 0, y: 1))
        var difference = Path()
        difference.addPath(inner)
        difference.addPath(translated)

        var highlight = context
        highlight.clip(to: inner)
        highlight.fill(
            difference,
            with: .color(DuskColors.ink.opacity(0.05)),
            style: FillStyle(eoFill: true)
        )
    }

    private func path(in rect: CGRect, inset: CGFloat = 0) -> Path {
        let insetRect = rect.insetBy(dx: inset, dy: inset)
        guard insetRect.width > 0, insetRect.height > 0 else { return Path() }
        let corners = shape.cornerRadii
        let topLeading = layoutDirection == .rightToLeft ? corners.topTrailing : corners.topLeading
        let bottomLeading = layoutDirection == .rightToLeft ? corners.bottomTrailing : corners.bottomLeading
        let bottomTrailing = layoutDirection == .rightToLeft ? corners.bottomLeading : corners.bottomTrailing
        let topTrailing = layoutDirection == .rightToLeft ? corners.topLeading : corners.topTrailing
        return UnevenRoundedRectangle(
            topLeadingRadius: max(0, topLeading - inset),
            bottomLeadingRadius: max(0, bottomLeading - inset),
            bottomTrailingRadius: max(0, bottomTrailing - inset),
            topTrailingRadius: max(0, topTrailing - inset),
            style: shape.style
        ).path(in: insetRect)
    }
}

/// Shared chat geometry. Values continue to project the existing central
/// design/KMP tokens; this type only names message-specific composition.
enum BubbleLayout {
    static let standardOffset: CGFloat = .zero
    static let continuationPullup = -Space.lg
    static let flushCorner: CGFloat = 8
    static let avatarSize: CGFloat = DesignMetrics.minimumTarget
    static let edgeMin: CGFloat = 12
    static let pulseDot: CGFloat = 5
    static let pulseGap: CGFloat = 4
    static let pulseDuration: Double = 1.2
    static let pulseStagger: Double = 0.14
    static let chromeOverflow: CGFloat = 32
}
