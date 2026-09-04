import Foundation
import MobileData
import SwiftUI

/// Joined shelf for authoritative full-state task activity. It never infers
/// lifetime, associates tasks with bubbles, or couples Stop to task cancellation.
struct TaskShelf: View {
    let items: [TaskListItem]
    var body: some View { ComposerTaskStrip(items: items) }
}

func taskShelfSelection(current: String?, tapped: String) -> String? {
    current == tapped ? nil : tapped
}

/// Authoritative full-state task rows joined to the composer. Disclosure is
/// local presentation state; task lifetime remains owned by `tasklist.state`.
struct ComposerTaskStrip: View {
    let items: [TaskListItem]

    @State private var expandedTaskId: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if !items.isEmpty {
            VStack(spacing: ComposerTaskShelfGeometry.sectionGap) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: ComposerTaskShelfGeometry.pillGap) {
                        ForEach(items, id: \.id) { item in
                            taskButton(item)
                        }
                    }
                }
                .scrollBounceBehavior(.basedOnSize, axes: .horizontal)

                if let selectedTask {
                    taskDetail(selectedTask)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .padding(.horizontal, ComposerTaskShelfGeometry.horizontalPadding)
            .padding(.top, ComposerTaskShelfGeometry.topPadding)
            .padding(.bottom, ComposerTaskShelfGeometry.bottomPadding)
            .background { TaskShelfFace() }
            .animation(
                reduceMotion ? nil : .spring(duration: DesignV2.Motion.state, bounce: 0),
                value: expandedTaskId
            )
            .onChange(of: items.map(\.id)) { _, ids in
                if let expandedTaskId, !ids.contains(expandedTaskId) {
                    self.expandedTaskId = nil
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Task activity")
            .accessibilityIdentifier("task-strip")
        }
    }

    private var selectedTask: TaskListItem? {
        guard let expandedTaskId else { return nil }
        return items.first { $0.id == expandedTaskId }
    }

    private func taskButton(_ item: TaskListItem) -> some View {
        let expanded = expandedTaskId == item.id
        return Button {
            expandedTaskId = taskShelfSelection(current: expandedTaskId, tapped: item.id)
        } label: {
            HStack(spacing: ComposerTaskShelfGeometry.pillContentGap) {
                TaskStatusIndicator(status: item.status)

                Text(formatToolName(rawName: item.toolName))
                    .font(Typo.ui(TypeScale.sm, .regular))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: ComposerTaskShelfGeometry.maximumLabelWidth, alignment: .leading)
            }
            .frame(minHeight: DesignMetrics.minimumTarget)
        }
        .buttonStyle(TaskPillButtonStyle(isExpanded: expanded))
        .accessibilityLabel("\(formatToolName(rawName: item.toolName)), \(taskStatusLabel(item.status))")
        .accessibilityValue(expanded ? "Expanded" : "Collapsed")
        .accessibilityHint(expanded ? "Collapses task details" : "Expands task details")
        .accessibilityIdentifier("task-pill-\(item.id)")
    }

    private func taskDetail(_ item: TaskListItem) -> some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Text("TASK DETAILS")
                .font(Typo.mono(TypeScale.xs))
                .fontWeight(.medium)
                .tracking(0.8)
                .foregroundStyle(DuskColors.ink3)

            Text(item.argsPreview.isEmpty ? "No argument summary" : item.argsPreview)
                .font(Typo.mono(TypeScale.sm))
                .foregroundStyle(DuskColors.ink2)
                .lineLimit(4)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(ComposerTaskShelfGeometry.detailPadding)
        .background {
            RoundedRectangle(cornerRadius: ComposerTaskShelfGeometry.detailRadius, style: .continuous)
                .fill(DuskColors.accentSoft.opacity(0.38))
                .overlay {
                    RoundedRectangle(cornerRadius: ComposerTaskShelfGeometry.detailRadius, style: .continuous)
                        .stroke(DuskColors.lineSoft, lineWidth: DesignMetrics.hairline)
                }
        }
        .accessibilityElement(children: .combine)
    }

    private func taskStatusLabel(_ status: String) -> String {
        switch status.lowercased() {
        case "running": return "Running"
        case "done", "completed", "success": return "Completed"
        case "error", "failed": return "Failed"
        case "approval", "permission", "blocked": return "Needs review"
        default: return status
        }
    }
}

enum ComposerTaskShelfGeometry {
    static let horizontalPadding: CGFloat = 5
    static let topPadding: CGFloat = 7
    static let bottomPadding: CGFloat = 8
    static let sectionGap: CGFloat = 6
    static let pillGap: CGFloat = 4
    static let pillContentGap: CGFloat = 9
    static let maximumLabelWidth: CGFloat = 164
    static let detailPadding: CGFloat = 12
    static let detailRadius: CGFloat = 10
    static let shelfRadius: CGFloat = 14
    static let pulseDiameter: CGFloat = 8

    static let shelfShadow = DesignDropShadowGeometry(
        radius: 18, y: -8, sourceInset: 16
    )
}

private struct TaskShelfFace: View {
    @Environment(\.colorSchemeContrast) private var contrast

    private var shape: UnevenRoundedRectangle {
        UnevenRoundedRectangle(
            topLeadingRadius: ComposerTaskShelfGeometry.shelfRadius,
            bottomLeadingRadius: 0,
            bottomTrailingRadius: 0,
            topTrailingRadius: ComposerTaskShelfGeometry.shelfRadius,
            style: .continuous
        )
    }

    var body: some View {
        ZStack {
            DesignSpreadShadow(
                shape: shape,
                color: Color.black.opacity(0.82),
                geometry: ComposerTaskShelfGeometry.shelfShadow
            )
            shape.fill(DuskColors.bgSunk.overlaying(DuskColors.paper, opacity: 0.14))
            shape.fill(
                LinearGradient(
                    colors: [DuskColors.ink.opacity(0.035), Color.clear],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
            shape.stroke(
                contrast == .increased ? DuskColors.ink3 : DuskColors.lineSoft,
                lineWidth: DesignMetrics.hairline
            )
            DesignTopEdgeLight(shape: shape, color: DuskColors.ink.opacity(0.1))
        }
        .accessibilityHidden(true)
    }
}

private struct TaskPillButtonStyle: ButtonStyle {
    let isExpanded: Bool

    @Environment(\.isFocused) private var isFocused
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
    }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(isExpanded ? DuskColors.ink : DuskColors.ink2)
            .padding(
                .horizontal,
                horizontalSizeClass == .regular ? 12 : 10
            )
            .background {
                ZStack {
                    if isExpanded || configuration.isPressed {
                        designSlateFace(
                            role: .secondary,
                            muted: false,
                            hovered: false,
                            baseOverride: isExpanded
                                ? DuskColors.paper.overlaying(DuskColors.accentSoft, opacity: 0.26)
                                : DuskColors.paper.overlaying(
                                    DuskColors.bgSunk,
                                    opacity: configuration.isPressed ? 0.18 : 0
                                )
                        )
                        .clipShape(shape)
                    }
                    shape.stroke(
                        isExpanded ? DuskColors.accent.opacity(0.38) : Color.clear,
                        lineWidth: DesignMetrics.hairline
                    )
                    if isFocused {
                        ComposerMaterialFocusRing(shape: shape)
                    }
                }
            }
            .contentShape(shape)
            .offset(y: configuration.isPressed && !reduceMotion ? 1 : 0)
            .animation(
                reduceMotion ? nil : .easeOut(duration: DesignV2.Motion.feedback),
                value: configuration.isPressed
            )
    }
}

private struct TaskStatusIndicator: View {
    let status: String

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 24, paused: reduceMotion || !isRunning)) { timeline in
            let phase = reduceMotion
                ? 0.0
                : (sin(timeline.date.timeIntervalSinceReferenceDate * 4.5) + 1) / 2
            ZStack {
                if isRunning {
                    Circle()
                        .fill(DuskColors.amber)
                        .opacity(reduceMotion ? 1 : 0.58 + phase * 0.42)
                        .scaleEffect(reduceMotion ? 1 : 0.76 + phase * 0.24)
                        .shadow(color: DuskColors.amber.opacity(0.45), radius: 4)
                } else {
                    Circle().fill(statusColor)
                }
            }
            .frame(
                width: ComposerTaskShelfGeometry.pulseDiameter,
                height: ComposerTaskShelfGeometry.pulseDiameter
            )
        }
        .accessibilityHidden(true)
    }

    private var isRunning: Bool { status.lowercased() == "running" }

    private var statusColor: Color {
        switch status.lowercased() {
        case "done", "completed", "success": return DuskColors.sage
        case "error", "failed": return DuskColors.stop
        case "approval", "permission", "blocked": return DuskColors.accent
        default: return DuskColors.ink4
        }
    }
}
