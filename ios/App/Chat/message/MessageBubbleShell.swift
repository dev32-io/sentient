// ---------------------------------------------------------------------------
// MessageBubbleShell — the shared message row and bubble surface.
//
// Role-specific message views supply only content and (for outbox rows) a
// footer. Alignment, timestamp, metadata, width, material, shape, and
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
    let avatarMode: SentientIdentityState
    let accessibilityIdentifier: String?
    let pending: Bool
    @ViewBuilder let content: () -> Content
    @ViewBuilder let footer: () -> Footer

    @Environment(\.bubbleMaxWidth) private var bubbleMaxWidth
    @Environment(\.sentientIdentityMeasurement) private var measurement
    @Environment(\.sentientIdentityPlaybackEnabled) private var playbackEnabled

    init(
        role: MessageBubbleRole,
        name: String,
        timestamp: Int64?,
        isStreaming: Bool,
        cutoffLabel: String?,
        index: Int,
        total: Int,
        avatarMode: SentientIdentityState,
        accessibilityIdentifier: String? = nil,
        pending: Bool = false,
        @ViewBuilder content: @escaping () -> Content
    ) where Footer == EmptyView {
        self.role = role
        self.name = name
        self.timestamp = timestamp
        self.isStreaming = isStreaming
        self.cutoffLabel = cutoffLabel
        self.index = index
        self.total = total
        self.avatarMode = avatarMode
        self.accessibilityIdentifier = accessibilityIdentifier
        self.pending = pending
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
        avatarMode: SentientIdentityState,
        accessibilityIdentifier: String? = nil,
        pending: Bool = false,
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
        self.avatarMode = avatarMode
        self.accessibilityIdentifier = accessibilityIdentifier
        self.pending = pending
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
            // Preserve native source paragraph/cell/link actions and footer
            // actions inside one independently labeled chronology container.
            .accessibilityElement(children: .contain)
            .accessibilityLabel(accessibilityChronology)
    }

    private var row: some View {
        HStack(alignment: .top, spacing: 0) {
            if role.isUser { Spacer(minLength: BubbleLayout.edgeMin) }
            VStack(alignment: role.isUser ? .trailing : .leading, spacing: Space.xs) {
                MessageMeta(timestamp: timestamp)
                    .accessibilityHidden(true)
                bubbleBody
                footer()
            }
            if !role.isUser { Spacer(minLength: BubbleLayout.edgeMin) }
        }
        .frame(maxWidth: .infinity)
    }

    private var bubbleBody: some View {
        content()
            .padding(.vertical, Space.md)
            .padding(.horizontal, Space.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
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
                        pending: pending,
                        breathes: !role.isUser && avatarMode == .responding && playbackEnabled
                    )
                }
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
        if isStreaming || avatarMode == .responding {
            return "\(position), responding"
        }
        if let timestamp {
            let time = Date(timeIntervalSince1970: Double(timestamp) / 1000)
                .formatted(date: .omitted, time: .shortened)
            return "\(position) at \(time)\(cutoffLabel.map { ", \($0)" } ?? "")"
        }
        return "\(position), pending"
    }

    private var bubbleShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: Radii.lg, style: .continuous)
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
    let shape: RoundedRectangle
    let style: BubbleChromeStyle
    let pending: Bool
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
            let overflow = shadowOverflow()
            let faceRect = CGRect(
                x: overflow, y: overflow,
                width: proxy.size.width, height: proxy.size.height
            )

            // Long replies exceed Metal's texture limit when the whole bubble is
            // one Canvas. Tiles share the full shape/gradient coordinates; shadow
            // overscan avoids seams without changing appearance or row geometry.
            let width = proxy.size.width + overflow * 2
            let height = proxy.size.height + overflow * 2
            let tileHeight: CGFloat = 512
            VStack(spacing: 0) {
                ForEach(0..<Int(ceil(height / tileHeight)), id: \.self) { index in
                    let start = CGFloat(index) * tileHeight
                    let span = min(tileHeight, height - start)
                    Canvas(opaque: false, colorMode: .nonLinear, rendersAsynchronously: true) { context, size in
                        context.clip(to: Path(CGRect(origin: .zero, size: size)))
                        context.translateBy(x: 0, y: overflow - start)
                        draw(phase: phase, in: &context, faceRect: faceRect)
                    }
                    .frame(width: width, height: span + overflow * 2)
                    .offset(y: -overflow)
                    .frame(height: span, alignment: .top)
                    .clipped()
                    // Animate bounded decorative tiles, never flatten the tall
                    // document or fade accessible content/controls.
                    .opacity(pending ? 0.64 : 1)
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: pending)
                }
            }
            .frame(width: width, height: height)
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

    private func shadowOverflow() -> CGFloat {
        BubbleLayout.chromeOverflow(increasedContrast: contrast == .increased)
    }

    private func draw(
        phase: Double?,
        in context: inout GraphicsContext,
        faceRect: CGRect
    ) {
        let facePath = path(in: faceRect)
        drawRoleShadow(in: &context, faceRect: faceRect)
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
        in context: inout GraphicsContext,
        faceRect: CGRect
    ) {
        switch style {
        case .activeAssistant:
            let shadow = activeShadow()
            drawShadow(
                color: DuskColors.accent, opacity: shadow.opacity,
                blur: shadow.blur, y: shadow.y, sourceInset: shadow.inset,
                in: &context, faceRect: faceRect
            )
        case .assistant, .user, .interrupted:
            break
        }
    }

    private func activeShadow() -> (opacity: Double, blur: CGFloat, y: CGFloat, inset: CGFloat) {
        // Center the cast on the full contour, including its rounded top.
        // An inset/downshifted source hides the glow along the upper perimeter.
        BubbleLayout.activeShadow
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
        let travel = CGFloat((1 - cos(phase * 2 * .pi)) / 2)
        let x = faceRect.minX + travel * width * 2.2 - width * 0.7
        var wave = context
        // One shared clip covers the rounded face.
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
        let inset = min(max(0, inset), max(0, (min(rect.width, rect.height) - 1) / 2))
        return shape.inset(by: inset).path(in: rect)
    }
}

/// Shared chat geometry. Values continue to project the existing central
/// design/KMP tokens; this type only names message-specific composition.
enum BubbleLayout {
    static let activeShadow: (opacity: Double, blur: CGFloat, y: CGFloat, inset: CGFloat) = (0.42, 20, 0, 0)

    static func chromeOverflow(increasedContrast: Bool) -> CGFloat {
        let plate = DesignCanvasSurfaceRecipe.make(tier: .plate, increasedContrast: increasedContrast)
        return max(
            [plate.cast, plate.contact].map {
                DesignCanvasEffects.overflow(blur: $0.geometry.radius, x: $0.geometry.x, y: $0.geometry.y)
            }.max() ?? 0,
            DesignCanvasEffects.overflow(blur: activeShadow.blur, y: activeShadow.y)
        )
    }

    // Hosting's render boundary can cull Canvas overflow even when UIView's
    // clipsToBounds is false. Reserve decoration only, outside row geometry.
    static let hostingOverflow = max(chromeOverflow(increasedContrast: false), chromeOverflow(increasedContrast: true))

    static let standardOffset: CGFloat = .zero
    static func rowGap(width: CGFloat) -> CGFloat { width < 600 ? Space.lg : Space.xl }
    static func rowMargin(width: CGFloat) -> CGFloat { width < 600 ? Space.md : Space.lg }
    static func continuationPullup(width: CGFloat) -> CGFloat { -rowMargin(width: width) }
    static let edgeMin: CGFloat = 12
    static let pulseDot: CGFloat = 6
    static let pulseGap: CGFloat = 4
    static let pulseDuration: Double = Motion.respondingCadence
}

private struct ChatUserAvatarTintKey: EnvironmentKey {
    static let defaultValue: DesignUserAvatarTint = .fallback
}

extension EnvironmentValues {
    /// Authenticated host supplies existing server tint; never infer from name.
    var chatUserAvatarTint: DesignUserAvatarTint {
        get { self[ChatUserAvatarTintKey.self] }
        set { self[ChatUserAvatarTintKey.self] = newValue }
    }
}
