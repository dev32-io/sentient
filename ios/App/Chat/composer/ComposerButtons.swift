import SwiftUI

/// Native glyph mapping for the approved composer actions. Keeping this map
/// semantic prevents state-specific controls from drifting to unrelated SF
/// Symbols while labels continue to carry the full accessible meaning.
enum ComposerGlyph: Equatable, Sendable {
    case attachment
    case spokenResponsesOn
    case spokenResponsesOff
    case stopResponse
    case send
    case microphone
    case cancel

    var systemName: String {
        switch self {
        case .attachment: "paperclip"
        case .spokenResponsesOn: "speaker.wave.2"
        case .spokenResponsesOff: "speaker.slash"
        case .stopResponse: "stop"
        case .send: "paperplane"
        case .microphone: "mic"
        case .cancel: "xmark"
        }
    }
}

/// Native path translation of the approved 24-point `i-auto` artwork: the
/// large bulb arc from (8, 17) to (16, 17), internal plus, and base line.
struct ComposerAutoGlyphShape: Shape {
    static let approvedViewBox = CGSize(width: 24, height: 24)
    static let bulbStart = CGPoint(x: 8, y: 17)
    static let bulbEnd = CGPoint(x: 16, y: 17)
    static let horizontalMarkStart = CGPoint(x: 9, y: 12)
    static let horizontalMarkEnd = CGPoint(x: 15, y: 12)
    static let verticalMarkStart = CGPoint(x: 12, y: 9)
    static let verticalMarkEnd = CGPoint(x: 12, y: 15)
    static let baseStart = CGPoint(x: 8, y: 20)
    static let baseEnd = CGPoint(x: 16, y: 20)

    func path(in rect: CGRect) -> Path {
        let scale = min(
            rect.width / Self.approvedViewBox.width,
            rect.height / Self.approvedViewBox.height
        )
        let origin = CGPoint(
            x: rect.midX - Self.approvedViewBox.width * scale / 2,
            y: rect.midY - Self.approvedViewBox.height * scale / 2
        )
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: origin.x + x * scale, y: origin.y + y * scale)
        }

        var path = Path()
        let radius: CGFloat = 6
        let center = CGPoint(
            x: (Self.bulbStart.x + Self.bulbEnd.x) / 2,
            y: Self.bulbStart.y - sqrt(20)
        )
        let start = atan2(
            Self.bulbStart.y - center.y,
            Self.bulbStart.x - center.x
        )
        let end = atan2(
            Self.bulbEnd.y - center.y,
            Self.bulbEnd.x - center.x
        ) + 2 * .pi
        let segments = 4
        let step = (end - start) / CGFloat(segments)
        let tangent = 4 / 3 * tan(step / 4)

        path.move(to: point(Self.bulbStart.x, Self.bulbStart.y))
        for index in 0..<segments {
            let angle0 = start + CGFloat(index) * step
            let angle1 = angle0 + step
            let control1 = CGPoint(
                x: center.x + radius * (cos(angle0) - tangent * sin(angle0)),
                y: center.y + radius * (sin(angle0) + tangent * cos(angle0))
            )
            let control2 = CGPoint(
                x: center.x + radius * (cos(angle1) + tangent * sin(angle1)),
                y: center.y + radius * (sin(angle1) - tangent * cos(angle1))
            )
            let endpoint = CGPoint(
                x: center.x + radius * cos(angle1),
                y: center.y + radius * sin(angle1)
            )
            path.addCurve(
                to: point(endpoint.x, endpoint.y),
                control1: point(control1.x, control1.y),
                control2: point(control2.x, control2.y)
            )
        }

        path.move(to: point(Self.horizontalMarkStart.x, Self.horizontalMarkStart.y))
        path.addLine(to: point(Self.horizontalMarkEnd.x, Self.horizontalMarkEnd.y))
        path.move(to: point(Self.verticalMarkStart.x, Self.verticalMarkStart.y))
        path.addLine(to: point(Self.verticalMarkEnd.x, Self.verticalMarkEnd.y))
        path.move(to: point(Self.baseStart.x, Self.baseStart.y))
        path.addLine(to: point(Self.baseEnd.x, Self.baseEnd.y))
        return path
    }
}

struct ComposerAutoGlyph: View {
    var body: some View {
        GeometryReader { proxy in
            let scale = min(proxy.size.width, proxy.size.height) / ComposerAutoGlyphShape.approvedViewBox.width
            ComposerAutoGlyphShape()
                .stroke(
                    style: StrokeStyle(
                        lineWidth: 1.7 * scale,
                        lineCap: .round,
                        lineJoin: .round
                    )
                )
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityHidden(true)
    }
}

extension Image {
    init(composerGlyph: ComposerGlyph) {
        self.init(systemName: composerGlyph.systemName)
    }
}
