// ---------------------------------------------------------------------------
// ComposerTaskStrip — the composer's live tool/task rows, flush with the top
// edge of the composer, inside its border (design v2,
// `sentient-webui-design-v2/screenshots/00-chat-reference.png`; spec
// `docs/superpowers/specs/2026-04-18-cerebrum-ux-refresh-design.md` §4.9).
// Mirrors the webui composer-task-strip.tsx.
//
// It replaced pills attached to a chat bubble. Those forced every client to
// answer "which bubble does this pill belong to", which has no stable answer
// once a mid-turn steer can split a reply. The strip has no anchor: the
// gateway owns the full row list (a `tasklist.state` full-state frame,
// surfaced here as `ChatModel.tasks`) and decides which rows exist and when
// they leave — this only renders them.
//
// The strip owns its own `openId` — no bubble to coordinate an anchor with.
// The tapped pill's detail renders ABOVE the pills row (spec §4.9: "click pill
// to expand detail upward") because the strip sits at the very top of the
// composer card; an expansion has nowhere to grow but up. Unlike the old
// bubble-anchored strip, this sits INSIDE the composer card's own padding, so
// it takes no bleed padding of its own — an empty list renders EmptyView(),
// adding no height and no border to the composer.
import SwiftUI
import MobileData

struct ComposerTaskStrip: View {
    let items: [TaskListItem]
    /// Keyed by `id` — the row's identity for both a foreground tool call and a
    /// background `delegateTask` (see TaskListItem.kind).
    @State private var openId: String?

    var body: some View {
        if items.isEmpty {
            EmptyView()
        } else {
            VStack(spacing: 0) {
                if let open = items.first(where: { $0.id == openId }) {
                    detail(open)
                }
                HStack(spacing: 0) {
                    ForEach(items, id: \.id) { item in pill(item) }
                }
            }
            .accessibilityIdentifier("task-strip")
        }
    }

    private func pill(_ item: TaskListItem) -> some View {
        Button {
            openId = (openId == item.id) ? nil : item.id
        } label: {
            HStack(spacing: Space.sm) {
                StatusDot(status: item.status)
                // Strip MCP/adapter routing prefixes for display (webui parity);
                // the raw name stays available via the expandable argsPreview.
                Text(formatToolName(rawName: item.toolName))
                    .font(Typo.mono(TypeScale.sm))
                    .lineLimit(1)
                    .foregroundStyle(DuskColors.ink)
                if !item.argsPreview.isEmpty {
                    Image(systemName: "chevron.right")
                        .font(.system(size: ToolPillLayout.chevronSize))
                        .rotationEffect(.degrees(openId == item.id ? 90 : 0))
                        .foregroundStyle(openId == item.id ? DuskColors.accent : DuskColors.ink4)
                }
            }
            .padding(.vertical, Space.sm)
            .padding(.horizontal, Space.md)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
        .background(DuskColors.ink.opacity(0.04))
        .accessibilityIdentifier("task-pill-\(item.id)")
    }

    private func detail(_ item: TaskListItem) -> some View {
        // `argsPreview` is user content — rendered verbatim, never logged.
        Text(item.argsPreview)
            .font(Typo.mono(TypeScale.sm))
            .foregroundStyle(DuskColors.ink2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Space.md)
            .background(DuskColors.accent.opacity(0.10))
    }
}

/// Status dot — running (amber spinner), done (ok), error (stop), unknown
/// default (ink4, covers a malformed/defaulted row — see TaskListItem's
/// per-field defaults).
private struct StatusDot: View {
    let status: String

    var body: some View {
        switch status {
        case "running":
            ProgressView()
                .controlSize(.mini)
                .tint(DuskColors.amber)
        default:
            Circle()
                .fill(dotColor)
                .frame(width: ToolPillLayout.dotSize, height: ToolPillLayout.dotSize)
        }
    }

    private var dotColor: Color {
        switch status {
        case "done": return DuskColors.ok
        case "error": return DuskColors.stop
        default: return DuskColors.ink4
        }
    }
}

private enum ToolPillLayout {
    static let dotSize: CGFloat = 6
    static let chevronSize: CGFloat = 10
}
