// DayDivider — "Today · 7:42 AM" with hairline rules either side (webui .day-divider).
import SwiftUI

struct DayDivider: View {
    let label: String
    var body: some View {
        HStack(spacing: Space.md) {
            line
            Text(label)
                .font(Typo.mono(TypeScale.sm))
                .foregroundStyle(DuskColors.ink2)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .layoutPriority(1)
            line
        }
        .padding(.vertical, Space.xs)
    }
    private var line: some View {
        Rectangle().fill(DuskColors.lineSoft).frame(height: 1)
    }
}
