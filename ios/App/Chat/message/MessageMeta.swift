// MessageMeta — "name · time" row above a bubble (webui .message-bubble__meta).
import SwiftUI
import MobileData

struct MessageMeta: View {
    let name: String
    let timestamp: Int64?
    let hidesTimestamp: Bool
    let muted: Bool

    init(message: ChatMessage, userName: String) {
        self.name = message.role == "user" ? userName : "Sentient"
        self.timestamp = message.ts
        self.hidesTimestamp = message.streaming
        self.muted = false
    }

    init(name: String, timestamp: Int64? = nil, hidesTimestamp: Bool = false, muted: Bool = false) {
        self.name = name
        self.timestamp = timestamp
        self.hidesTimestamp = hidesTimestamp
        self.muted = muted
    }

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
        HStack(spacing: Space.sm) {
            Text(name)
                .font(Typo.ui(TypeScale.sm, muted ? .regular : .semibold))
                .foregroundStyle(muted ? DuskColors.ink3 : DuskColors.ink)
            // Hide the separator + timestamp while a message is still streaming
            // (or when the outbox has no authoritative timestamp). The committed
            // entry carries the real ts.
            if !hidesTimestamp, let time {
                Text("·").foregroundStyle(DuskColors.ink4)
                Text(time)
                    .font(Typo.ui(TypeScale.xs))
                    .foregroundStyle(DuskColors.ink3)
            }
        }
    }
}
