import XCTest
@testable import SentientApp

final class DesignFoundationV2Tests: XCTestCase {
    func testKMPContractIdentityAndLockedProjection() {
        XCTAssertEqual(DesignV2.version, "2.0.0")
        XCTAssertEqual(DesignV2.contractSha256, "f7799ee0711e7d8e4bd944606ab9342607f326ff109a44d905d8a2a7b91c7dc6")

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
        XCTAssertEqual(DesignMetrics.pressedDepth, 1)
    }

    func testControlSemanticsAndAccessibilityMetricsAreStable() {
        XCTAssertTrue(DesignControlState.normal.isInteractive)
        XCTAssertFalse(DesignControlState.loading.isInteractive)
        XCTAssertFalse(DesignControlState.error("failed").isInteractive)
        XCTAssertFalse(DesignControlState.disabled.isInteractive)
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
}
