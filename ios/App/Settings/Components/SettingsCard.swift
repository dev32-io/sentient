// ---------------------------------------------------------------------------
// SettingsCard — card container grouping related settings rows, transcribed
// from the webui `Card` primitive (components/settings/primitives/card.tsx +
// primitives.css `.sc-card`/`.sc-h`/`.sc-body`): paper surface, line-soft
// border, radius-md corners, an optional elevated header (title + sub) with
// a hairline bottom divider, and a padded body.
//
// Pure container: `content` is any row stack (RowToggle, RowSlider, …) the
// caller composes. No row-divider logic lives here — callers insert
// `Divider()` between rows if a visual separator is wanted, keeping each row
// view self-contained per the decorator-pattern-style "no unit owns more
// than its job" spirit.
// ---------------------------------------------------------------------------
import SwiftUI

struct SettingsCard<Content: View>: View {
    var title: String?
    var sub: String?
    @ViewBuilder var content: () -> Content

    init(title: String? = nil, sub: String? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.sub = sub
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let title {
                header(title: title, sub: sub)
            }
            VStack(alignment: .leading, spacing: 0, content: content)
                .padding(.horizontal, Space.lg)
                .padding(.vertical, Space.sm)
        }
        .background(DuskColors.paper)
        .clipShape(RoundedRectangle(cornerRadius: Radii.md))
        .overlay(RoundedRectangle(cornerRadius: Radii.md).stroke(DuskColors.lineSoft, lineWidth: 1))
    }

    private func header(title: String, sub: String?) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(title)
                .font(Typo.ui(TypeScale.sm, .semibold))
                .foregroundStyle(DuskColors.ink)
            if let sub {
                Text(sub)
                    .font(Typo.ui(TypeScale.xs))
                    .foregroundStyle(DuskColors.ink3)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.md)
        .background(DuskColors.bgElev)
        .overlay(alignment: .bottom) {
            Rectangle().fill(DuskColors.lineSoft).frame(height: 1)
        }
    }
}

#Preview {
    ScrollView {
        VStack(spacing: Space.lg) {
            SettingsCard(title: "Memory", sub: "Hard-capped per Hermes spec.") {
                Text("Row content goes here")
                    .font(Typo.ui(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink2)
                    .padding(.vertical, Space.sm)
            }
            SettingsCard {
                Text("Header-less card")
                    .font(Typo.ui(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink2)
                    .padding(.vertical, Space.sm)
            }
        }
        .padding(Space.lg)
    }
    .background(DuskColors.bg)
    .preferredColorScheme(.dark)
}
