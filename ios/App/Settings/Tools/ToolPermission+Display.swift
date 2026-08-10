// ---------------------------------------------------------------------------
// ToolPermission+Display — wire-value / label mapping for the Tools screen's
// per-tool RowSelect. Mirrors the webui's PERMISSION_OPTION_BY_VALUE
// (tools-pane.tsx) and the shared ToolPermission.kt header's reasoning: this
// is a REAL Kotlin enum (unlike model.provider/voice.provider/audio.channel/
// advanced.reasoningEffort, which stay Strings for forward-compat), so
// `wireValue`/`displayLabel` are EXHAUSTIVE switches with no `default:` — a
// future fifth permission (`auto`, once a classifier exists — plan
// 2026-08-07-tool-permissions) must fail to COMPILE here, not fall through.
// ---------------------------------------------------------------------------
import MobileData

extension ToolPermission {
    /// The `SelectOption.id` this permission round-trips as through the Tools
    /// screen's RowSelect. Matches the gateway wire value (`toolPermissionSchema`).
    var wireValue: String {
        switch self {
        case .allow: return "allow"
        case .ask: return "ask"
        case .deny: return "deny"
        case .off: return "off"
        }
    }

    /// Human-facing label for the permission dropdown.
    var displayLabel: String {
        switch self {
        case .allow: return "Allow"
        case .ask: return "Ask"
        case .deny: return "Deny"
        case .off: return "Off"
        }
    }

    /// Reverse of `wireValue`. Built over `allCases` rather than its own
    /// switch, so a future fifth case needs no change here — only
    /// `wireValue`/`displayLabel` must be taught about it, and the compiler
    /// enforces that at their own (exhaustive) switch sites.
    init?(wireValue: String) {
        guard let match = Self.allCases.first(where: { $0.wireValue == wireValue }) else { return nil }
        self = match
    }

    /// The four-state permission dropdown's option list, in the gateway's
    /// declared enum order (Allow, Ask, Deny, Off). Built from `allCases` so
    /// the SET of options always matches the bridged Kotlin enum; only the
    /// per-case label needs a human hand once a fifth value ships.
    static let selectOptions: [SelectOption] = allCases.map { SelectOption(id: $0.wireValue, label: $0.displayLabel) }
}
