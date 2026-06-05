// MessageMeta — "name · time" row above a bubble (webui .message-bubble__meta).
import SwiftUI
import MobileSdk

struct MessageMeta: View {
    let message: ChatMessage
    let userName: String

    // Shared formatter — the streaming bubble's meta re-renders every typewriter
    // tick, so per-render allocation would churn. One instance for all bubbles.
    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.timeStyle = .short
        f.dateStyle = .none
        return f
    }()

    private var name: String { message.role == "user" ? userName : "Sentient" }
    private var time: String {
        Self.timeFormatter.string(from: Date(timeIntervalSince1970: Double(message.ts) / 1000))
    }
    var body: some View {
        HStack(spacing: Space.sm) {
            Text(name).font(Typo.ui(TypeScale.sm, .semibold)).foregroundStyle(DuskColors.ink)
            Text("·").foregroundStyle(DuskColors.ink4)
            Text(time).font(Typo.ui(TypeScale.xs)).foregroundStyle(DuskColors.ink3)
        }
    }
}
