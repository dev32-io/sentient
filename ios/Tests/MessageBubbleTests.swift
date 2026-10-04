import CoreGraphics
import SwiftUI
import Testing
import UIKit
@testable import SentientApp

struct MessageBubbleTests {
    @Test func cutoffCopyKeepsInterruptAndBargeInDistinct() {
        #expect(messageCutoffLabel(for: "interrupt") == "interrupted")
        #expect(messageCutoffLabel(for: "barge-in") == "barge-in")
    }

    @Test func unknownCutoffDoesNotCreateAnErrorMarker() {
        #expect(messageCutoffLabel(for: nil) == nil)
        #expect(messageCutoffLabel(for: "server-error") == nil)
    }

    @Test func activeGlowOverflowUsesRenderedBlurAndOffset() {
        #expect(DesignCanvasEffects.overflow(blur: 31, y: 19) == 67)
        #expect(DesignCanvasEffects.overflow(blur: 24, y: 15) == 52)
    }

    @MainActor
    @Test func pulseUsesScaledBodyLineHeightInsideExistingBubbleSpacing() {
        func pulseHeight(
            dynamicType: DynamicTypeSize,
            contentSize: UIContentSizeCategory
        ) -> CGFloat {
            let host = UIHostingController(
                rootView: PulseDots().environment(\.dynamicTypeSize, dynamicType)
            )
            host.traitOverrides.preferredContentSizeCategory = contentSize
            return host.sizeThatFits(in: CGSize(width: 280, height: 500)).height
        }

        let bubble = MessageBubbleShell(
            role: .assistant,
            name: "Sentient",
            timestamp: nil,
            isStreaming: true,
            cutoffLabel: nil,
            index: 0,
            total: 1,
            avatarMode: .idle
        ) {
            PulseDots()
        }
        .environment(\.bubbleMaxWidth, 280)
        .environment(\.sentientIdentityMeasurement, true)
        .environment(\.dynamicTypeSize, .large)

        let bubbleHost = UIHostingController(rootView: bubble)
        bubbleHost.traitOverrides.preferredContentSizeCategory = .large
        let bubbleHeight = bubbleHost.sizeThatFits(in: CGSize(width: 280, height: 500)).height
        let normalBodyHeight = pulseHeight(dynamicType: .large, contentSize: .large)
        let largerBodyHeight = pulseHeight(
            dynamicType: .accessibility3,
            contentSize: .accessibilityExtraLarge
        )

        #expect(normalBodyHeight == 23.333333333333332)
        #expect(largerBodyHeight == 50.666666666666664)
        #expect(bubbleHeight == normalBodyHeight + Space.md * 2)
    }
}
