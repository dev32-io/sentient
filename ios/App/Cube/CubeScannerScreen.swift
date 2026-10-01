import AVFoundation
import SwiftUI
import VisionKit

/// Camera produces the exact same validated payload as debug-only manual entry.
/// Recognition is not authentication; the caller must establish the Security2 session.
struct CubeScannerScreen: View {
    let onBack: () -> Void
    let onScanned: (CubeSetupPayload) -> Void
    var onManual: (() -> Void)? = nil
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @State private var permission: AVAuthorizationStatus = .notDetermined
    @State private var unavailable = false
    @State private var invalidCode = false
    @State private var completed = false
#if DEBUG
    @State private var manualPayload = ""
    @State private var showManualEntry = false
#endif

    var body: some View {
        DesignPageChrome(title: "Scan Cube", accessibilityId: "cube-scanner", onBack: onBack) {
            Text("Point your camera at Cube’s screen.")
                .designText(.body)
                .foregroundStyle(DuskColors.ink2)
            if permission == .denied || permission == .restricted {
                AsyncNotice(kind: .warning, title: "Allow camera access", detail: "Sentient needs the camera to scan Cube’s setup code.")
                DesignActionButton(title: "Open iOS Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                }
            } else if unavailable {
                AsyncNotice(kind: .warning, title: "Camera unavailable", detail: "Enter the pairing information displayed on Cube instead.")
            } else if permission == .authorized, scenePhase == .active, !completed {
                CubeCameraScanner(onCode: accept, onUnavailable: { unavailable = true })
                    .frame(minHeight: 240)
                    .clipShape(RoundedRectangle(cornerRadius: Radii.lg))
                    .accessibilityLabel("Cube setup code camera")
            } else if !completed {
                ProgressView("Preparing camera…")
            }
            if invalidCode {
                AsyncNotice(kind: .error, title: "Unsupported setup code", detail: "Scan the code on Cube’s screen.", accessibilityId: "cube-invalid-code")
            }
            if let onManual {
                DesignActionButton(title: "Enter pairing info", role: .secondary, accessibilityId: "cube-manual", action: onManual)
            }
#if DEBUG
            DisclosureGroup("Debug: enter exact setup payload", isExpanded: $showManualEntry) {
                SecureField("Setup payload", text: $manualPayload)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .privacySensitive()
                    .accessibilityIdentifier("cube-debug-payload")
                DesignActionButton(title: "Use setup payload") {
                    let text = manualPayload
                    manualPayload = ""
                    accept(text)
                }
            }
#endif
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
#if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--qa-cube-setup"),
               let text = ProcessInfo.processInfo.environment["CUBE_SMOKE_QR"] {
                accept(text)
                return
            }
#endif
            let current = AVCaptureDevice.authorizationStatus(for: .video)
            if current == .notDetermined {
                _ = await AVCaptureDevice.requestAccess(for: .video)
            }
            guard !Task.isCancelled else { return }
            permission = AVCaptureDevice.authorizationStatus(for: .video)
            unavailable = !DataScannerViewController.isSupported
        }
        .onChange(of: scenePhase) { _, phase in
#if DEBUG
            if phase != .active { manualPayload = "" }
#endif
        }
        .onDisappear {
#if DEBUG
            manualPayload = ""
#endif
        }
    }

    private func accept(_ text: String) {
        guard !completed, scenePhase == .active else { return }
        do {
            let payload = try CubeSetupPayload.parse(text)
            completed = true
            onScanned(payload)
        } catch { invalidCode = true }
    }
}

private struct CubeCameraScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    let onUnavailable: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode, onUnavailable: onUnavailable) }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced, recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false,
            isPinchToZoomEnabled: true, isGuidanceEnabled: true, isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        do { try scanner.startScanning() } catch {
            DispatchQueue.main.async { context.coordinator.unavailable() }
        }
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {}

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        coordinator.active = false
        scanner.stopScanning()
        scanner.delegate = nil
    }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onCode: (String) -> Void
        let onUnavailable: () -> Void
        var active = true
        init(onCode: @escaping (String) -> Void, onUnavailable: @escaping () -> Void) {
            self.onCode = onCode
            self.onUnavailable = onUnavailable
        }
        func unavailable() { if active { onUnavailable() } }
        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard active else { return }
            for case .barcode(let barcode) in addedItems {
                if let value = barcode.payloadStringValue { onCode(value); break }
            }
        }
        func dataScanner(_ dataScanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {
            unavailable()
        }
    }
}
