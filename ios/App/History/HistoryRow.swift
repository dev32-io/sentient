// ---------------------------------------------------------------------------
// HistoryRow — one session row in the History sheet. Mirrors the Android
// history/HistoryRow.kt + the webui session-row.tsx semantics:
//   - tap the row body → switch to that session
//   - context menu (long-press) → Rename / Delete
// The active session highlights via SessionRow.isActive (gateway-sourced):
// accent-tinted fill + accent semibold title, matching the Android row.
//
// Stateless leaf: takes the row + now-clock + action closures; never touches a
// ViewModel (swiftui state-hoisting rule). accessibilityIdentifier
// `history-row-<sessionId>` on the row so the e2e driver targets a specific
// session.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

private let rowTagPrefix = "history-row-"

struct HistoryRow: View {
    let row: SessionRow
    let nowMs: Int64
    let isSelected: Bool
    let onSwitch: () -> Void
    let onAskRename: () -> Void
    let onAskDelete: () -> Void

    private var active: Bool { row.isActive || isSelected }
    private var titleColor: Color { active ? DuskColors.accent : DuskColors.ink }

    // Relative time only. The message-count suffix was dropped: the gateway
    // session list does not populate a count (always 0 → a misleading "no
    // messages" on every row), so the suffix was pure noise.
    private var secondaryLine: String {
        RelativeTime.relative(nowMs: nowMs, lastActiveMs: row.lastActiveAt)
    }

    var body: some View {
        Button(action: onSwitch) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(row.title)
                    .font(.system(size: TypeScale.base, weight: active ? .semibold : .regular))
                    .foregroundStyle(titleColor)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text(secondaryLine)
                    .font(.system(size: TypeScale.xs))
                    .foregroundStyle(DuskColors.ink3)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Space.md)
            .padding(.vertical, Space.md)
            .background {
                if active { HistorySelectedRowCanvas() }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("\(rowTagPrefix)\(row.sessionId)")
        .accessibilityAddTraits(active ? .isSelected : [])
        .contextMenu {
            Button("Rename", action: onAskRename)
            Button("Delete", role: .destructive, action: onAskDelete)
        }
    }
}

/// Session selection is product-owned rather than a generic selectable-card
/// treatment. Canvas preserves the established accent-tinted history receiver
/// without introducing another stacked face or changing the native row target.
private struct HistorySelectedRowCanvas: View {
    var body: some View {
        Canvas { context, size in
            let shape = RoundedRectangle(cornerRadius: Radii.md)
            context.fill(
                shape.path(in: CGRect(origin: .zero, size: size)),
                with: .color(DuskColors.accent50)
            )
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
