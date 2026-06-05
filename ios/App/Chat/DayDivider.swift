// DayDivider — "Today · 7:42 AM" with hairline rules either side (webui .day-divider).
import SwiftUI

struct DayDivider: View {
    let label: String
    var body: some View {
        HStack(spacing: Space.md) {
            line
            Text(label.uppercased())
                .font(Typo.ui(TypeScale.xs, .medium)).tracking(1)
                .foregroundStyle(DuskColors.ink3)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .minimumScaleFactor(0.8)
            line
        }
        .padding(.vertical, Space.xs)
    }
    private var line: some View {
        Rectangle().fill(DuskColors.lineSoft).frame(height: 1)
    }
}
