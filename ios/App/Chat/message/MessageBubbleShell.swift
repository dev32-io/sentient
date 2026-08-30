// ---------------------------------------------------------------------------
// MessageBubbleShell — the shared message row and bubble surface.
//
// Role-specific message views supply only content and (for outbox rows) a
// footer. Alignment, avatar placement, metadata, width, material, shape, and
// accessibility stay here so committed and pending user bubbles cannot drift
// apart.
// ---------------------------------------------------------------------------
import SwiftUI

/// The only role decision the shared shell needs. Unknown gateway roles retain
/// the existing assistant-side rendering path at the call site.
enum MessageBubbleRole {
    case user
    case assistant

    var isUser: Bool {
        self == .user
    }
}

struct MessageBubbleShell<Content: View, Footer: View>: View {
    let role: MessageBubbleRole
    let name: String
    let timestamp: Int64?
    let isStreaming: Bool
    let cutoffLabel: String?
    let index: Int
    let total: Int
    let continuation: Bool
    let avatarMode: SentientIdentityState
    let accessibilityIdentifier: String?
    let metadataMuted: Bool
    let hasInteractiveFooter: Bool
    @ViewBuilder let content: () -> Content
    @ViewBuilder let footer: () -> Footer

    @Environment(\.bubbleMaxWidth) private var bubbleMaxWidth

    init(
        role: MessageBubbleRole,
        name: String,
        timestamp: Int64?,
        isStreaming: Bool,
        cutoffLabel: String?,
        index: Int,
        total: Int,
        continuation: Bool,
        avatarMode: SentientIdentityState,
        accessibilityIdentifier: String? = nil,
        metadataMuted: Bool = false,
        @ViewBuilder content: @escaping () -> Content
    ) where Footer == EmptyView {
        self.role = role
        self.name = name
        self.timestamp = timestamp
        self.isStreaming = isStreaming
        self.cutoffLabel = cutoffLabel
        self.index = index
        self.total = total
        self.continuation = continuation
        self.avatarMode = avatarMode
        self.accessibilityIdentifier = accessibilityIdentifier
        self.metadataMuted = metadataMuted
        self.hasInteractiveFooter = false
        self.content = content
        self.footer = { EmptyView() }
    }

    init(
        role: MessageBubbleRole,
        name: String,
        timestamp: Int64?,
        isStreaming: Bool,
        cutoffLabel: String?,
        index: Int,
        total: Int,
        continuation: Bool,
        avatarMode: SentientIdentityState,
        accessibilityIdentifier: String? = nil,
        metadataMuted: Bool = false,
        @ViewBuilder content: @escaping () -> Content,
        @ViewBuilder footer: @escaping () -> Footer
    ) {
        self.role = role
        self.name = name
        self.timestamp = timestamp
        self.isStreaming = isStreaming
        self.cutoffLabel = cutoffLabel
        self.index = index
        self.total = total
        self.continuation = continuation
        self.avatarMode = avatarMode
        self.accessibilityIdentifier = accessibilityIdentifier
        self.metadataMuted = metadataMuted
        self.hasInteractiveFooter = true
        self.content = content
        self.footer = footer
    }

    var body: some View {
        if let accessibilityIdentifier {
            accessibleRow.accessibilityIdentifier(accessibilityIdentifier)
        } else {
            accessibleRow
        }
    }

    private var accessibleRow: some View {
        row
            // A retry footer must remain a separate actionable accessibility
            // element. Committed bubbles have no interactive footer and keep
            // their established single chronology element.
            .accessibilityElement(children: hasInteractiveFooter ? .contain : .combine)
            .accessibilityLabel(accessibilityChronology)
    }

    private var row: some View {
        HStack(alignment: .top, spacing: 0) {
            if role.isUser {
                Spacer(minLength: BubbleLayout.edgeMin)
                VStack(alignment: .trailing, spacing: Space.xs) {
                    if !continuation {
                        MessageMeta(name: name, timestamp: timestamp, hidesTimestamp: isStreaming, muted: metadataMuted)
                    }
                    bubbleBody
                    footer()
                }
                avatarColumn
            } else {
                avatarColumn
                VStack(alignment: .leading, spacing: Space.xs) {
                    if !continuation {
                        MessageMeta(name: name, timestamp: timestamp, hidesTimestamp: isStreaming, muted: metadataMuted)
                    }
                    bubbleBody
                    footer()
                }
                Spacer(minLength: BubbleLayout.edgeMin)
            }
        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private var avatarColumn: some View {
        if continuation {
            Color.clear
                .frame(width: BubbleLayout.avatarSize + Space.md, height: 1)
                .accessibilityHidden(true)
        } else if role.isUser {
            UserAvatar(name: name, size: BubbleLayout.avatarSize)
                .padding(.leading, Space.md)
                .accessibilityHidden(true)
        } else {
            SentientMark(size: BubbleLayout.avatarSize, mode: avatarMode)
                .padding(.trailing, Space.md)
                .accessibilityHidden(true)
        }
    }

    private var bubbleBody: some View {
        content()
            .padding(Space.padMsg)
            .frame(maxWidth: bubbleMaxWidth, alignment: .leading)
            .background {
                ZStack {
                    role.isUser ? BubbleLayout.userBg : DuskColors.paper
                    // Keep the speaking presentation above the opaque material
                    // and below content; the shell clips it to the bubble shape.
                    if !role.isUser && avatarMode == .responding {
                        BubbleSpeakingWave()
                    }
                }
            }
            .clipShape(bubbleShape)
            .overlay(bubbleShape.stroke(DuskColors.lineSoft, lineWidth: 1))
            .fixedSize(horizontal: false, vertical: true)
    }

    private var accessibilityChronology: String {
        let position = "Message \(index + 1) of \(max(total, index + 1)) from \(name)"
        if isStreaming {
            return "\(position), responding"
        }
        if let timestamp {
            let time = Date(timeIntervalSince1970: Double(timestamp) / 1000)
                .formatted(date: .omitted, time: .shortened)
            return "\(position) at \(time)\(cutoffLabel.map { ", \($0)" } ?? "")"
        }
        return "\(position), pending"
    }

    /// Flush the corner nearest the sender while retaining the central radius
    /// tokens used by the committed and pending user surfaces.
    private var bubbleShape: UnevenRoundedRectangle {
        let r = Radii.lg
        let flush = BubbleLayout.flushCorner
        if role.isUser {
            return UnevenRoundedRectangle(
                topLeadingRadius: r, bottomLeadingRadius: r,
                bottomTrailingRadius: r, topTrailingRadius: flush
            )
        }
        return UnevenRoundedRectangle(
            topLeadingRadius: flush, bottomLeadingRadius: r,
            bottomTrailingRadius: r, topTrailingRadius: r
        )
    }
}

/// Shared chat geometry. Values continue to project the existing central
/// design/KMP tokens; this type only names message-specific composition.
enum BubbleLayout {
    static let standardOffset: CGFloat = .zero
    static let continuationPullup = -Space.lg
    static let flushCorner: CGFloat = 6
    static let avatarSize: CGFloat = DesignMetrics.minimumTarget
    static let edgeMin: CGFloat = 12
    static let pulseDot: CGFloat = 6
    static let pulseGap: CGFloat = 4
    static let pulseStagger: Double = 0.18
    static let userBg = DuskColors.userBubble
}
