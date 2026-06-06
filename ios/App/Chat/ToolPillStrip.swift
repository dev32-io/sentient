// ---------------------------------------------------------------------------
// ToolPillStrip — flush pills at the bubble bottom, one per task on the message.
// Mirrors the webui tool-pill-strip.tsx. Tap a pill → expand its argsPreview.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct ToolPillStrip: View {
    let tools: [TaskSnapshotItem]
    @State private var openTaskId: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                ForEach(tools, id: \.taskId) { t in pill(t) }
            }
            if let open = tools.first(where: { $0.taskId == openTaskId }) {
                detail(open)
            }
        }
        .padding(.top, Space.md)
        .padding(.horizontal, -Space.padMsg)
        .padding(.bottom, -Space.padMsg)
    }

    private func pill(_ t: TaskSnapshotItem) -> some View {
        Button {
            openTaskId = (openTaskId == t.taskId) ? nil : t.taskId
        } label: {
            HStack(spacing: Space.sm) {
                StatusDot(status: t.status)
                Text(t.toolName)
                    .font(Typo.mono(TypeScale.sm))
                    .lineLimit(1)
                    .foregroundStyle(DuskColors.ink)
                if !t.argsPreview.isEmpty {
                    Image(systemName: "chevron.right")
                        .font(.system(size: ToolPillLayout.chevronSize))
                        .rotationEffect(.degrees(openTaskId == t.taskId ? 90 : 0))
                        .foregroundStyle(openTaskId == t.taskId ? DuskColors.accent : DuskColors.ink4)
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
