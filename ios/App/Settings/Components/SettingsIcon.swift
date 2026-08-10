// ---------------------------------------------------------------------------
// SettingsIcon — category → SF Symbol mapping for the mobile Settings surface.
//
// The webui sidebar (nav-config.ts) uses its own SVG icon set per category;
// iOS uses the nearest SF Symbol per category instead of transcribing SVGs
// (native convention — see the mobile-settings-parity plan's UX section).
// Android instead transcribes the webui SVGs to Compose ImageVectors; iOS
// intentionally diverges here since SF Symbols is the idiomatic source for a
// native iOS icon set.
//
// One case per Settings root-list category (Soul / User / Admin / Support
// groups). `symbolName` feeds `Image(systemName:)` directly from CategoryRow.
// All symbols below are documented as available since SF Symbols 1–3 (iOS
// 13–15), well under this project's iOS 18.0 deployment target.
// ---------------------------------------------------------------------------
import Foundation

enum SettingsIcon {
    case memory
    case personalities
    case voice
    case audio
    case model
    case tools
    case systemPrompt
    case advanced
    case account
    case members
    case secrets
    case diagnostics

    /// SF Symbol name for `Image(systemName:)`.
    var symbolName: String {
        switch self {
        case .memory: return "brain"
        case .personalities: return "theatermasks"
        case .voice: return "waveform"
        case .audio: return "speaker.wave.2"
        case .model: return "cpu"
        case .tools: return "wrench"
        case .systemPrompt: return "book"
        case .advanced: return "slider.horizontal.3"
        case .account: return "person.circle"
        case .members: return "person.3"
        case .secrets: return "key"
        case .diagnostics: return "waveform.path.ecg"
        }
    }
}
