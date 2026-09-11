// ---------------------------------------------------------------------------
// CenteredFlowLayout — a wrapping flow that centers each row, mirroring the
// webui `.login-screen__grid` (display:flex; flex-wrap:wrap; justify-content:
// center; gap). SwiftUI's LazyVGrid fills the proposed width and packs items
// leading, so a partial row hugs the left edge — the iOS analog of Android's
// `wrapContentSize()` block-centering does not exist. This Layout fixes that:
// items flow in logical order at their natural size, wrap when the row would exceed
// the proposed width, and each row is horizontally centered within the bounds.
//
// Uniform `spacing` separates items within a row AND rows from each other,
// matching the webui grid `gap`. Pure geometry — no state, no I/O, no logger.
// ---------------------------------------------------------------------------
import SwiftUI

struct CenteredFlowLayout: Layout {
    /// Gap between items in a row and between rows (webui grid `gap`).
    var spacing: CGFloat
    var alignment: HorizontalAlignment = .center

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Void) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        let rows = rows(maxWidth: maxWidth, subviews: subviews)
        let height = rows.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(0, rows.count - 1))
        let width = proposal.width ?? (rows.map(\.width).max() ?? 0)
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Void) {
        var y = bounds.minY
        for row in rows(maxWidth: bounds.width, subviews: subviews) {
            let inset: CGFloat
            if alignment == .leading { inset = 0 }
            else if alignment == .trailing { inset = bounds.width - row.width }
            else { inset = (bounds.width - row.width) / 2 }
            var consumed: CGFloat = 0
            for index in row.indices {
                let size = measuredSize(subviews[index], maxWidth: bounds.width)
                // SwiftUI mirrors Layout placements in RTL; use logical x once.
                let x = bounds.minX + inset + consumed
                subviews[index].place(at: CGPoint(x: x, y: y), anchor: .topLeading, proposal: ProposedViewSize(size))
                consumed += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    /// Preserve intrinsic chip widths while allowing one long localized label
    /// to wrap within the available row rather than overflowing its container.
    private func measuredSize(_ subview: LayoutSubview, maxWidth: CGFloat) -> CGSize {
        let natural = subview.sizeThatFits(.unspecified)
        guard maxWidth.isFinite, natural.width > maxWidth else { return natural }
        return subview.sizeThatFits(ProposedViewSize(width: max(0, maxWidth), height: nil))
    }

    // ── Row packing ───────────────────────────────────────────────────────────

    private struct Row {
        var indices: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    /// Greedily pack subviews into rows that fit within `maxWidth`.
    private func rows(maxWidth: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = []
        var current = Row()
        for index in subviews.indices {
            let size = measuredSize(subviews[index], maxWidth: maxWidth)
            let projected = current.indices.isEmpty ? size.width : current.width + spacing + size.width
            if projected > maxWidth && !current.indices.isEmpty {
                rows.append(current)
                current = Row()
            }
            current.width += current.indices.isEmpty ? size.width : spacing + size.width
            current.height = max(current.height, size.height)
            current.indices.append(index)
        }
        if !current.indices.isEmpty { rows.append(current) }
        return rows
    }
}
