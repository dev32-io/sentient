import SwiftUI
import MobileData

/// Joined shelf for authoritative full-state task activity. It never infers
/// lifetime, associates tasks with bubbles, or couples Stop to task cancellation.
struct TaskShelf: View {
    let items: [TaskListItem]
    var body: some View { ComposerTaskStrip(items: items) }
}

func taskShelfSelection(current: String?, tapped: String) -> String? {
    current == tapped ? nil : tapped
}

struct ComposerTaskStrip: View {
    let items: [TaskListItem]
    @State private var openId: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: Space.xs) {
                if let open = items.first(where: { $0.id == openId }) {
                    Text(open.argsPreview.isEmpty ? "No argument summary" : open.argsPreview)
                        .font(DesignTextRole.telemetry.font)
                        .foregroundStyle(DuskColors.ink2)
                        .textSelection(.enabled)
                        .lineLimit(4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(Space.md)
                        .designWell()
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Space.sm) {
                        ForEach(items, id: \.id) { item in taskButton(item) }
                    }
                    .padding(.vertical, Space.xs)
                }
            }
            .padding(.horizontal, Space.sm)
            .animation(DesignV2.Motion.animation(duration: DesignV2.Motion.state, reduceMotion: reduceMotion), value: openId)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Task activity")
            .accessibilityIdentifier("task-strip")
        }
    }

    private func taskButton(_ item: TaskListItem) -> some View {
        Button { openId = taskShelfSelection(current: openId, tapped: item.id) } label: {
            HStack(spacing: Space.sm) {
                taskStatus(item.status)
                Text(formatToolName(rawName: item.toolName))
                    .font(DesignTextRole.telemetry.font)
                    .lineLimit(1)
                Image(systemName: "chevron.up")
                    .font(.caption2)
                    .rotationEffect(.degrees(openId == item.id ? 180 : 0))
            }
            .frame(minHeight: DesignMetrics.minimumTarget)
            .padding(.horizontal, Space.md)
        }
        .buttonStyle(DesignButtonStyle(role: .quiet))
        .accessibilityLabel("\(formatToolName(rawName: item.toolName)), \(item.status)")
        .accessibilityValue(openId == item.id ? "Expanded" : "Collapsed")
        .accessibilityIdentifier("task-pill-\(item.id)")
    }

    @ViewBuilder private func taskStatus(_ status: String) -> some View {
        if status == "running" {
            ProgressView().controlSize(.mini).tint(DuskColors.amber)
        } else {
            Circle()
                .fill(status == "done" ? DuskColors.ok : status == "error" ? DuskColors.stop : DuskColors.ink4)
                .frame(width: Space.xs, height: Space.xs)
        }
    }
}
