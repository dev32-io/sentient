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

    @Test func sweptContourContainsIdentityPaddingAndBodyOnBothSides() {
        let rect = CGRect(x: 0, y: 0, width: 280, height: 140)
        let assistant = SweptBubbleShape(
            identityWidth: 120, identityHeight: 40, sweepsFromTrailing: false
        ).path(in: rect)
        let user = SweptBubbleShape(
            identityWidth: 120, identityHeight: 40, sweepsFromTrailing: true
        ).path(in: rect)

        #expect(assistant.contains(CGPoint(x: 12, y: 39)))
        #expect(user.contains(CGPoint(x: 268, y: 39)))
        #expect(assistant.contains(CGPoint(x: rect.midX, y: 100)))
        #expect(user.contains(CGPoint(x: rect.midX, y: 100)))
        #expect(assistant.boundingRect == rect)
        #expect(user.boundingRect == rect)
    }

    @Test func insetShadowKeepsWholeSweptContourForLargeAndOverInsetBubbles() {
        let shape = SweptBubbleShape(
            identityWidth: 120, identityHeight: 46, sweepsFromTrailing: false
        )
        let large = shape.path(in: CGRect(x: 0, y: 0, width: 280, height: 100), inset: 18)

        #expect(large.boundingRect == CGRect(x: 18, y: 18, width: 244, height: 64))
        #expect(!large.contains(CGPoint(x: 220, y: 30)))
        #expect(large.contains(CGPoint(x: 220, y: 50)))

        let shortRect = CGRect(x: 4, y: 7, width: 80, height: 30)
        let short = SweptBubbleShape(
            identityWidth: 10, identityHeight: 20, sweepsFromTrailing: false
        ).path(in: shortRect, inset: 18)
        #expect(!short.isEmpty)
        #expect(short.boundingRect == CGRect(x: 18.5, y: 21.5, width: 51, height: 1))
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
            continuation: false,
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
        #expect(bubbleHeight == 46 + 8 + normalBodyHeight + 12)
    }
}
