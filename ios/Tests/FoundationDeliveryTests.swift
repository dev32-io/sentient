import XCTest
import SwiftUI
import SnapshotTesting
@testable import SentientApp

private struct BaselineProbe: Layout {
    let record: (CGFloat) -> Void

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let dimensions = subviews[0].dimensions(in: proposal)
        record(dimensions[.lastTextBaseline] - dimensions[.firstTextBaseline])
        return CGSize(width: dimensions.width, height: dimensions.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews[0].place(at: bounds.origin, proposal: proposal)
    }
}

final class FoundationDeliveryTests: XCTestCase {
    @MainActor
    func testMeasureNativeBaselinePitch() throws {
        for scale: CGFloat in [2, 3] {
            var defaultLeading: [String: CGFloat] = [:]
            for size in [DynamicTypeSize.large, .accessibility3, .accessibility5] {
                for role in [DesignTextRole.body, .supporting, .title, .telemetry] {
                    var natural: CGFloat = 0
                    var styled: CGFloat = 0
                    let view = VStack {
                        BaselineProbe(record: { natural = $0 }) {
                            Text("Hg\nHg\nHg").font(role.font)
                        }
                        BaselineProbe(record: { styled = $0 }) {
                            Text("Hg\nHg\nHg").designText(role)
                        }
                    }.environment(\.dynamicTypeSize, size)
                    let host = UIHostingController(rootView: view)
                    let strategy = Snapshotting<UIViewController, UIImage>.image(size: CGSize(width: 320, height: 900),
                        traits: UITraitCollection { $0.displayScale = scale })
                    let rendered = expectation(description: "Baseline layout")
                    strategy.snapshot(host).run { _ in rendered.fulfill() }
                    wait(for: [rendered], timeout: 10)
                    XCTAssertGreaterThan(natural, 0)
                    XCTAssertGreaterThanOrEqual(styled, natural)
                    if size == .large {
                        XCTAssertEqual(styled / 2, role.baseSize * role.lineHeight, accuracy: 0.5)
                        defaultLeading["\(role)"] = (styled - natural) / 2
                    } else if role == .body || role == .telemetry {
                        XCTAssertGreaterThan((styled - natural) / 2, try XCTUnwrap(defaultLeading["\(role)"]) * 1.8)
                    }
                    print("F_BASELINE scale=\(scale) role=\(role) size=\(size) naturalPitch=\(natural / 2) styledPitch=\(styled / 2)")
                }
            }
        }
    }

    func testFocusGapAndToggleBorderBoxAcrossStates() {
        for width: CGFloat in [2, 3] {
            let inset = DesignCanvasGeometry.outsideFocusInset(lineWidth: width)
            XCTAssertEqual(-inset - width / 2, 3)
        }
        let bounds = CGRect(x: 10, y: 20, width: 44, height: 28)
        for direction in [LayoutDirection.leftToRight, .rightToLeft] {
            for amount: CGFloat in [0, 0.5, 1] {
                let geometry = DesignCanvasToggleGeometry.make(in: bounds, onAmount: amount, layoutDirection: direction)
                XCTAssertEqual(geometry.knobRect.minY - bounds.minY, 5)
                XCTAssertEqual(bounds.maxY - geometry.knobRect.maxY, 5)
                XCTAssertEqual(geometry.knobRect.minX - bounds.minX, 5 + 16 * (direction == .leftToRight ? amount : 1 - amount))
            }
        }
    }

    func testSelectedChipSeatsWithoutLosingPressOrDisabledGating() {
        for reduced in [false, true] {
            for hovered in [false, true] {
                for pressed in [false, true] {
                    let chip = DesignChipCanvasProjection.make(selected: true, isEnabled: true,
                        isPressed: pressed, isFocused: true, isHovered: hovered,
                        increasedContrast: false, reduceMotion: reduced)
                    XCTAssertEqual(chip.yOffset, pressed ? 2 : 1)
                    XCTAssertTrue(chip.control.state.isFocused)
                }
            }
            let disabled = DesignChipCanvasProjection.make(selected: true, isEnabled: false,
                isPressed: true, isFocused: false, isHovered: true,
                increasedContrast: true, reduceMotion: reduced)
            XCTAssertEqual(disabled.yOffset, 1)
            XCTAssertFalse(disabled.control.state.isPressed)
            XCTAssertFalse(disabled.control.state.isHovered)
        }
    }

    func testMediaCardCollapsesCastInsteadOfPromotingToFloat() {
        let rest = DesignCanvasSurfaceRecipe.mediaCard(state: .rest, increasedContrast: false)
        let hover = DesignCanvasSurfaceRecipe.mediaCard(state: DesignCanvasControlState(isHovered: true), increasedContrast: false)
        let press = DesignCanvasSurfaceRecipe.mediaCard(state: .pressed, increasedContrast: false)
        XCTAssertEqual(hover.tier, .plate)
        XCTAssertEqual(hover.insideBorder, rest.insideBorder)
        XCTAssertEqual(hover.cast.geometry, DesignDropShadowGeometry(radius: 28, y: 18, sourceInset: 23))
        XCTAssertLessThan(press.cast.geometry.y, rest.cast.geometry.y)
        XCTAssertGreaterThan(press.pressedInnerOcclusionOpacity, 0)
    }

    @MainActor
    func testOutsideFocusRasterKeepsThreePointGapAtBothScalesAndContrasts() throws {
        for scale: CGFloat in [2, 3] {
            for increased in [false, true] {
                let view = ZStack(alignment: .topLeading) {
                    DuskColors.bg
                    DesignCanvasKernel(shape: .roundedRectangle(cornerRadius: 7), role: .secondary,
                        state: DesignCanvasControlState(isFocused: true), increasedContrast: increased, reduceMotion: true)
                        .frame(width: 80, height: 40).offset(x: 24, y: 24)
                }.frame(width: 128, height: 88)
                let host = UIHostingController(rootView: view)
                let traits = UITraitCollection { $0.displayScale = scale }
                let rendered = expectation(description: "Focus ring raster")
                var result: UIImage?
                Snapshotting<UIViewController, UIImage>.image(size: CGSize(width: 128, height: 88), traits: traits)
                    .snapshot(host).run { result = $0; rendered.fulfill() }
                wait(for: [rendered], timeout: 10)
                let image = try XCTUnwrap(result)
                let cg = try XCTUnwrap(image.cgImage)
                var pixels = [UInt8](repeating: 0, count: cg.width * cg.height * 4)
                pixels.withUnsafeMutableBytes { bytes in
                    let context = CGContext(data: bytes.baseAddress, width: cg.width, height: cg.height,
                        bitsPerComponent: 8, bytesPerRow: cg.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
                    context.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
                }
                func isRing(_ x: CGFloat) -> Bool {
                    let offset = (Int(44 * scale) * cg.width + Int(x * scale)) * 4
                    return pixels[offset] > 180 && pixels[offset + 1] > 100
                }
                XCTAssertTrue(isRing(20), "Ring at 20pt, scale \(scale), increased \(increased)")
                XCTAssertFalse(isRing(21.5), "Inner edge must remain at 21pt, 3pt outside face")
                XCTAssertFalse(isRing(23), "Focus gap must not consume face margin")
                let attachment = XCTAttachment(image: image)
                attachment.name = "focus-\(Int(scale))x-\(increased ? "increased" : "normal")"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
        }
    }

}
