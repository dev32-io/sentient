import CoreGraphics
import SwiftUI
import Testing
import UIKit
@testable import SentientApp

struct VoiceCaptureControlTests {
    @Test func pressStartsHoldImmediately() {
        let result = VoiceCaptureReducer.begin(from: .idle)
        #expect(result == VoiceCaptureTransition(state: .hold, intents: [.holdStart]))
    }

    @Test func confirmedNormalHeldReleaseSendsExactlyOnce() {
        let release = VoiceCaptureReducer.terminatePhysicalHold(
            from: .hold,
            target: .send,
            elapsed: 0.5,
            maximumTravel: 0,
            termination: .released
        )
        let lateRelease = VoiceCaptureReducer.terminatePhysicalHold(
            from: release.state,
            target: .send,
            elapsed: 0.6,
            maximumTravel: 0,
            termination: .released
        )

        #expect(release.intents + lateRelease.intents == [.sendHeld])
    }

    @Test func heldSystemCancellationCancelsExactlyOnceAndNeverSends() {
        let cancellation = VoiceCaptureReducer.terminatePhysicalHold(
            from: .hold,
            target: .send,
            elapsed: 0.5,
            maximumTravel: 0,
            termination: .cancelled
        )
        let lateRelease = VoiceCaptureReducer.terminatePhysicalHold(
            from: cancellation.state,
            target: .send,
            elapsed: 0.6,
            maximumTravel: 0,
            termination: .released
        )
        let intents = cancellation.intents + lateRelease.intents

        #expect(intents == [.cancelHeld])
        #expect(!intents.contains(.sendHeld))
    }

    @Test func heldLifecycleInterruptionCancelsExactlyOnceAndNeverEnds() {
        let interruption = VoiceCaptureReducer.interrupt(from: .hold)
        let repeatedInterruption = VoiceCaptureReducer.interrupt(from: interruption.state)
        let lateRelease = VoiceCaptureReducer.terminatePhysicalHold(
            from: interruption.state,
            target: .send,
            elapsed: 0.5,
            maximumTravel: 0,
            termination: .released
        )
        let intents = interruption.intents + repeatedInterruption.intents + lateRelease.intents

        #expect(intents == [.lifecycleCancel])
        #expect(!intents.contains(.sendHeld))
    }

    @Test func explicitCancelDiscards() {
        let result = VoiceCaptureReducer.release(
            from: .hold,
            target: .cancel,
            elapsed: 0.5,
            maximumTravel: 40
        )
        #expect(result.intents == [.cancelHeld])
    }

    @Test func quickAutoRequiresBothStrictTimeAndTravelThresholds() {
        let quickTap = VoiceCaptureReducer.release(
            from: .hold,
            target: .send,
            elapsed: VoiceCaptureReducer.quickAutoThreshold - 0.001,
            maximumTravel: VoiceCaptureReducer.quickAutoTravelThreshold - 0.001
        )
        let atTimeThreshold = VoiceCaptureReducer.release(
            from: .hold,
            target: .send,
            elapsed: VoiceCaptureReducer.quickAutoThreshold,
            maximumTravel: 0
        )
        let atTravelThreshold = VoiceCaptureReducer.release(
            from: .hold,
            target: .send,
            elapsed: 0.1,
            maximumTravel: VoiceCaptureReducer.quickAutoTravelThreshold
        )

        #expect(quickTap.intents == [.enterAuto])
        #expect(atTimeThreshold.intents == [.sendHeld])
        #expect(atTravelThreshold.intents == [.sendHeld])
    }

    @Test func maximumTravelPersistsWhenFingerReturnsToOrigin() {
        var progress = VoiceCaptureGestureProgress()
        progress.begin(at: CGPoint(x: 40, y: 30))
        progress.update(at: CGPoint(x: 60, y: 30))
        progress.update(at: CGPoint(x: 41, y: 30))

        #expect(progress.origin == CGPoint(x: 40, y: 30))
        #expect(progress.maximumTravel == 20)

        progress.reset()
        #expect(progress.origin == nil)
        #expect(progress.maximumTravel == 0)
    }

    @Test func deliberateAutoTargetWinsOverElapsedTime() {
        let result = VoiceCaptureReducer.release(
            from: .hold,
            target: .auto,
            elapsed: 1,
            maximumTravel: 80
        )
        #expect(result.intents == [.enterAuto])
    }

    @Test func assistiveActivationUsesSemanticIntentSequence() {
        #expect(VoiceCaptureReducer.activate(from: .idle).intents == [.holdStart, .enterAuto])
        #expect(VoiceCaptureReducer.activate(from: .auto).intents == [.exitAuto])
    }

    @Test func autoRemainsOperableWithTypedDraftUntilExplicitExit() {
        let idleWithDraft = ComposerActionState(draftPresent: true, talkMode: .idle)
        let beforeTyping = ComposerActionState(draftPresent: false, talkMode: .continuous)
        let afterTyping = ComposerActionState(draftPresent: true, talkMode: .continuous)

        #expect(!idleWithDraft.showsVoiceCapture)
        #expect(beforeTyping.showsVoiceCapture)
        #expect(afterTyping.showsVoiceCapture)
        #expect(afterTyping.showsSend)
        #expect(VoiceCaptureReducer.authority(.continuous, disabled: false) == .auto)
        #expect(VoiceCaptureReducer.activate(from: .auto).intents == [.exitAuto])
    }

    @Test func staleTerminalOutsideHoldIsNoOp() {
        #expect(VoiceCaptureReducer.release(
            from: .auto,
            target: .cancel,
            elapsed: 1,
            maximumTravel: 0
        ).intents.isEmpty)
        #expect(VoiceCaptureReducer.release(
            from: .idle,
            target: .send,
            elapsed: 1,
            maximumTravel: 0
        ).intents.isEmpty)
    }

    @Test func autoSystemInterruptionExitsWithoutASecondTerminal() {
        let interruption = VoiceCaptureReducer.interrupt(from: .auto)
        let repeated = VoiceCaptureReducer.interrupt(from: interruption.state)

        #expect(interruption == VoiceCaptureTransition(state: .idle, intents: [.lifecycleCancel]))
        #expect(repeated.intents.isEmpty)
    }

    @Test func hostedVisualAndTargetGeometryAlignInAllDynamicTypeAndDirectionCases() {
        let cases: [(dynamicType: DynamicTypeSize, rightToLeft: Bool, relativeCrown: CGRect)] = [
            (.large, false, CGRect(x: -12, y: -50, width: 210, height: 58)),
            (.large, true, CGRect(x: 0, y: -50, width: 210, height: 58)),
            (.accessibility3, false, CGRect(x: 0, y: -64, width: 276, height: 72)),
            (.accessibility3, true, CGRect(x: 0, y: -64, width: 276, height: 72)),
        ]

        for item in cases {
            let pod = CGSize(
                width: VoiceCaptureLayout.liveWidth(
                    horizontalSizeClass: .compact,
                    dynamicTypeSize: item.dynamicType
                ),
                height: VoiceCaptureLayout.liveHeight(horizontalSizeClass: .compact)
            )
            let crown = CGSize(
                width: VoiceCaptureLayout.crownWidth(
                    horizontalSizeClass: .compact,
                    dynamicTypeSize: item.dynamicType
                ),
                height: VoiceCaptureLayout.crownHeight(item.dynamicType)
            )
            let host = VoiceCaptureGestureHostGeometry(
                idleSize: VoiceCaptureLayout.idleSize(horizontalSizeClass: .compact),
                podSize: pod,
                crownSize: crown,
                seamOverlap: VoiceCaptureLayout.seamOverlap,
                rightToLeft: item.rightToLeft
            )
            let crownRelativeToPod = host.crownBounds.offsetBy(
                dx: -host.podBounds.minX,
                dy: -host.podBounds.minY
            )
            let visuallyRenderedCrownTop = pod.height - crown.height
                + host.crownBottomAlignmentOffset

            #expect(crownRelativeToPod == item.relativeCrown)
            #expect(visuallyRenderedCrownTop == item.relativeCrown.minY)
            #expect(
                host.crownBottomAlignmentOffset
                    == -(pod.height - VoiceCaptureLayout.seamOverlap)
            )

            let targets = VoiceCaptureTargetGeometry(
                podBounds: host.podBounds,
                crownBounds: host.crownBounds,
                rightToLeft: item.rightToLeft
            )
            let segment = host.crownBounds.width / 3
            let expected: [VoiceCaptureTarget] = item.rightToLeft
                ? [.send, .cancel, .auto]
                : [.auto, .cancel, .send]
            for y in [host.crownBounds.midY, host.podBounds.midY] {
                for index in 0..<3 {
                    let point = CGPoint(
                        x: host.crownBounds.minX + (CGFloat(index) + 0.5) * segment,
                        y: y
                    )
                    #expect(targets.target(at: point) == expected[index])
                }
            }
            #expect(targets.target(at: CGPoint(
                x: host.crownBounds.minX,
                y: host.crownBounds.minY
            )) == expected[0])
            #expect(targets.target(at: CGPoint(
                x: host.crownBounds.maxX,
                y: host.crownBounds.maxY
            )) == expected[2])
        }
    }

    @Test func stableGestureHostIsExactlyTheIdleButtonAtTheTrailingBottomAnchor() {
        let geometry = VoiceCaptureGestureHostGeometry(
            idleSize: 48,
            podSize: CGSize(width: 198, height: 52),
            crownSize: CGSize(width: 210, height: 58),
            seamOverlap: 8,
            rightToLeft: false
        )

        #expect(geometry.hostSize == CGSize(width: 48, height: 48))
        #expect(geometry.idleBounds == CGRect(x: 0, y: 0, width: 48, height: 48))
        #expect(geometry.podBounds == CGRect(x: -150, y: -4, width: 198, height: 52))
        #expect(geometry.crownBounds == CGRect(x: -162, y: -54, width: 210, height: 58))

        let rightToLeft = VoiceCaptureGestureHostGeometry(
            idleSize: 48,
            podSize: CGSize(width: 198, height: 52),
            crownSize: CGSize(width: 210, height: 58),
            seamOverlap: 8,
            rightToLeft: true
        )
        #expect(rightToLeft.hostSize == geometry.hostSize)
        #expect(rightToLeft.idleBounds == geometry.idleBounds)
        #expect(rightToLeft.podBounds == CGRect(x: 0, y: -4, width: 198, height: 52))
        #expect(rightToLeft.crownBounds == CGRect(x: 0, y: -54, width: 210, height: 58))
    }

    @Test @MainActor func idleHostRoutesFormerEnvelopeWhitespaceToTheUnderlyingComposer() {
        let container = UIView(frame: CGRect(x: 0, y: 0, width: 210, height: 102))
        let composer = UIView(frame: container.bounds)
        let host = VoiceCaptureGestureHostView(frame: CGRect(x: 162, y: 54, width: 48, height: 48))
        container.addSubview(composer)
        container.addSubview(host)

        #expect(container.hitTest(CGPoint(x: 40, y: 84), with: nil) === composer)
        #expect(container.hitTest(CGPoint(x: 180, y: 84), with: nil) === host)

        host.acceptsNewTouches = false
        #expect(container.hitTest(CGPoint(x: 180, y: 84), with: nil) === composer)
    }

    @Test func windowSpaceTargetGeometryTracksContinuousDrag() {
        let geometry = VoiceCaptureTargetGeometry(
            podBounds: CGRect(x: 100, y: 250, width: 198, height: 52),
            crownBounds: CGRect(x: 88, y: 200, width: 210, height: 58)
        )

        #expect(geometry.target(at: CGPoint(x: 110, y: 225)) == .auto)
        #expect(geometry.target(at: CGPoint(x: 190, y: 225)) == .cancel)
        #expect(geometry.target(at: CGPoint(x: 275, y: 225)) == .send)
        #expect(geometry.target(at: CGPoint(x: 190, y: 280)) == .cancel)
    }

    @Test func targetGeometryMatchesConnectedCompactCrownAndPod() {
        let geometry = VoiceCaptureTargetGeometry(
            podSize: CGSize(width: 198, height: 52),
            crownSize: CGSize(width: 210, height: 58),
            seamOverlap: 8
        )

        #expect(geometry.podBounds == CGRect(x: 0, y: 0, width: 198, height: 52))
        #expect(geometry.crownBounds == CGRect(x: -12, y: -50, width: 210, height: 58))
        #expect(geometry.target(at: CGPoint(x: 20, y: -30)) == .auto)
        #expect(geometry.target(at: CGPoint(x: 93, y: -30)) == .cancel)
        #expect(geometry.target(at: CGPoint(x: 170, y: -30)) == .send)
        #expect(geometry.target(at: CGPoint(x: 20, y: 26)) == .auto)
        #expect(geometry.target(at: CGPoint(x: 93, y: 26)) == .cancel)
        #expect(geometry.target(at: CGPoint(x: 170, y: 26)) == .send)
    }

    @Test func targetGeometryFallsBackToSendOutsideVisibleSurfaces() {
        let geometry = VoiceCaptureTargetGeometry(
            podSize: CGSize(width: 198, height: 52),
            crownSize: CGSize(width: 210, height: 58),
            seamOverlap: 8
        )

        #expect(geometry.target(at: CGPoint(x: 20, y: -500)) == .send)
        #expect(geometry.target(at: CGPoint(x: 20, y: 80)) == .send)
        #expect(geometry.target(at: CGPoint(x: -80, y: -20)) == .send)
        #expect(geometry.target(at: CGPoint(x: 240, y: 20)) == .send)
    }

    @Test func targetGeometryMirrorsFacetOrderInRightToLeftLayout() {
        let geometry = VoiceCaptureTargetGeometry(
            podSize: CGSize(width: 198, height: 52),
            crownSize: CGSize(width: 210, height: 58),
            seamOverlap: 8,
            rightToLeft: true
        )

        #expect(geometry.crownBounds == CGRect(x: 0, y: -50, width: 210, height: 58))
        #expect(geometry.target(at: CGPoint(x: 25, y: -25)) == .send)
        #expect(geometry.target(at: CGPoint(x: 105, y: -25)) == .cancel)
        #expect(geometry.target(at: CGPoint(x: 185, y: -25)) == .auto)
        #expect(geometry.target(at: CGPoint(x: 25, y: 25)) == .send)
        #expect(geometry.target(at: CGPoint(x: 185, y: 25)) == .auto)
    }

    @Test func rapidDeliberateDragsRetainTheBoundedSelectedRegion() {
        let geometry = VoiceCaptureTargetGeometry(
            podSize: CGSize(width: 198, height: 52),
            crownSize: CGSize(width: 210, height: 58),
            seamOverlap: 8
        )
        let cases: [(CGPoint, VoiceCaptureIntent)] = [
            (CGPoint(x: 20, y: -25), .enterAuto),
            (CGPoint(x: 93, y: -25), .cancelHeld),
            (CGPoint(x: 170, y: -25), .sendHeld),
        ]

        for (location, expectedIntent) in cases {
            let target = VoiceCaptureReducer.target(at: location, geometry: geometry)
            let transition = VoiceCaptureReducer.release(
                from: .hold,
                target: target,
                elapsed: 0.1,
                maximumTravel: 48
            )
            #expect(transition.intents == [expectedIntent])
        }
    }

    @Test func composerActionGroupsWrapAgainstTheirParentProposal() {
        #expect(!ComposerActionLayout.shouldStack(
            availableWidth: 359,
            leadingWidth: 93,
            trailingWidth: 248,
            spacing: 5
        ))
        #expect(ComposerActionLayout.shouldStack(
            availableWidth: 330,
            leadingWidth: 93,
            trailingWidth: 248,
            spacing: 5
        ))
        #expect(!ComposerActionLayout.shouldStack(
            availableWidth: 198,
            leadingWidth: 0,
            trailingWidth: 198,
            spacing: 5
        ))
    }

    @Test func widestTrailingActionsWrapWithoutShrinkingTouchTargets() {
        let availableWidth: CGFloat = 286
        let widths = [
            ComposerGeometry.smallControlSize,
            ComposerGeometry.compactTrailingControlSize,
            VoiceCaptureLayout.accessibilityLiveWidth,
        ]
        let rows = ComposerTrailingActionLayout.rows(
            availableWidth: availableWidth,
            itemWidths: widths,
            spacing: ComposerGeometry.trailingActionGap
        )

        #expect(rows == [[0, 1], [2]])
        #expect(widths.allSatisfy { $0 >= 44 })
        #expect(rows.allSatisfy { row in
            let width = row.map { widths[$0] }.reduce(0, +)
                + CGFloat(max(0, row.count - 1)) * ComposerGeometry.trailingActionGap
            return width <= availableWidth
        })
        #expect(VoiceCaptureLayout.compactLiveHeight >= 44)
        #expect(VoiceCaptureLayout.accessibilityCrownHeight >= 44)
        #expect(VoiceCaptureLayout.accessibilityLiveWidth / 3 >= 44)
    }

    @Test func composerGlyphsUseTheExactApprovedLocalVectorSources() {
        let expected: [ComposerGlyph: [String]] = [
            .microphone: [
                "rect x=8 y=3 width=8 height=12 rx=4",
                "M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6",
            ],
            .send: ["m4 4 17 8-17 8 3-8zM7 12h14"],
            .spokenResponsesOn: ["M5 10v4h4l5 4V6l-5 4zM17 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"],
            .spokenResponsesOff: ["M5 10v4h4l5 4V6l-5 4zM3 3l18 18"],
            .attachment: ["m9 12 6-6a4 4 0 0 1 6 6l-8 8a6 6 0 0 1-8-8l8-8"],
            .stopResponse: ["rect x=7 y=7 width=10 height=10 rx=2"],
            .auto: ["M8 17a6 6 0 1 1 8 0M9 12h6M12 9v6M8 20h8"],
            .cancel: ["m6 6 12 12M18 6 6 18"],
        ]

        #expect(ComposerGlyph.approvedViewBox == CGSize(width: 24, height: 24))
        #expect(ComposerGlyph.approvedStrokeWidth == 1.7)
        #expect(Set(expected.keys) == Set(ComposerGlyph.allCases))
        for glyph in ComposerGlyph.allCases {
            #expect(glyph.approvedSourceElements == expected[glyph])
        }
    }

    @Test func composerGlyphGeometryKeepsOneConsistentTwentyFourPointRatio() {
        for glyph in ComposerGlyph.allCases {
            let approved = ComposerGlyphShape(glyph: glyph).path(
                in: CGRect(origin: .zero, size: ComposerGlyph.approvedViewBox)
            ).boundingRect
            let doubled = ComposerGlyphShape(glyph: glyph).path(
                in: CGRect(x: 10, y: 20, width: 48, height: 48)
            ).boundingRect

            #expect(abs(doubled.minX - (10 + approved.minX * 2)) < 0.001)
            #expect(abs(doubled.minY - (20 + approved.minY * 2)) < 0.001)
            #expect(abs(doubled.width - approved.width * 2) < 0.001)
            #expect(abs(doubled.height - approved.height * 2) < 0.001)
        }
    }

    @Test func hostedPressDepthTracksBeginAndTermination() {
        var state = VoiceCapturePhysicalPressState()
        #expect(!state.isPressed)

        state.begin()
        #expect(state.isPressed)
        state.end()
        #expect(!state.isPressed)
    }

    @Test func pressedDepthCollapsesOnlyTheIdleButton() {
        let idle = VoiceCapturePresentationState(state: .idle, disabled: false)
        let hold = VoiceCapturePresentationState(state: .hold, disabled: false)
        let auto = VoiceCapturePresentationState(state: .auto, disabled: false)

        #expect(VoicePodPressBehavior.appliesPressedDepth(presentation: idle, pressed: true))
        #expect(!VoicePodPressBehavior.appliesPressedDepth(presentation: hold, pressed: true))
        #expect(!VoicePodPressBehavior.appliesPressedDepth(presentation: auto, pressed: true))
    }

    @Test func composerHoldPresentationBridgesDelayedSemanticAuthorityWithoutAVisibleGap() {
        #expect(!ComposerVoicePresentationState(talkMode: .idle, localHoldActive: false).isHolding)
        #expect(ComposerVoicePresentationState(talkMode: .idle, localHoldActive: true).isHolding)
        #expect(ComposerVoicePresentationState(talkMode: .hold, localHoldActive: true).isHolding)
        #expect(ComposerVoicePresentationState(talkMode: .hold, localHoldActive: false).isHolding)
        #expect(!ComposerVoicePresentationState(talkMode: .idle, localHoldActive: false).isHolding)
    }

    @Test func extraTouchesCannotTerminateThePrimaryGesture() {
        var tracker = VoiceCaptureTouchTracker<Int>()

        #expect(tracker.touchesBegan([1]) == .started)
        #expect(tracker.touchesBegan([2]) == .ignored)
        #expect(tracker.touchesEnded([2]) == .ignored)
        #expect(tracker.primaryTouch == 1)
        #expect(tracker.touchesMoved([1]) == .changed)
        #expect(tracker.touchesEnded([1]) == .released)
        #expect(tracker.primaryTouch == nil)

        #expect(tracker.touchesBegan([1, 2]) == .rejected)
        #expect(tracker.primaryTouch == nil)
        #expect(tracker.touchesBegan([3]) == .started)
        #expect(tracker.touchesCancelled([3]) == .cancelled)
        #expect(tracker.primaryTouch == nil)
    }

    @Test func heldPresentationFansDeckWhileAutoKeepsItFolded() {
        let held = VoiceCapturePresentationState(state: .hold, disabled: false)
        let auto = VoiceCapturePresentationState(state: .auto, disabled: false)

        #expect(held.isExpanded)
        #expect(held.showsTargetDeck)
        #expect(auto.isExpanded)
        #expect(!auto.showsTargetDeck)
    }

    @Test func presentationKeepsFailureAndDisabledStatesExplicit() {
        let denied = VoiceCapturePresentationState(state: .denied, disabled: false)
        let failed = VoiceCapturePresentationState(state: .failed, disabled: false)
        let transitioning = VoiceCapturePresentationState(state: .transitioning, disabled: false)
        let disabled = VoiceCapturePresentationState(state: .disabled, disabled: true)

        #expect(denied.showsFailureNotice)
        #expect(failed.showsFailureNotice)
        #expect(transitioning.isDisabled)
        #expect(!transitioning.showsWaveform)
        #expect(transitioning.primaryLabel == "Voice capture is changing modes")
        #expect(disabled.isDisabled)
        #expect(!disabled.showsWaveform)
        #expect(disabled.primaryLabel == "Voice unavailable while reconnecting")
    }

    @Test func reducedMotionWaveUsesClampedPerBarLevels() {
        let levels: [Float] = [-1, 0, 0.5, 2, .nan]

        #expect(PttWaveMetrics.levelScale(levels, at: 0) == PttWaveMetrics.levelFloor)
        #expect(PttWaveMetrics.levelScale(levels, at: 2) == 0.675)
        #expect(PttWaveMetrics.levelScale(levels, at: 3) == 1)
        #expect(PttWaveMetrics.levelScale(levels, at: 4) == PttWaveMetrics.levelFloor)
        #expect(PttWaveMetrics.levelScale(levels, at: 8) == PttWaveMetrics.levelFloor)
    }

    @Test func animatedWaveRetainsLevelAmplitude() {
        let quiet = PttWaveMetrics.animatedScale([0], at: 0, time: 0.5)
        let loud = PttWaveMetrics.animatedScale([1], at: 0, time: 0.5)

        #expect(quiet == PttWaveMetrics.levelFloor)
        #expect(loud == 1)
        #expect(loud > quiet)
    }
}
