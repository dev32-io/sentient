import SwiftUI
import Testing
import UIKit
import XCTest
import MobileData
import Vision
@testable import SentientApp

struct MessageBubbleShellGeometryTests {
    @MainActor
    @Test func measuredAndMountedShellsKeepSameHeightAcrossWrappingAndActiveChrome() {
        let text = Array(repeating: "Wrapped message content keeps native layout authority.", count: 40)
            .joined(separator: "\n\n")
        let typeSizes: [(DynamicTypeSize, UIContentSizeCategory)] = [
            (.large, .large),
            (.accessibility3, .accessibilityExtraLarge),
        ]
        let timestamps: [Int64?] = [nil, 1_700_000_000_000]
        for width in [CGFloat(180), 320] {
            for (dynamicType, contentSize) in typeSizes {
                for role in [MessageBubbleRole.assistant, .user] {
                    for direction in [LayoutDirection.leftToRight, .rightToLeft] {
                        for timestamp in timestamps {
                            let measured = size(measurement: true, active: false)
                            let mounted = size(measurement: false, active: false)
                            let active = size(measurement: false, active: true)
                            #expect(abs(measured.height - mounted.height) < 0.5)
                            #expect(abs(measured.height - active.height) < 0.5)
                            #expect(measured.width == mounted.width)
                            #expect(measured.width == active.width)

                            func size(measurement: Bool, active: Bool) -> CGSize {
                                let shell = MessageBubbleShell(
                                    role: role, name: "Sentient", timestamp: timestamp,
                                    isStreaming: active, cutoffLabel: nil, index: 0, total: 1,
                                    avatarMode: active ? .responding : .idle,
                                    pending: role.isUser
                                ) {
                                    Text(text).font(.body)
                                } footer: {
                                    if role.isUser { Text("Sending…").font(.caption) }
                                }
                                .environment(\.bubbleMaxWidth, width - BubbleLayout.edgeMin)
                                .environment(\.sentientIdentityMeasurement, measurement)
                                .environment(\.sentientIdentityPlaybackEnabled, false)
                                .environment(\.dynamicTypeSize, dynamicType)
                                .environment(\.layoutDirection, direction)
                                let host = UIHostingController(rootView: shell)
                                host.safeAreaRegions = []
                                host.traitOverrides.preferredContentSizeCategory = contentSize
                                let proposal = CGSize(width: width, height: .greatestFiniteMagnitude)
                                host.view.frame = CGRect(origin: .zero, size: CGSize(width: width, height: 1))
                                host.view.layoutIfNeeded()
                                let first = host.sizeThatFits(in: proposal)
                                host.view.bounds.size = CGSize(width: width, height: first.height)
                                host.view.setNeedsLayout()
                                host.view.layoutIfNeeded()
                                return host.sizeThatFits(in: proposal)
                            }
                        }
                    }
                }
            }
        }
    }
}

// Exercise the real row → hosting cell composition, not an isolated Shape.

@MainActor
final class MessageBubbleShellRasterTests: XCTestCase {
    func testRoundedFaceAndLongTileSeamsSurviveHostingBounds() async throws {
        for source in ["A", Array(repeating: "Native selectable paragraph with stable streaming geometry.", count: 80).joined(separator: "\n\n")] {
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
            let window = UIWindow(windowScene: scene)
            let controller = BubbleCollectionProbe()
            window.rootViewController = controller
            window.overrideUserInterfaceStyle = .dark
            window.makeKeyAndVisible()
            defer { window.isHidden = true }
            let message = ChatMessage(ts: 0, role: "assistant", content: source, streaming: true,
                                      cutoffKind: nil, turnId: "raster", replyId: "raster", pendingId: nil, entryId: "raster")
            var mountedHeight: CGFloat = 0
            func row(measurement: Bool) -> MessageRowLayout {
                MessageRowLayout(row: .message(message, index: 0, continuation: false),
                                 messageCount: 1, paneWidth: 390, userName: "Test", avatarMode: .idle,
                                 avatarPlaybackEnabled: false, measurement: measurement,
                                 imageCache: MarkdownImageCache(), onRetry: { _ in },
                                 onGeometryChange: { mountedHeight = $0.height })
            }
            let measurer = UIHostingController(rootView: row(measurement: true))
            measurer.safeAreaRegions = []
            let proposal = CGSize(width: 390, height: CGFloat.greatestFiniteMagnitude)
            let height = measurer.sizeThatFits(in: proposal).height
            controller.install(row: AnyView(row(measurement: false)), height: height)
            let raster = await settledRaster(controller, ready: { mountedHeight > 0 })
            XCTAssertEqual(mountedHeight, height, accuracy: 0.5, "Overscan must not enter row measurement")
            let cell = try XCTUnwrap(controller.collection.cellForItem(at: IndexPath(item: 0, section: 0)))
            XCTAssertEqual(cell.frame.minY, 120, accuracy: 0.001)
            XCTAssertEqual(cell.bounds.height, height, accuracy: 0.5)
            XCTAssertFalse(cell.point(inside: CGPoint(x: 80, y: -6), with: nil), "Decorative overflow must not expand the row hit area")
            func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
            let document = try XCTUnwrap(descendants(cell).compactMap { $0 as? MessageDocumentView }.first)
            let faceTop = document.convert(document.bounds, to: controller.view).minY - Space.md
            let timestampHeight = faceTop - cell.frame.minY
            let background = red(raster, x: 80, y: 60)
            XCTAssertGreaterThan(red(raster, x: 80, y: Int(faceTop) - 6), background + 3,
                                 "Rounded face must cast above its top, without clipping at hosting bounds")
            XCTAssertGreaterThan(red(raster, x: 300, y: Int(faceTop) + 8), background + 3,
                                 "Upper face has no identity shoulder cutout")
            attach(raster, name: source.count == 1 ? "real-cell-short-rounded" : "real-cell-long-rounded")
            if source.count > 1 {
                // Canvas tiles own 512pt slices in expanded chrome coordinates.
                let overflow = BubbleLayout.chromeOverflow(increasedContrast: false)
                for tile in 1...3 {
                    let seam = CGFloat(tile) * 512 - overflow
                    controller.collection.contentOffset.y = 120 + timestampHeight + seam - 400
                    let image = await settledRaster(controller, ready: { true })
                    let samples = (397...403).map { red(image, x: 5, y: $0) }
                    XCTAssertGreaterThan(samples.min() ?? 0, background + 3, "Long side halo must remain painted")
                    XCTAssertLessThanOrEqual((samples.max() ?? 0) - (samples.min() ?? 0), 2,
                                             "Adjacent overscanned tiles must not create dark or doubled seams")
                    attach(image, name: "real-cell-long-seam-\(tile)")
                }
            }
            controller.collection.contentOffset.y = max(0, 120 + height - 600)
            let bottom = await settledRaster(controller, ready: { true })
            let bottomY = Int(120 + height - controller.collection.contentOffset.y)
            XCTAssertGreaterThan(red(bottom, x: 80, y: bottomY + 6), background + 3,
                                 "Bottom halo must survive the same hosting boundary")
            attach(bottom, name: source.count == 1 ? "real-cell-short-bottom" : "real-cell-long-bottom")
        }
    }

    func testFloatingHeaderRetainsCenteredAvatarAndControlsAtAccessibilityExtraLarge() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        for width in [CGFloat(320), 390] {
            let window = UIWindow(windowScene: scene)
            let host = UIHostingController(rootView: ChatTitleBar(onOpenPanel: {}, onOpenInbox: {}, onNewChat: {})
                .environment(\.dynamicTypeSize, .accessibility3))
            host.safeAreaRegions = []
            host.traitOverrides.preferredContentSizeCategory = .accessibilityExtraLarge
            window.rootViewController = UIViewController()
            window.rootViewController?.view.backgroundColor = UIColor(DuskColors.bg)
            host.view.backgroundColor = .clear
            window.overrideUserInterfaceStyle = .dark
            window.makeKeyAndVisible()
            defer { window.isHidden = true }
            let height = host.sizeThatFits(in: CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)).height
            window.rootViewController!.addChild(host)
            window.rootViewController!.view.addSubview(host.view)
            host.view.frame = CGRect(x: 0, y: 120, width: width, height: height)
            host.didMove(toParent: window.rootViewController)
            let raster = await settledRaster(window.rootViewController!, ready: { true })
            attach(raster, name: "header-AX3-\(Int(width))")
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["en-US"]
            try VNImageRequestHandler(cgImage: XCTUnwrap(raster.cgImage)).perform([request])
            let words = request.results?.compactMap { $0.topCandidates(1).first?.string } ?? []
            XCTAssertFalse(words.contains("Sentient"), "Floating header removes wordmark, not avatar or actions")
            XCTAssertGreaterThanOrEqual(height, DesignMetrics.minimumTarget + 2 * Space.sm)
            XCTAssertLessThanOrEqual(height, DesignMetrics.minimumTarget + 2 * Space.sm + 1)
            let baseline = red(raster, x: 2, y: 120 + Int(height / 2))
            let target = DesignMetrics.minimumTarget
            let centers = [Space.lg + target / 2, width / 2,
                           width - Space.lg - target * 1.5 - Space.sm,
                           width - Space.lg - target / 2]
            for (name, center) in zip(["History", "static avatar", "Scheduled messages", "New chat"], centers) {
                let samples = stride(from: -12, through: 12, by: 3).flatMap { dx in
                    stride(from: -12, through: 12, by: 3).map { dy in
                        abs(red(raster, x: Int(center) + dx, y: 120 + Int(height / 2) + dy) - baseline)
                    }
                }
                XCTAssertGreaterThan(samples.max() ?? 0, 20, "\(name) must remain painted inside fitted header")
            }
            XCTAssertLessThanOrEqual(host.sizeThatFits(in: CGSize(width: width, height: 1000)).width, width)
            // Contrast behind transparent image pixels must not bleed through the
            // avatar's 40pt circular face. The outer 44pt footprint stays clear.
            window.rootViewController?.view.backgroundColor = .white
            let light = await settledRaster(window.rootViewController!, ready: { true })
            window.rootViewController?.view.backgroundColor = .black
            let dark = await settledRaster(window.rootViewController!, ready: { true })
            let centerX = Int(width / 2), centerY = 120 + Int(height / 2)
            for dx in [-19, 0, 19] {
                XCTAssertLessThanOrEqual(abs(red(light, x: centerX + dx, y: centerY)
                    - red(dark, x: centerX + dx, y: centerY)), 1,
                    "Opaque avatar face must occlude contrast content through its 40pt diameter")
            }
            for dx in [-21, 21] {
                XCTAssertGreaterThan(abs(red(light, x: centerX + dx, y: centerY)
                    - red(dark, x: centerX + dx, y: centerY)), 200,
                    "44pt footprint must not enlarge the 40pt painted face")
            }
            attach(light, name: "header-opaque-avatar-light-\(Int(width))")
            attach(dark, name: "header-opaque-avatar-dark-\(Int(width))")
        }
    }

    private func settledRaster(_ controller: UIViewController, ready: () -> Bool) async -> UIImage {
        var raster = UIImage()
        var previous: [Int] = []
        var stableFrames = 0
        let deadline = Date().addingTimeInterval(3)
        repeat {
            // Bounded render-readiness polling; no private idle hooks.
            try? await Task.sleep(for: .milliseconds(20))
            controller.view.layoutIfNeeded()
            raster = UIGraphicsImageRenderer(bounds: controller.view.bounds).image { _ in
                controller.view.drawHierarchy(in: controller.view.bounds, afterScreenUpdates: true)
            }
            let samples = [114, 125, 397, 400, 403].map { red(raster, x: 80, y: $0) }
            stableFrames = samples == previous && ready() ? stableFrames + 1 : 0
            previous = samples
        } while stableFrames < 3 && Date() < deadline
        XCTAssertGreaterThanOrEqual(stableFrames, 3, "Native composition must reach a stable raster")
        return raster
    }

    private func attach(_ image: UIImage, name: String) {
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func red(_ image: UIImage, x: Int, y: Int) -> Int {
        guard let cg = image.cgImage else { return 0 }
        var bytes = [UInt8](repeating: 0, count: 4)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        bytes.withUnsafeMutableBytes { buffer in
            let context = CGContext(data: buffer.baseAddress, width: 1, height: 1, bitsPerComponent: 8,
                                    bytesPerRow: 4, space: colorSpace,
                                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            context.translateBy(x: -CGFloat(x) * image.scale, y: CGFloat(y) * image.scale - CGFloat(cg.height) + 1)
            context.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
        }
        return Int(bytes[0])
    }
}

@MainActor
private final class BubbleCollectionProbe: UIViewController, UICollectionViewDataSource {
    private let layout = UICollectionViewFlowLayout()
    lazy var collection = UICollectionView(frame: .zero, collectionViewLayout: layout)
    private var row = AnyView(EmptyView())

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(DuskColors.bg)
        collection.backgroundColor = .clear
        collection.contentInsetAdjustmentBehavior = .never
        collection.dataSource = self
        collection.register(MessageHostingCell.self, forCellWithReuseIdentifier: MessageHostingCell.reuseIdentifier)
        view.addSubview(collection)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        collection.frame = CGRect(x: 0, y: 0, width: 390, height: 800)
    }

    func install(row: AnyView, height: CGFloat) {
        self.row = row
        layout.itemSize = CGSize(width: 390, height: height)
        layout.sectionInset = UIEdgeInsets(top: 120, left: 0, bottom: 300, right: 0)
        collection.reloadData()
        view.layoutIfNeeded()
    }

    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int { 1 }
    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        let cell = collectionView.dequeueReusableCell(withReuseIdentifier: MessageHostingCell.reuseIdentifier, for: indexPath) as! MessageHostingCell
        cell.set(rootView: row, avatarPlaybackEnabled: false, configurationKey: "raster", measurementKey: "raster")
        return cell
    }
}
