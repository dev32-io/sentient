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
    case auto
    case cancel

    var systemName: String {
        switch self {
        case .attachment: "paperclip"
        case .spokenResponsesOn: "speaker.wave.2"
        case .spokenResponsesOff: "speaker.slash"
        case .stopResponse: "stop"
        case .send: "paperplane"
        case .microphone: "mic"
        case .auto: "lightbulb"
        case .cancel: "xmark"
        }
    }
}

extension VoiceCaptureTarget {
    var composerGlyph: ComposerGlyph {
        switch self {
        case .auto: .auto
        case .cancel: .cancel
        case .send: .send
        }
    }
}

extension Image {
    init(composerGlyph: ComposerGlyph) {
        self.init(systemName: composerGlyph.systemName)
    }
}
