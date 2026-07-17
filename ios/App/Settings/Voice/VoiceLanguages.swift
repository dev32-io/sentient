// ---------------------------------------------------------------------------
// VoiceLanguages — the canonical Qwen3-TTS language list, mirrored into Swift.
//
// SINGLE SOURCE OF TRUTH is `shared/config/src/languages.ts` (LANGUAGE_DISPLAY /
// SUPPORTED_LANGUAGES), imported by the gateway (validation) and webui (dropdown
// + filter + tile badge). Kotlin has no cross-language import of that TS list yet
// (the mobile-sdk carries no language constant — verified), so this file is a
// hand-kept mirror. Android's Add-Voice form mirrors the SAME list (its voice
// page was still a P3a stub when this was written). Keep the two in sync with
// languages.ts: 10 codes, order + flags + names verbatim.
//
// Fish Audio returns codes outside this set (ar/hi/th/…); `normalize` drops
// those to "" exactly like the TS `normalizeLanguage`.
// ---------------------------------------------------------------------------
import Foundation

/// One Qwen-supported language: wire `code`, flag emoji, and display `name`.
struct VoiceLanguage: Identifiable, Equatable {
    let code: String
    let flag: String
    let name: String

    var id: String { code }
    /// "🇺🇸 English" — the dropdown / badge label.
    var label: String { "\(flag) \(name)" }
}

enum VoiceLanguages {
    /// Mirror of LANGUAGE_DISPLAY (shared/config/src/languages.ts), in the same order.
    static let all: [VoiceLanguage] = [
        VoiceLanguage(code: "zh", flag: "🇨🇳", name: "Chinese"),
        VoiceLanguage(code: "en", flag: "🇺🇸", name: "English"),
        VoiceLanguage(code: "ja", flag: "🇯🇵", name: "Japanese"),
        VoiceLanguage(code: "ko", flag: "🇰🇷", name: "Korean"),
        VoiceLanguage(code: "de", flag: "🇩🇪", name: "German"),
        VoiceLanguage(code: "fr", flag: "🇫🇷", name: "French"),
        VoiceLanguage(code: "ru", flag: "🇷🇺", name: "Russian"),
        VoiceLanguage(code: "pt", flag: "🇵🇹", name: "Portuguese"),
        VoiceLanguage(code: "es", flag: "🇪🇸", name: "Spanish"),
        VoiceLanguage(code: "it", flag: "🇮🇹", name: "Italian"),
    ]

    private static let byCode: [String: VoiceLanguage] =
        Dictionary(uniqueKeysWithValues: all.map { ($0.code, $0) })

    /// Display label for a code, or the upper-cased code with a globe when unknown.
    static func label(for code: String) -> String {
        byCode[code]?.label ?? "🌐 \(code.uppercased())"
    }

    /// Lower-cased code if it is a supported Qwen language, else "" (drops Fish's
    /// unsupported languages) — mirrors TS `normalizeLanguage`.
    static func normalize(_ code: String) -> String {
        let lower = code.lowercased()
        return byCode[lower] != nil ? lower : ""
    }

    /// Add-form options: "No language" ("") + the full canonical list, sorted by
    /// code for a stable dropdown (mirrors AddVoiceModal.LANG_OPTIONS).
    static var formOptions: [(code: String, label: String)] {
        [(code: "", label: "No language")]
            + all.sorted { $0.code < $1.code }.map { (code: $0.code, label: $0.label) }
    }

    /// Filter options for the Voice list: "All languages" + only the codes that
    /// actually appear on the loaded packs (mirrors webui `deriveLanguageOptions`).
    static func filterOptions(present: [String]) -> [(code: String, label: String)] {
        let codes = Array(Set(present.filter { !$0.isEmpty })).sorted()
        return [(code: "", label: "All languages")] + codes.map { (code: $0, label: label(for: $0)) }
    }
}
