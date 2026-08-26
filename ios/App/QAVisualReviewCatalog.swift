#if DEBUG
import SwiftUI

struct QAVisualReviewCatalog: View {
    private let pageSize = 3
    private var page: Int {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: "--qa-visual-page"), args.indices.contains(index + 1) else { return 0 }
        return max(0, Int(args[index + 1]) ?? 0)
    }
    private var config: String {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: "--qa-visual-config"), args.indices.contains(index + 1) else { return "ios-iphone-standard" }
        return args[index + 1]
    }
    private var rows: ArraySlice<QAVisualReviewRow> {
        let start = min(page * pageSize, qaVisualReviewRows.count)
        let end = min(start + pageSize, qaVisualReviewRows.count)
        return qaVisualReviewRows[start..<end]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            HStack {
                Text("Design refresh · iOS").font(Typo.display(TypeScale.lg))
                Spacer()
                Text("\(config) · \(page + 1)").font(Typo.ui(TypeScale.sm)).foregroundStyle(DuskColors.ink2)
            }
            ForEach(Array(rows), id: \.id) { row in
                QAVisualReviewSpecimen(row: row)
            }
            Spacer(minLength: 0)
        }
        .padding(Space.md)
        .background(DuskColors.bg.ignoresSafeArea())
        .transaction { transaction in
            if config == "ios-reduced-motion" { transaction.disablesAnimations = true }
        }
        .accessibilityIdentifier("qa-visual-review-page-\(page)")
    }
}

private struct QAVisualReviewSpecimen: View {
    let row: QAVisualReviewRow
    @State private var text = "Fixture value"

    private var kind: DesignNoticeKind {
        let value = row.state.lowercased()
        if value.range(of: "loading|saving|applying|submitting|installing|checking|running|thinking|transitioning", options: .regularExpression) != nil { return .loading }
        if value.range(of: "empty|no sessions|no match", options: .regularExpression) != nil { return .empty }
        if value.range(of: "error|failed|denied|conflict|unavailable|offline|stale", options: .regularExpression) != nil { return .error }
        if value.range(of: "success|saved|applied|sent", options: .regularExpression) != nil { return .success }
        return .warning
    }

    var body: some View {
        HStack(alignment: .center, spacing: Space.md) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(row.id).font(Typo.mono(TypeScale.xs)).foregroundStyle(DuskColors.accent)
                    .lineLimit(2)
                Text(row.state).font(Typo.ui(TypeScale.sm)).foregroundStyle(DuskColors.ink2)
                    .lineLimit(2)
            }
            .frame(maxWidth: 150, alignment: .leading)
            if kind == .loading || kind == .empty || kind == .error {
                AsyncNotice(kind: kind, title: "Synthetic \(kind == .error ? "error" : kind == .empty ? "empty" : "loading") state", detail: row.state, retry: kind == .error ? {} : nil)
            } else {
                VStack(spacing: Space.xs) {
                    DesignField(title: "Synthetic field", text: $text, accessibilityId: "qa-field-\(row.id)")
                    DesignActionButton(title: "Review action", state: row.state.lowercased().contains("disabled") ? .disabled : .normal, accessibilityId: "qa-action-\(row.id)", action: {})
                }
            }
        }
        .padding(Space.sm)
        .frame(maxWidth: .infinity, minHeight: 118, alignment: .leading)
        .designPlate()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("qa-row-\(row.id)")
    }
}
#endif
