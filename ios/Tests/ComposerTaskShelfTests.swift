import CoreGraphics
import CoreImage
import SwiftUI
import Testing
import UIKit
@testable import SentientApp

struct ComposerTaskShelfTests {
    @Test func disclosureOpensOnlyTheTappedTask() {
        #expect(taskShelfSelection(current: nil, tapped: "one") == "one")
        #expect(taskShelfSelection(current: "one", tapped: "two") == "two")
    }

    @Test func tappingOpenTaskCollapsesIt() {
        #expect(taskShelfSelection(current: "one", tapped: "one") == nil)
    }

    @Test(arguments: [
        (CGRect(x: 0, y: 0, width: 100, height: 44), 100.0, false, false),
        (CGRect(x: 0, y: 0, width: 100, height: 44), 240.0, false, true),
        (CGRect(x: 70, y: 0, width: 100, height: 44), 240.0, true, true),
        (CGRect(x: 140, y: 0, width: 100, height: 44), 240.0, true, false),
    ])
    func overflowFadesTrackVisibleEdges(
        visibleRect: CGRect,
        contentWidth: CGFloat,
        left: Bool,
        right: Bool
    ) {
        #expect(taskShelfOverflow(visibleRect: visibleRect, contentWidth: contentWidth)
            == TaskShelfOverflow(left: left, right: right))
    }

    @MainActor
    @Test func rtlMountedOverflowFadeStaysOnPhysicalLeft() throws {
        let size = CGSize(width: 120, height: 44)
        let renderer = ImageRenderer(content:
            TaskShelfOverflowFades(overflow: TaskShelfOverflow(left: true, right: false))
                .environment(\.layoutDirection, .rightToLeft)
                .frame(width: size.width, height: size.height)
        )
        renderer.scale = 1
        let image = try #require(renderer.uiImage)
        let leftAlpha = try averageAlpha(in: CGRect(x: 0, y: 0, width: 8, height: 44), image: image)
        let rightAlpha = try averageAlpha(in: CGRect(x: 112, y: 0, width: 8, height: 44), image: image)

        #expect(leftAlpha > rightAlpha + 0.25)
    }

    @Test func selectedPillLiftReversesAndReducedMotionKeepsFinalPosition() {
        #expect(taskPillOffset(expanded: true, pressed: false, reduceMotion: false) == -3)
        #expect(taskPillOffset(expanded: false, pressed: false, reduceMotion: false) == 0)
        #expect(taskPillOffset(expanded: true, pressed: false, reduceMotion: true) == -3)
    }

    private func averageAlpha(in rect: CGRect, image: UIImage) throws -> CGFloat {
        let input = try #require(CIImage(image: image))
        let filter = try #require(CIFilter(name: "CIAreaAverage"))
        filter.setValue(input, forKey: kCIInputImageKey)
        filter.setValue(CIVector(cgRect: rect), forKey: kCIInputExtentKey)
        let output = try #require(filter.outputImage)
        var pixel = [UInt8](repeating: 0, count: 4)
        CIContext().render(
            output,
            toBitmap: &pixel,
            rowBytes: 4,
            bounds: CGRect(x: 0, y: 0, width: 1, height: 1),
            format: .RGBA8,
            colorSpace: CGColorSpaceCreateDeviceRGB()
        )
        return CGFloat(pixel[3]) / 255
    }
}
