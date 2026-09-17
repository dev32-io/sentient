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
    @Environment(\.layoutDirection) private var layoutDirection
    @Environment(\.sentientIdentityMeasurement) private var measurement
    @State private var identitySize = CGSize.zero

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
            if role.isUser { Spacer(minLength: BubbleLayout.edgeMin) }
            VStack(alignment: role.isUser ? .trailing : .leading, spacing: Space.xs) {
                bubbleBody
                footer()
            }
            if !role.isUser { Spacer(minLength: BubbleLayout.edgeMin) }
        }
        .frame(maxWidth: .infinity)
    }

    private var bubbleBody: some View {
        VStack(alignment: role.isUser ? .trailing : .leading, spacing: Space.sm) {
            measuredIdentity
            content()
                .padding(.horizontal, Space.md)
                .padding(.bottom, Space.md)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: bubbleMaxWidth, alignment: role.isUser ? .trailing : .leading)
        // Content remains native and independently accessible. Only decorative
        // face is delegated to asynchronously rendered Canvas.
        .clipShape(bubbleShape)
        .fixedSize(horizontal: false, vertical: true)
        .background {
            if !measurement {
                BubbleCanvasChrome(
                    shape: bubbleShape,
                    style: bubbleChromeStyle,
                    breathes: !role.isUser && avatarMode == .responding
                )
            }
        }
    }

    @ViewBuilder
    private var measuredIdentity: some View {
        if measurement {
            identity
        } else {
            identity
                .onGeometryChange(for: CGSize.self, of: { $0.size }) { identitySize = $0 }
        }
    }

    private var identity: some View {
        HStack(spacing: 6) {
            if !role.isUser { identityAvatar }
            MessageMeta(name: name, timestamp: timestamp, hidesTimestamp: false, muted: metadataMuted)
            if role.isUser { identityAvatar }
        }
        .padding(.horizontal, Space.md)
        .padding(.top, Space.md)
        .frame(minHeight: BubbleLayout.identityHeight + Space.md)
    }

    @ViewBuilder
    private var identityAvatar: some View {
        if measurement {
            Color.clear.frame(width: BubbleLayout.avatarSize, height: BubbleLayout.avatarSize)
        } else if role.isUser {
            UserAvatar(name: name, size: BubbleLayout.avatarSize)
                .accessibilityHidden(true)
        } else {
            SentientMark(size: BubbleLayout.avatarSize, mode: avatarMode)
                .accessibilityHidden(true)
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

    private var bubbleShape: SweptBubbleShape {
        SweptBubbleShape(
            identityWidth: identitySize.width,
            identityHeight: identitySize.height,
            sweepsFromTrailing: role.isUser != (layoutDirection == .rightToLeft)
        )
    }
}

struct SweptBubbleShape: Shape {
    let identityWidth: CGFloat
    let identityHeight: CGFloat
    let sweepsFromTrailing: Bool

    func path(in rect: CGRect) -> Path {
        let radius = min(Radii.lg, rect.width / 2, rect.height / 2)
        guard identityWidth > 0, identityHeight > 0,
              identityWidth + 6 <= rect.width - 52 else {
            return RoundedRectangle(cornerRadius: radius, style: .continuous).path(in: rect)
        }
        let cap = min(rect.width, identityWidth + 6)
        let shoulderY = min(rect.maxY - radius, rect.minY + max(0, identityHeight - 10))
        var path = Path()
        path.move(to: CGPoint(x: rect.minX + radius, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.minX + max(radius, cap - 12), y: rect.minY))
        path.addCurve(
            to: CGPoint(x: rect.minX + min(rect.width - radius, cap + 36), y: shoulderY),
            control1: CGPoint(x: rect.minX + cap + 12, y: rect.minY),
            control2: CGPoint(x: rect.minX + cap + 8, y: shoulderY)
        )
        path.addLine(to: CGPoint(x: rect.maxX - radius, y: shoulderY))
        path.addQuadCurve(
            to: CGPoint(x: rect.maxX, y: shoulderY + radius),
            control: CGPoint(x: rect.maxX, y: shoulderY)
        )
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - radius))
        path.addQuadCurve(
            to: CGPoint(x: rect.maxX - radius, y: rect.maxY),
            control: CGPoint(x: rect.maxX, y: rect.maxY)
        )
        path.addLine(to: CGPoint(x: rect.minX + radius, y: rect.maxY))
        path.addQuadCurve(
            to: CGPoint(x: rect.minX, y: rect.maxY - radius),
            control: CGPoint(x: rect.minX, y: rect.maxY)
        )
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + radius))
        path.addQuadCurve(
            to: CGPoint(x: rect.minX + radius, y: rect.minY),
            control: CGPoint(x: rect.minX, y: rect.minY)
        )
        path.closeSubpath()
        guard sweepsFromTrailing else { return path }
        return path.applying(
            CGAffineTransform(translationX: rect.minX + rect.maxX, y: 0)
                .scaledBy(x: -1, y: 1)
        )
    }

    func path(in rect: CGRect, inset requestedInset: CGFloat) -> Path {
        guard rect.width > 0, rect.height > 0 else { return Path() }
        let inset = min(max(0, requestedInset), max(0, (min(rect.width, rect.height) - 1) / 2))
        guard inset > 0 else { return path(in: rect) }
        let insetRect = rect.insetBy(dx: inset, dy: inset)
        let scaleX = insetRect.width / rect.width
        let scaleY = insetRect.height / rect.height
        return path(in: rect).applying(CGAffineTransform(
            a: scaleX,
            b: 0,
            c: 0,
            d: scaleY,
            tx: insetRect.minX - rect.minX * scaleX,
            ty: insetRect.minY - rect.minY * scaleY
        ))
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
    let shape: SweptBubbleShape
    let style: BubbleChromeStyle
    let breathes: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast

    @ViewBuilder
    var body: some View {
        if breathes && !reduceMotion {
            TimelineView(.animation) { timeline in
                chrome(phase: breathPhase(at: timeline.date))
            }
        } else {
            chrome(phase: nil)
        }
    }

    private func chrome(phase: Double?) -> some View {
        GeometryReader { proxy in
            let overflow = shadowOverflow(phase: phase)
            let faceRect = CGRect(
                x: overflow, y: overflow,
                width: proxy.size.width, height: proxy.size.height
            )

            Canvas(opaque: false, colorMode: .nonLinear, rendersAsynchronously: true) { context, _ in
                draw(phase: phase, in: &context, faceRect: faceRect)
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

    private func breathPhase(at date: Date) -> Double? {
        guard breathes, !reduceMotion else { return nil }
        let period = max(Motion.respondingCadence, 0.001)
        return date.timeIntervalSinceReferenceDate
            .truncatingRemainder(dividingBy: period) / period
    }

    private func shadowOverflow(phase: Double?) -> CGFloat {
        let plate = DesignCanvasSurfaceRecipe.make(tier: .plate, increasedContrast: contrast == .increased)
        var overflow = [plate.cast, plate.contact].map {
            DesignCanvasEffects.overflow(
                blur: $0.geometry.radius,
                x: $0.geometry.x,
                y: $0.geometry.y
            )
        }.max() ?? 0
        if style == .activeAssistant {
            let shadow = activeShadow(phase: phase)
            overflow = max(overflow, DesignCanvasEffects.overflow(blur: shadow.blur, y: shadow.y))
        }
        return overflow
    }

    private func draw(
        phase: Double?,
        in context: inout GraphicsContext,
        faceRect: CGRect
    ) {
        let facePath = path(in: faceRect)
        drawRoleShadow(phase: phase, in: &context, faceRect: faceRect)
        drawPlateElevation(in: &context, faceRect: faceRect)

        let face = faceColors
        context.fill(facePath, with: .linearGradient(
            Gradient(colors: [face.top, face.bottom]),
            startPoint: CGPoint(x: faceRect.midX, y: faceRect.minY),
            endPoint: CGPoint(x: faceRect.midX, y: faceRect.maxY)
        ))
        drawCommonBow(in: &context, faceRect: faceRect, facePath: facePath)
        if let phase, breathes {
            drawSpeakingWave(phase: phase, in: &context, faceRect: faceRect, facePath: facePath)
        }
        drawTopLight(in: &context, faceRect: faceRect)

        var border = context
        border.clip(to: facePath)
        border.stroke(facePath, with: .color(borderColor), lineWidth: 1)
    }

    private var faceColors: (top: Color, bottom: Color) {
        let base = style == .user ? DuskColors.accent50 : DuskColors.paper
        return (base.overlaying(DuskColors.ink, opacity: 0.04), base)
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

    private func drawPlateElevation(
        in context: inout GraphicsContext,
        faceRect: CGRect
    ) {
        let plate = DesignCanvasSurfaceRecipe.make(tier: .plate, increasedContrast: contrast == .increased)
        for shadow in [plate.cast, plate.contact] {
            drawShadow(
                color: shadow.color, opacity: shadow.opacity,
                blur: shadow.geometry.radius, y: shadow.geometry.y,
                sourceInset: shadow.geometry.sourceInset,
                in: &context, faceRect: faceRect
            )
        }
    }

    private func drawRoleShadow(
        phase: Double?,
        in context: inout GraphicsContext,
        faceRect: CGRect
    ) {
        switch style {
        case .activeAssistant:
            let shadow = activeShadow(phase: phase)
            drawShadow(
                color: DuskColors.accent, opacity: shadow.opacity,
                blur: shadow.blur, y: shadow.y, sourceInset: shadow.inset,
                in: &context, faceRect: faceRect
            )
        case .assistant, .user, .interrupted:
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

    private func drawCommonBow(
        in context: inout GraphicsContext,
        faceRect: CGRect,
        facePath: Path
    ) {
        guard faceRect.width > 0, faceRect.height > 0 else { return }
        var bow = context
        bow.clip(to: facePath)
        bow.translateBy(x: faceRect.midX, y: faceRect.midY)
        bow.scaleBy(x: faceRect.width / 2, y: faceRect.height / 2)
        bow.fill(
            Path(CGRect(x: -1, y: -1, width: 2, height: 2)),
            with: .radialGradient(
                Gradient(stops: [
                    .init(color: DuskColors.bgSunk.opacity(0.24), location: 0),
                    .init(color: DuskColors.bgSunk.opacity(0.12), location: 0.65),
                    .init(color: DuskColors.bgSunk.opacity(0), location: 1),
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
        shape.path(in: rect, inset: inset)
    }
}

/// Shared chat geometry. Values continue to project the existing central
/// design/KMP tokens; this type only names message-specific composition.
enum BubbleLayout {
    static let standardOffset: CGFloat = .zero
    static let continuationPullup = -Space.lg
    static let avatarSize: CGFloat = 28
    static let identityHeight: CGFloat = 34
    static let edgeMin: CGFloat = 12
    static let pulseDot: CGFloat = 5
    static let pulseGap: CGFloat = 4
    static let pulseDuration: Double = 1.2
    static let pulseStagger: Double = 0.14
}
