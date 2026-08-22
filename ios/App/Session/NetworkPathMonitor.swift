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

protocol NetworkPathMonitoring: AnyObject {
    func start()
    func cancel()
}

struct NetworkPathMonitorFactory {
    let make: (@escaping @Sendable (_ recovered: Bool) -> Void) -> any NetworkPathMonitoring

    static let live = NetworkPathMonitorFactory { NetworkPathMonitor(onChange: $0) }
}

struct ConnectivityRecoveryEdge {
    private var available: Bool?

    mutating func update(available: Bool) -> (changed: Bool, recovered: Bool) {
        defer { self.available = available }
        guard let previous = self.available, previous != available else {
            return (changed: false, recovered: false)
        }
        return (changed: true, recovered: !previous && available)
    }
}

final class NetworkPathMonitor: NetworkPathMonitoring, @unchecked Sendable {
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "io.sentient.app.net-path-monitor")
    private let onChange: @Sendable (_ recovered: Bool) -> Void
    private let log = AppLog("net-path-monitor")
    /// Single-writer on the monitor queue; the initial snapshot is ignored.
    private var recoveryEdge = ConnectivityRecoveryEdge()
    private var sawFirstPath = false
    /// Main-actor-confined (set only from start/cancel, called by UserSession on MainActor).
    private var started = false

    init(onChange: @escaping @Sendable (_ recovered: Bool) -> Void) {
        self.onChange = onChange
    }

    func start() {
        if started { return }
        started = true
        log.info("start")
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            let available = path.status == .satisfied
            let status = available ? "satisfied" : "unsatisfied"
            let transition = self.recoveryEdge.update(available: available)
            guard self.sawFirstPath else {
                self.sawFirstPath = true
                self.log.info("path-snapshot status=\(status) (skip)")
                return
            }
            self.log.info("path-changed status=\(status)")
            self.onChange(transition.recovered)
        }
        monitor.start(queue: queue)
    }

    func cancel() {
        log.info("cancel")
        monitor.cancel()
        started = false
    }
}
