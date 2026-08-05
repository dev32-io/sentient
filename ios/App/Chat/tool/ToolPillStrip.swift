// ---------------------------------------------------------------------------
// ToolPillStrip — flush pills at the bubble bottom, one per task on the message.
// Mirrors the webui tool-pill-strip.tsx. Tap a pill → expand its argsPreview.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct ToolPillStrip: View {
    let tools: [TaskSnapshotItem]
    /// Keyed by `toolCallId`, which is the row's identity — NOT `taskId`, which is
    /// non-nil only for a background tool. Keying on `taskId` made `nil == nil` true
    /// for every foreground row, so `first(where:)` always matched: the strip opened
    /// untapped, and the toggle below could only ever set nil to nil.
    @State private var openToolCallId: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                ForEach(tools, id: \.toolCallId) { t in pill(t) }
            }
            if let open = tools.first(where: { $0.toolCallId == openToolCallId }) {
                detail(open)
            }
        }
        .padding(.top, Space.md)
        .padding(.horizontal, -Space.padMsg)
        .padding(.bottom, -Space.padMsg)
    }

    private func pill(_ t: TaskSnapshotItem) -> some View {
        Button {
            openToolCallId = (openToolCallId == t.toolCallId) ? nil : t.toolCallId
        } label: {
            HStack(spacing: Space.sm) {
                StatusDot(status: t.status)
                // Strip MCP/adapter routing prefixes for display (webui parity);
                // the raw name stays available via the expandable argsPreview.
                Text(formatToolName(rawName: t.toolName))
                    .font(Typo.mono(TypeScale.sm))
                    .lineLimit(1)
                    .foregroundStyle(DuskColors.ink)
                if !t.argsPreview.isEmpty {
                    Image(systemName: "chevron.right")
                        .font(.system(size: ToolPillLayout.chevronSize))
                        .rotationEffect(.degrees(openToolCallId == t.toolCallId ? 90 : 0))
                        .foregroundStyle(openToolCallId == t.toolCallId ? DuskColors.accent : DuskColors.ink4)
                }
            }
            .padding(.vertical, Space.sm)
            .padding(.horizontal, Space.md)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
        .background(DuskColors.ink.opacity(0.04))
    }

    private func detail(_ t: TaskSnapshotItem) -> some View {
        Text(t.argsPreview)
            .font(Typo.mono(TypeScale.sm))
            .foregroundStyle(DuskColors.ink2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Space.md)
            .background(DuskColors.accent.opacity(0.10))
    }
}

/// Status dot — queued/default (ink4), running (amber spinner), finished (ok),
/// failed (stop), cancelled (ink3).
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
        case "finished": return DuskColors.ok
        case "failed":   return DuskColors.stop
        case "cancelled": return DuskColors.ink3
        default:          return DuskColors.ink4
        }
    }
}

private enum ToolPillLayout {
    static let dotSize: CGFloat = 6
    static let chevronSize: CGFloat = 10
}
