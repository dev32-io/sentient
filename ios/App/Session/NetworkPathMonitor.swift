// ---------------------------------------------------------------------------
// NetworkPathMonitor — persistent NWPathMonitor that fires `onChange` whenever the
// active network path changes (e.g. VPN→WiFi, WiFi→cellular, satisfied↔unsatisfied).
//
// Why: when the path changes under a half-open socket the OS keeps the TCP socket
// nominally "open", so the SDK sits at READY on a dead socket and a queued send is
// stuck on "Retry". This observer notifies the session so it can probe/reconnect.
// The FIRST path callback (the path at startup) is skipped — the SDK is already
// connecting; only a genuine change warrants a re-check.
// ---------------------------------------------------------------------------
import Foundation
import Network

final class NetworkPathMonitor: @unchecked Sendable {
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "io.sentient.app.net-path-monitor")
    private let onChange: @Sendable () -> Void
    private let log = AppLog("net-path-monitor")
    /// Single-writer (the monitor queue) flag: skip the initial path snapshot.
    private var sawFirstPath = false
    /// Main-actor-confined (set only from start/cancel, called by UserSession on MainActor).
    private var started = false

    init(onChange: @escaping @Sendable () -> Void) {
        self.onChange = onChange
    }

    func start() {
        if started { return }
        started = true
        log.info("start")
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            let status = path.status == .satisfied ? "satisfied" : "unsatisfied"
            if !self.sawFirstPath {
                self.sawFirstPath = true
                self.log.info("initial-path status=\(status) (skip)")
                return
            }
            self.log.info("path-changed → ensureConnected status=\(status)")
            self.onChange()
        }
        monitor.start(queue: queue)
    }

    func cancel() {
        log.info("cancel")
        monitor.cancel()
        started = false
    }
}
