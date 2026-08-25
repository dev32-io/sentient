// ---------------------------------------------------------------------------
// RowSelect — label (+ optional sub) + current-value chip that opens a Menu of
// options. Transcribed from the webui `Select` primitive (components/settings/
// primitives/select.tsx: a custom dropdown button + option list) as a native
// SwiftUI `Menu`, which gives the same "tap → pick one" affordance with
// platform-native presentation (context menu / popover) instead of
// reimplementing an outside-tap-to-close overlay.
//
// Used for Model's model picker, Advanced's Reasoning select, Voice's language
// filter, and — with `sub` + `isEnabled` — the Tools screen's per-tool
// permission control (mono tool name + description, four-state Allow/Ask/
// Deny/Off; `isEnabled: false` renders it genuinely non-interactive for an
// unsettable tool, matching the webui Select's `disabled` prop).
//
// Stateless leaf: `selectedId` + `onSelect` in, no local state.
// ---------------------------------------------------------------------------
import SwiftUI

private let placeholderText = "Select…"

struct SelectOption: Identifiable, Equatable {
    let id: String
    let label: String
}

struct RowSelect: View {
    let label: String
    var sub: String?
    let options: [SelectOption]
    let selectedId: String
    let accessibilityId: String
    var isEnabled: Bool = true
    let onSelect: (String) -> Void

    private var currentLabel: String {
        options.first(where: { $0.id == selectedId })?.label ?? placeholderText
    }

    var body: some View {
        HStack(spacing: Space.lg) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(label)
                    .font(Typo.ui(TypeScale.base, .medium))
                    .foregroundStyle(DuskColors.ink)
                if let sub {
                    Text(sub)
                        .font(Typo.ui(TypeScale.xs))
                        .foregroundStyle(DuskColors.ink3)
                }
            }
            Spacer(minLength: Space.sm)
            Menu {
                ForEach(options) { option in
                    Button {
                        onSelect(option.id)
                    } label: {
                        if option.id == selectedId {
                            Label(option.label, systemImage: "checkmark")
                        } else {
                            Text(option.label)
                        }
                    }
                    // Mirrors Android's settings-select-option-<value> testTag. SwiftUI
                    // renders Menu options in a separate UIMenu presentation; verified live
                    // via `maestro hierarchy` (iOS 18.3 sim) that these ids DO surface and
                    // are independently tappable. If a future OS/Xcode combo regresses that
                    // (Menu's separate-window a11y tree is a known soft spot), the option is
                    // still addressable by its visible label text as a fallback.
                    .accessibilityIdentifier("settings-select-option-\(option.id)")
                }
            } label: {
                menuLabel
            }
            // `.disabled` blocks the tap from reaching the Menu at all (genuinely
            // non-interactive, not merely styled to look so); the opacity dim is
            // the only visual cue since a custom Menu label doesn't auto-dim the
            // way native Button/Toggle styles do under `isEnabled`.
            .disabled(!isEnabled)
            .opacity(isEnabled ? 1 : 0.5)
            .accessibilityIdentifier(accessibilityId)
        }
        .frame(minHeight: DesignMetrics.minimumTarget)
        .padding(.vertical, Space.sm)
    }

    private var menuLabel: some View {
        HStack(spacing: Space.xs) {
            Text(currentLabel)
                .font(Typo.mono(TypeScale.base))
                .foregroundStyle(DuskColors.ink)
                .lineLimit(1)
            Image(systemName: "chevron.up.chevron.down")
                .font(.system(size: TypeScale.xs))
                .foregroundStyle(DuskColors.ink3)
        }
        .padding(.horizontal, Space.sm)
        .padding(.vertical, Space.xs)
        .background(DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.sm))
        .overlay(RoundedRectangle(cornerRadius: Radii.sm).stroke(DuskColors.lineSoft, lineWidth: 1))
    }
}

#Preview {
    VStack(spacing: Space.lg) {
        RowSelect(
            label: "Reasoning",
            options: [
                SelectOption(id: "none", label: "None"),
                SelectOption(id: "low", label: "Low"),
                SelectOption(id: "high", label: "High"),
                SelectOption(id: "xhigh", label: "X-High"),
            ],
            selectedId: "high",
            accessibilityId: "settings-advanced-reasoning",
            onSelect: { _ in }
        )
        RowSelect(
            label: "delegateTask",
            sub: "Hand a task to Hermes in the background.",
            options: [
                SelectOption(id: "allow", label: "Allow"),
                SelectOption(id: "ask", label: "Ask"),
                SelectOption(id: "deny", label: "Deny"),
                SelectOption(id: "off", label: "Off"),
            ],
            selectedId: "ask",
            accessibilityId: "settings-tools-native-delegateTask",
            isEnabled: false,
            onSelect: { _ in }
        )
    }
    .padding(Space.lg)
    .background(DuskColors.bg)
    .preferredColorScheme(.dark)
}
