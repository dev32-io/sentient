// Authoritative timestamp above the role-aligned bubble. Speaker stays semantic.
import SwiftUI

struct MessageMeta: View {
    let timestamp: Int64?

    // Shared formatter — the streaming bubble's meta re-renders every reveal
    // tick, so per-render allocation would churn. One instance for all bubbles.
    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.timeStyle = .short
        f.dateStyle = .none
        return f
    }()

    private var time: String? {
        guard let timestamp else { return nil }
        return Self.timeFormatter.string(from: Date(timeIntervalSince1970: Double(timestamp) / 1000))
    }

    var body: some View {
        if let time {
            Text(time)
                .font(Typo.mono(TypeScale.sm))
                .foregroundStyle(DuskColors.ink3)
        }
    }
}
