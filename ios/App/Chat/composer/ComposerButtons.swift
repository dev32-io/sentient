import SwiftUI

/// Composer-local translations of the approved 24-point SVG artwork. These
/// paths intentionally do not change the app's shared or SF Symbol mappings.
enum ComposerGlyph: String, CaseIterable, Hashable, Sendable {
    case attachment
    case spokenResponsesOn
    case spokenResponsesOff
    case stopResponse
    case send
    case microphone
    case auto
    case cancel

    static let approvedViewBox = CGSize(width: 24, height: 24)
    static let approvedStrokeWidth: CGFloat = 1.7

    var approvedSourceElements: [String] {
        switch self {
        case .microphone:
            [
                "rect x=8 y=3 width=8 height=12 rx=4",
                "M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6",
            ]
        case .send:
            ["m4 4 17 8-17 8 3-8zM7 12h14"]
        case .spokenResponsesOn:
            ["M5 10v4h4l5 4V6l-5 4zM17 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"]
        case .spokenResponsesOff:
            ["M5 10v4h4l5 4V6l-5 4zM3 3l18 18"]
        case .attachment:
            ["m9 12 6-6a4 4 0 0 1 6 6l-8 8a6 6 0 0 1-8-8l8-8"]
        case .stopResponse:
            ["rect x=7 y=7 width=10 height=10 rx=2"]
        case .auto:
            ["M8 17a6 6 0 1 1 8 0M9 12h6M12 9v6M8 20h8"]
        case .cancel:
            ["m6 6 12 12M18 6 6 18"]
        }
    }

    fileprivate func approvedPath() -> Path {
        var builder = ComposerGlyphPathBuilder()
        switch self {
        case .microphone:
            builder.roundedRect(CGRect(x: 8, y: 3, width: 8, height: 12), radius: 4)
            builder.move(to: CGPoint(x: 5, y: 11))
            builder.circularArc(to: CGPoint(x: 19, y: 11), radius: 7, largeArc: false, sweep: false)
            builder.move(to: CGPoint(x: 12, y: 18))
            builder.line(to: CGPoint(x: 12, y: 21))
            builder.move(to: CGPoint(x: 9, y: 21))
            builder.line(to: CGPoint(x: 15, y: 21))
        case .send:
            builder.move(to: CGPoint(x: 4, y: 4))
            builder.line(to: CGPoint(x: 21, y: 12))
            builder.line(to: CGPoint(x: 4, y: 20))
            builder.line(to: CGPoint(x: 7, y: 12))
            builder.close()
            builder.move(to: CGPoint(x: 7, y: 12))
            builder.line(to: CGPoint(x: 21, y: 12))
        case .spokenResponsesOn:
            builder.addSpeakerBody()
            builder.move(to: CGPoint(x: 17, y: 9))
            builder.circularArc(to: CGPoint(x: 17, y: 15), radius: 4, largeArc: false, sweep: true)
            builder.move(to: CGPoint(x: 19, y: 6))
            builder.circularArc(to: CGPoint(x: 19, y: 18), radius: 8, largeArc: false, sweep: true)
        case .spokenResponsesOff:
            builder.addSpeakerBody()
            builder.move(to: CGPoint(x: 3, y: 3))
            builder.line(to: CGPoint(x: 21, y: 21))
        case .attachment:
            builder.move(to: CGPoint(x: 9, y: 12))
            builder.line(to: CGPoint(x: 15, y: 6))
            builder.circularArc(to: CGPoint(x: 21, y: 12), radius: 4, largeArc: false, sweep: true)
            builder.line(to: CGPoint(x: 13, y: 20))
            builder.circularArc(to: CGPoint(x: 5, y: 12), radius: 6, largeArc: false, sweep: true)
            builder.line(to: CGPoint(x: 13, y: 4))
        case .stopResponse:
            builder.roundedRect(CGRect(x: 7, y: 7, width: 10, height: 10), radius: 2)
        case .auto:
            builder.move(to: CGPoint(x: 8, y: 17))
            builder.circularArc(to: CGPoint(x: 16, y: 17), radius: 6, largeArc: true, sweep: true)
            builder.move(to: CGPoint(x: 9, y: 12))
            builder.line(to: CGPoint(x: 15, y: 12))
            builder.move(to: CGPoint(x: 12, y: 9))
            builder.line(to: CGPoint(x: 12, y: 15))
            builder.move(to: CGPoint(x: 8, y: 20))
            builder.line(to: CGPoint(x: 16, y: 20))
        case .cancel:
            builder.move(to: CGPoint(x: 6, y: 6))
            builder.line(to: CGPoint(x: 18, y: 18))
            builder.move(to: CGPoint(x: 18, y: 6))
            builder.line(to: CGPoint(x: 6, y: 18))
        }
        return builder.path
    }
}

struct ComposerGlyphShape: Shape {
    let glyph: ComposerGlyph

    func path(in rect: CGRect) -> Path {
        let scale = min(
            rect.width / ComposerGlyph.approvedViewBox.width,
            rect.height / ComposerGlyph.approvedViewBox.height
        )
        let origin = CGPoint(
            x: rect.midX - ComposerGlyph.approvedViewBox.width * scale / 2,
            y: rect.midY - ComposerGlyph.approvedViewBox.height * scale / 2
        )
        return glyph.approvedPath().applying(CGAffineTransform(
            a: scale,
            b: 0,
            c: 0,
            d: scale,
            tx: origin.x,
            ty: origin.y
        ))
    }
}

struct ComposerGlyphView: View {
    let glyph: ComposerGlyph

    init(_ glyph: ComposerGlyph) {
        self.glyph = glyph
    }

    var body: some View {
        GeometryReader { proxy in
            let scale = min(proxy.size.width, proxy.size.height)
                / ComposerGlyph.approvedViewBox.width
            ComposerGlyphShape(glyph: glyph)
                .stroke(style: StrokeStyle(
                    lineWidth: ComposerGlyph.approvedStrokeWidth * scale,
                    lineCap: .round,
                    lineJoin: .round
                ))
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityHidden(true)
    }
}

private struct ComposerGlyphPathBuilder {
    var path = Path()
    private var current = CGPoint.zero
    private var subpathStart = CGPoint.zero

    mutating func move(to point: CGPoint) {
        path.move(to: point)
        current = point
        subpathStart = point
    }

    mutating func line(to point: CGPoint) {
        path.addLine(to: point)
        current = point
    }

    mutating func close() {
        path.closeSubpath()
        current = subpathStart
    }

    mutating func roundedRect(_ rect: CGRect, radius: CGFloat) {
        path.addRoundedRect(
            in: rect,
            cornerSize: CGSize(width: radius, height: radius),
            style: .circular
        )
    }

    mutating func addSpeakerBody() {
        move(to: CGPoint(x: 5, y: 10))
        line(to: CGPoint(x: 5, y: 14))
        line(to: CGPoint(x: 9, y: 14))
        line(to: CGPoint(x: 14, y: 18))
        line(to: CGPoint(x: 14, y: 6))
        line(to: CGPoint(x: 9, y: 10))
        close()
    }

    /// Adds an SVG-style circular arc using cubic segments. All approved
    /// composer arcs are unrotated circles, so this preserves their authored
    /// endpoint, radius, large-arc, and sweep values without an SVG dependency.
    mutating func circularArc(
        to endpoint: CGPoint,
        radius requestedRadius: CGFloat,
        largeArc: Bool,
        sweep: Bool
    ) {
        let deltaX = (current.x - endpoint.x) / 2
        let deltaY = (current.y - endpoint.y) / 2
        let distanceSquared = deltaX * deltaX + deltaY * deltaY
        guard requestedRadius > 0, distanceSquared > 0 else {
            line(to: endpoint)
            return
        }

        let radius = max(requestedRadius, sqrt(distanceSquared))
        let radiusSquared = radius * radius
        let centerScale = (largeArc == sweep ? -1.0 : 1.0)
            * sqrt(max(0, (radiusSquared - distanceSquared) / distanceSquared))
        let center = CGPoint(
            x: (current.x + endpoint.x) / 2 + centerScale * deltaY,
            y: (current.y + endpoint.y) / 2 - centerScale * deltaX
        )
        let startAngle = atan2(current.y - center.y, current.x - center.x)
        let endAngle = atan2(endpoint.y - center.y, endpoint.x - center.x)
        var arcAngle = endAngle - startAngle
        if sweep, arcAngle < 0 { arcAngle += 2 * .pi }
        if !sweep, arcAngle > 0 { arcAngle -= 2 * .pi }

        let segmentCount = max(1, Int(ceil(abs(arcAngle) / (.pi / 2))))
        let segmentAngle = arcAngle / CGFloat(segmentCount)
        for index in 0..<segmentCount {
            let angle0 = startAngle + CGFloat(index) * segmentAngle
            let angle1 = angle0 + segmentAngle
            let tangent = 4 / 3 * tan(segmentAngle / 4)
            let start = CGPoint(
                x: center.x + radius * cos(angle0),
                y: center.y + radius * sin(angle0)
            )
            let end = CGPoint(
                x: center.x + radius * cos(angle1),
                y: center.y + radius * sin(angle1)
            )
            path.addCurve(
                to: end,
                control1: CGPoint(
                    x: start.x - tangent * radius * sin(angle0),
                    y: start.y + tangent * radius * cos(angle0)
                ),
                control2: CGPoint(
                    x: end.x + tangent * radius * sin(angle1),
                    y: end.y - tangent * radius * cos(angle1)
                )
            )
        }
        current = endpoint
    }
}
