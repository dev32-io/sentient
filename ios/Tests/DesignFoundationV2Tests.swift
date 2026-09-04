import XCTest
import MobileData
@testable import SentientApp

final class DesignFoundationV2Tests: XCTestCase {
    func testKMPContractIdentityAndLockedProjection() {
        XCTAssertEqual(DesignV2.version, "2.0.0")
        XCTAssertEqual(DesignV2.contractSha256, "12c9be6961247345caa3330a6f1b1224d07560be7255f1aa9bdbd9e8ecb01d2a")

        XCTAssertEqual(DesignV2.ColorToken.allCases.map(\.argb), [
            0xFF2B2621, 0xFF332D28, 0xFF241F1B, 0xFF39322C, 0xFF4A4138, 0xFF3E362F,
            0xFFF2E8D6, 0xFFD7C6AB, 0xFF9E907E, 0xFF706456,
            0xFFF2A06A, 0xFF5A3A28, 0xFF402C22, 0xFFE9B168, 0xFFB9C8A6, 0xFF3A4232,
            0xFF9A5A3E, 0xFF5F8A5B, 0xFFC2892F, 0xFFB8442E,
        ])
        XCTAssertEqual([DesignV2.Typography.xs, DesignV2.Typography.supporting, DesignV2.Typography.body,
                        DesignV2.Typography.large, DesignV2.Typography.title, DesignV2.Typography.display],
                       [11, 12.5, 15, 18, 22, 44])
        XCTAssertEqual([DesignV2.Spacing.xs, DesignV2.Spacing.sm, DesignV2.Spacing.md, DesignV2.Spacing.lg,
                        DesignV2.Spacing.xl, DesignV2.Spacing.xxl, DesignV2.Spacing.xxxl],
                       [4, 8, 12, 18, 26, 32, 40])
        XCTAssertEqual([DesignV2.Radius.sm, DesignV2.Radius.md, DesignV2.Radius.lg, DesignV2.Radius.xl],
                       [8, 12, 18, 26])
        XCTAssertEqual(DesignV2.Motion.feedback, 0.15)
        XCTAssertEqual(DesignV2.Motion.state, 0.25)
        XCTAssertEqual(DesignV2.Motion.respondingCadence, 1.55)
    }

    func testMotionProjectsEveryCanonicalRoleAndKeepsCompatibilityAliasesAligned() {
        let canonical = MobileData.Motion_.shared

        XCTAssertEqual(DesignV2.Motion.feedback, Double(canonical.feedbackMs) / 1_000)
        XCTAssertEqual(DesignV2.Motion.state, Double(canonical.stateTransitionMs) / 1_000)
        XCTAssertEqual(DesignV2.Motion.respondingCadence, Double(canonical.respondingCadenceMs) / 1_000)
        XCTAssertEqual(
            [DesignV2.Motion.feedback, DesignV2.Motion.state, DesignV2.Motion.respondingCadence],
            [0.15, 0.25, 1.55]
        )

        XCTAssertEqual(Motion.fast, DesignV2.Motion.feedback)
        XCTAssertEqual(Motion.normal, DesignV2.Motion.state)
        XCTAssertEqual(Motion.respondingCadence, DesignV2.Motion.respondingCadence)
        XCTAssertEqual(Motion.wave, DesignV2.Motion.respondingCadence)
        XCTAssertEqual(Motion.cursor, DesignV2.Motion.respondingCadence)
    }

    func testSecureFieldAccessibilityNeverExposesHiddenValue() {
        let secret = "1234-secret-key"

        let hidden = DesignSecureField.accessibilityValue(
            text: secret,
            isEnabled: true,
            error: nil,
            revealed: false
        )
        XCTAssertEqual(hidden, "Value entered")
        XCTAssertFalse(hidden.contains(secret))

        XCTAssertEqual(
            DesignSecureField.accessibilityValue(text: secret, isEnabled: true, error: nil, revealed: true),
            secret
        )
        XCTAssertEqual(
            DesignSecureField.accessibilityValue(text: "", isEnabled: true, error: nil, revealed: false),
            "Empty"
        )
        XCTAssertEqual(
            DesignSecureField.accessibilityValue(text: secret, isEnabled: false, error: nil, revealed: true),
            "Disabled"
        )
        XCTAssertEqual(
            DesignSecureField.accessibilityValue(text: secret, isEnabled: true, error: "Invalid PIN", revealed: false),
            "Error: Invalid PIN"
        )
    }

    func testNamedMaterialRolesProjectEveryKMPRecipe() {
        XCTAssertEqual(DesignV2.MaterialRole.allCases.count, 16)
        XCTAssertTrue(DesignV2.MaterialRole.allCases.allSatisfy { !$0.contractRecipe.isEmpty })
        XCTAssertTrue(DesignV2.MaterialRole.slateFace.contractRecipe.contains("radial-gradient"))
        XCTAssertTrue(DesignV2.MaterialRole.wellFace.contractRecipe.contains("linear-gradient"))
        XCTAssertEqual(DesignMaterialMetrics.slateRadialScale, CGSize(width: 0.82, height: 1.05))
        XCTAssertEqual(DesignMaterialMetrics.slateRadialCenterY, 0.52)
        XCTAssertEqual(DesignMaterialMetrics.slateCenterStop, 0.42)
        XCTAssertEqual(DesignMaterialMetrics.slateFadeStop, 0.76)
        XCTAssertEqual(DesignMaterialMetrics.wellMiddleStop, 0.56)
        XCTAssertEqual(DesignMaterialMetrics.plateCastY, 18)
        XCTAssertEqual(DesignMaterialMetrics.plateCastBlur, 30)
        XCTAssertEqual(DesignMaterialMetrics.floatCastY, 28)
        XCTAssertEqual(DesignMaterialMetrics.floatCastBlur, 58)
        XCTAssertEqual(
            DesignMaterialShadowGeometry.slateRest,
            DesignDropShadowGeometry(radius: 15, y: 9, sourceInset: 10)
        )
        XCTAssertEqual(
            DesignMaterialShadowGeometry.plate,
            DesignDropShadowGeometry(radius: 30, y: 18, sourceInset: 22)
        )
        XCTAssertEqual(
            DesignMaterialShadowGeometry.floatGlow,
            DesignDropShadowGeometry(radius: 40, y: 24, sourceInset: 30)
        )
        XCTAssertEqual(DesignMaterialAdapter.avatarDisabledOpacity, 0.58)
        XCTAssertEqual(DesignMetrics.pressedDepth, 1)
    }

    func testNativeMaterialAdapterCoversEveryGeneratedRecipe() {
        let projections = DesignV2.MaterialRole.allCases.map { DesignMaterialAdapter.nativeProjection(for: $0) }

        XCTAssertEqual(Set(projections.map(\.role)), Set(DesignV2.MaterialRole.allCases))
        XCTAssertEqual(Set(projections.map { $0.kind.rawValue }), Set(DesignMaterialNativeProjection.Kind.allCases.map(\.rawValue)))
        XCTAssertTrue(projections.allSatisfy { $0.contractRecipe == $0.role.contractRecipe })
    }

    func testTypographyAdapterUsesGeneratedFamilyRoles() {
        func firstFamily(_ fallbackList: String) -> String {
            fallbackList.split(separator: ",", maxSplits: 1).first.map {
                $0.trimmingCharacters(in: .whitespacesAndNewlines)
            } ?? fallbackList
        }

        XCTAssertEqual(DesignTypographyAdapter.displayFamily, firstFamily(MobileData.Fonts_.shared.display))
        XCTAssertEqual(DesignTypographyAdapter.uiFamily, firstFamily(MobileData.Fonts_.shared.ui))
        XCTAssertEqual(DesignTypographyAdapter.monoFamily, firstFamily(MobileData.Fonts_.shared.mono))
        XCTAssertEqual(DesignTextRole.title.family, DesignTypographyAdapter.displayFamily)
        XCTAssertEqual(DesignTextRole.label.family, DesignTypographyAdapter.uiFamily)
        XCTAssertEqual(DesignTextRole.caption.family, DesignTypographyAdapter.uiFamily)
        XCTAssertEqual(DesignTextRole.body.family, DesignTypographyAdapter.uiFamily)
        XCTAssertEqual(DesignTextRole.telemetry.family, DesignTypographyAdapter.monoFamily)
        XCTAssertEqual(DesignTextRole.label.baseSize, DesignMetrics.controlLabelSize)
        XCTAssertEqual(DesignTextRole.caption.baseSize, DesignV2.Typography.supporting)
    }

    func testControlSemanticsAndAccessibilityMetricsAreStable() {
        XCTAssertTrue(DesignControlState.normal.isInteractive)
        XCTAssertFalse(DesignControlState.loading.isInteractive)
        XCTAssertFalse(DesignControlState.error("failed").isInteractive)
        XCTAssertFalse(DesignControlState.disabled.isInteractive)
        XCTAssertTrue(DesignControlState.selected.isInteractive)
        XCTAssertTrue(DesignControlState.on.isSelected)
        XCTAssertEqual(DesignControlState.loading.accessibilityValue, "In progress")
        XCTAssertEqual(DesignControlState.error("failed").accessibilityValue, "Error: failed")
        XCTAssertEqual(DesignControlState.disabled.accessibilityValue, "Disabled")
        XCTAssertGreaterThanOrEqual(DesignMetrics.minimumTarget, 44)
        XCTAssertGreaterThanOrEqual(DesignV2.Typography.body, 15)
        XCTAssertGreaterThanOrEqual(DesignV2.Typography.supporting, 12.5)
        XCTAssertEqual(DesignTextRole.telemetry.lineHeight, 1.6)
        XCTAssertEqual(DesignTextRole.body.lineHeight, 1.55)
        XCTAssertEqual(DesignTextRole.display.lineHeight, 1.25)
    }

    func testReducedMotionSuppressesAnimation() {
        XCTAssertNil(DesignV2.Motion.animation(duration: DesignV2.Motion.state, reduceMotion: true))
        XCTAssertNotNil(DesignV2.Motion.animation(duration: DesignV2.Motion.state, reduceMotion: false))
    }

    func testLoginIdentityAndKeypadUseSharedFoundationMetrics() {
        XCTAssertEqual(DesignMetrics.dominantVisualSize, 104)
        XCTAssertEqual(DesignMetrics.dominantAvatarSize, 82)
        XCTAssertEqual(DesignMetrics.dominantCardMinimumHeight, 220)
        XCTAssertEqual(DesignMetrics.pinKeypadWidth, 276)
        XCTAssertEqual(DesignMetrics.pinDotSize, 14)
        XCTAssertEqual(DesignUserAvatarTint(serverValue: "terra"), .terra)
        XCTAssertEqual(DesignUserAvatarTint(serverValue: "sage"), .sage)
        XCTAssertEqual(DesignUserAvatarTint(serverValue: "amber"), .amber)
        XCTAssertEqual(DesignUserAvatarTint(serverValue: "clay"), .clay)
        XCTAssertEqual(DesignUserAvatarTint(serverValue: ""), .fallback)
    }
}
