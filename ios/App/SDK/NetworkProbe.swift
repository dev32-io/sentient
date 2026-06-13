// ---------------------------------------------------------------------------
// NetworkProbe — one-shot active-transport label for the vitals session header.
//
// Swift mirror of Android's NetworkType.currentNetwork (sdk/NetworkType.kt): returns
// one of "wifi" | "cellular" | "none" (matching SessionMeta.network's documented
// vocabulary), or "unknown" when the path can't be read in the short snapshot window.
//
// NWPathMonitor delivers its first path asynchronously on a queue, so a synchronous
// one-shot read snapshots the first update with a bounded wait (never blocks init for
// more than the timeout). Best-effort; never throws.
// ---------------------------------------------------------------------------
import Foundation
import Network

enum NetworkProbe {
    private static let wifi = "wifi"
    private static let cellular = "cellular"
    private static let none = "none"
    private static let unknown = "unknown"
    /// Bounded wait for the monitor's first path update — keeps init non-blocking.
    private static let snapshotTimeout: DispatchTimeInterval = .milliseconds(150)

    /// The active transport at the moment of capture. Best-effort; never throws.
    static func current() -> String {
        let monitor = NWPathMonitor()
        let queue = DispatchQueue(label: "io.sentient.app.netprobe")
        let gate = DispatchSemaphore(value: 0)
        // nonisolated mutable box read after the semaphore — the handler writes once
        // before signalling, so there is no concurrent access.
        let box = PathBox()

        monitor.pathUpdateHandler = { path in
            box.label = label(for: path)
            gate.signal()
        }
        monitor.start(queue: queue)
        defer { monitor.cancel() }

        _ = gate.wait(timeout: .now() + snapshotTimeout)
        return box.label
    }

    private static func label(for path: NWPath) -> String {
        guard path.status == .satisfied else { return none }
        if path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet) { return wifi }
        if path.usesInterfaceType(.cellular) { return cellular }
        return unknown
    }

    /// Single-write box for the path label captured by the monitor handler.
    private final class PathBox: @unchecked Sendable {
        var label = unknown
    }
}
