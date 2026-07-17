// ---------------------------------------------------------------------------
// DevicesViewModel — Signal device-linking state over `settings.devices`
// (DevicesUseCases). Loads the pairing state, drives the link flow (start →
// render QR → poll status → linked/failed), and unlinks. IMPERATIVE ops
// (immediate call + result), mirroring the webui devices-pane cadence.
//
// The poll is the KMP usecase's cold Flow; the VM owns its lifetime — a screen
// exit or a Cancel cancels the collection AND fires link/cancel so the gateway
// tears down the pending pairing. QR bytes are the decoded PNG (Data, Sendable);
// the view builds the image. @MainActor @Observable, @State-owned, .task-loaded.
// ---------------------------------------------------------------------------
import Foundation
import MobileData

/// Mirrors the webui QrLinkModal STATUS_POLL_MS cadence.
private let linkPollIntervalMs: Int64 = 2000
private let linkStateLinked = "linked"
private let dataUrlSeparator = ","

@MainActor
@Observable
final class DevicesViewModel {
    /// The Signal card's top-level state.
    enum SignalState: Equatable {
        case loading
        case linked(account: String?, since: String?)
        case unlinked
        case loadError
    }

    /// The in-flight link sub-flow (nested inside `.unlinked`).
    enum LinkPhase: Equatable {
        case idle
        case preparing
        case active(qr: Data)
        case failed(String)
    }

    private(set) var signal: SignalState = .loading
    private(set) var linkPhase: LinkPhase = .idle
    private(set) var isUnlinking = false

    private let devices: DevicesUseCases
    private let log = AppLog("settings", "devices-vm")
    /// Not observed: an internal task handle the nonisolated deinit cancels.
    @ObservationIgnored private var pollTask: Task<Void, Never>?

    init(devices: DevicesUseCases) {
        self.devices = devices
    }

    /// True while the link sheet should be presented.
    var isLinking: Bool { linkPhase != .idle }

    /// Load the current pairing state. Idempotent; safe on each `.task`.
    func load() async {
        do {
            let result = try await devices.getDevices()
            switch onEnum(of: result) {
            case .success(let s):
                let sig = s.data.platforms.signal
                signal = sig.paired ? .linked(account: sig.accountMasked, since: sig.linkedAt) : .unlinked
                log.info("devices.loaded paired=\(sig.paired)")
            case .failure(let f):
                signal = .loadError
                log.warn("devices.load.failed kind=\(f.error.kind.name)")
            case .loading:
                break
            }
        } catch is CancellationError {
        } catch {
            signal = .loadError
        }
    }

    /// Begin linking: request the QR, render it, and start polling for completion.
    func startLink() async {
        linkPhase = .preparing
        do {
            let result = try await devices.linkStart()
            switch onEnum(of: result) {
            case .success(let s):
                guard let qr = decodeDataUrl(s.data.qrDataUrl) else {
                    linkPhase = .failed("Couldn't render the linking code")
                    return
                }
                linkPhase = .active(qr: qr)
                log.info("link.started")
                startPolling()
            case .failure(let f):
                linkPhase = .failed(f.error.userMessage)
                log.warn("link.start.failed kind=\(f.error.kind.name)")
            case .loading:
                break
            }
        } catch is CancellationError {
            linkPhase = .idle
        } catch {
            linkPhase = .failed("Couldn't start linking")
        }
    }

    /// Cancel an in-flight link: stop polling, tell the gateway to drop the pairing,
    /// and reset to idle. Idempotent — safe from the Cancel button AND screen exit.
    func cancelLink() {
        guard linkPhase != .idle else { return }
        pollTask?.cancel()
        pollTask = nil
        linkPhase = .idle
        log.info("link.cancelled")
        Task { [devices] in _ = try? await devices.linkCancel() }
    }

    /// Unlink Signal (confirmed), then refetch the pairing state.
    func unlink() async {
        isUnlinking = true
        defer { isUnlinking = false }
        do {
            let result = try await devices.unlink()
            switch onEnum(of: result) {
            case .success:
                log.info("unlink.ok")
                await load()
            case .failure(let f):
                log.warn("unlink.failed kind=\(f.error.kind.name)")
            case .loading:
                break
            }
        } catch is CancellationError {
        } catch {
            log.warn("unlink.threw")
        }
    }

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            guard let self else { return }
            for await result in self.devices.pollLinkStatus(intervalMs: linkPollIntervalMs) {
                if Task.isCancelled { return }
                self.foldStatus(result)
            }
        }
    }

    private func foldStatus(_ result: SentientResult<SignalLinkStatusResponse>) {
        switch onEnum(of: result) {
        case .success(let s):
            if s.data.state == linkStateLinked {
                log.info("link.success")
                linkPhase = .idle
                Task { await load() }
            } else if let err = s.data.error {
                linkPhase = .failed(err)
                log.warn("link.status.error")
            }
        case .failure(let f):
            if !f.error.recoverable { linkPhase = .failed(f.error.userMessage) }
        case .loading:
            break
        }
    }

    /// Decode a `data:image/png;base64,…` URL to raw PNG bytes. Nil on any malformed input.
    private func decodeDataUrl(_ url: String) -> Data? {
        guard let commaIndex = url.firstIndex(of: Character(dataUrlSeparator)) else { return nil }
        let base64 = String(url[url.index(after: commaIndex)...])
        return Data(base64Encoded: base64)
    }

    deinit {
        pollTask?.cancel()
    }
}
