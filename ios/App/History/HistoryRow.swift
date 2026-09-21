import SwiftUI

private let rowTagPrefix = "history-row-"

struct HistoryRow: View {
    let row: HistoryEntry
    let nowMs: Int64
    let isSelected: Bool
    let onSwitch: () -> Void
    let onAskRename: () -> Void
    let onAskDelete: () -> Void
    let onAskDiscard: () -> Void

    private var titleColor: Color { isSelected ? DuskColors.accent : DuskColors.ink }
    private var secondaryLine: String {
        let time = RelativeTime.relative(nowMs: nowMs, lastActiveMs: row.lastActiveAt)
        return row.hasDraft ? "Draft · \(time)" : time
    }

    var body: some View {
        Button(action: onSwitch) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(row.title)
                    .font(.system(size: TypeScale.base, weight: isSelected ? .semibold : .regular))
                    .foregroundStyle(titleColor)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text(secondaryLine)
                    .font(.system(size: TypeScale.xs))
                    .foregroundStyle(DuskColors.ink3)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Space.md)
            .padding(.vertical, Space.md)
            .background { if isSelected { HistorySelectedRowCanvas() } }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("\(rowTagPrefix)\(row.id)")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .contextMenu {
            if !row.isLocalDraft { Button("Rename", action: onAskRename) }
            if row.sessionId != nil {
                Button("Delete conversation", role: .destructive, action: onAskDelete)
            }
            if row.draftId != nil {
                Button("Discard draft", role: .destructive, action: onAskDiscard)
            }
        }
    }
}

private struct HistorySelectedRowCanvas: View {
    var body: some View {
        Canvas(rendersAsynchronously: true) { context, size in
            context.fill(
                RoundedRectangle(cornerRadius: Radii.md).path(in: CGRect(origin: .zero, size: size)),
                with: .color(DuskColors.accent50)
            )
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
