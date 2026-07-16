// ---------------------------------------------------------------------------
// RowSelect — label + current-value chip that opens a Menu of options.
// Transcribed from the webui `Select` primitive (components/settings/
// primitives/select.tsx: a custom dropdown button + option list) as a native
// SwiftUI `Menu`, which gives the same "tap → pick one" affordance with
// platform-native presentation (context menu / popover) instead of
// reimplementing an outside-tap-to-close overlay.
//
// Used for Model's model picker, Advanced's Reasoning select, etc.
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
    let options: [SelectOption]
    let selectedId: String
    let accessibilityId: String
    let onSelect: (String) -> Void

    private var currentLabel: String {
        options.first(where: { $0.id == selectedId })?.label ?? placeholderText
    }

    var body: some View {
        HStack(spacing: Space.lg) {
            Text(label)
                .font(Typo.ui(TypeScale.sm, .medium))
                .foregroundStyle(DuskColors.ink)
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
                }
            } label: {
                menuLabel
            }
            .accessibilityIdentifier(accessibilityId)
        }
        .padding(.vertical, Space.sm)
    }

    private var menuLabel: some View {
        HStack(spacing: Space.xs) {
            Text(currentLabel)
                .font(Typo.mono(TypeScale.sm))
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
    .padding(Space.lg)
    .background(DuskColors.bg)
    .preferredColorScheme(.dark)
}
