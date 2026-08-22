// ---------------------------------------------------------------------------
// LocalNetworkPrimer — surfaces the iOS Local Network permission prompt early.
//
// iOS fires the Local Network dialog on the FIRST local-network connection. In
// this app that first connection is the backend-setup probe (listUsers against
// the LAN host), so that probe fails before the user can tap "Allow". Merely
// *starting* a Bonjour browse triggers the same prompt without needing the
// user's host — so the setup view starts one on appear to resolve the prompt
// before the user taps Connect. Best-effort: it exists only to raise the prompt,
// so browser errors are logged and ignored.
// ---------------------------------------------------------------------------
import Network

/// Service type for the throwaway browse. Any local service type triggers the
/// Local Network prompt; `_http._tcp` is the most generic.
private let primerBonjourType = "_http._tcp"
/// How long to keep the browse alive before cancelling, in seconds. Long enough
/// for the system to raise the prompt, short enough to leave no lingering radio.
private let primerTimeoutSeconds: UInt64 = 3

/// Starts a short-lived Bonjour browse to surface the iOS Local Network prompt,
/// then self-cancels. Cancel manually via `cancel()` on view disappear.
@MainActor
final class LocalNetworkPrimer {
    private var browser: NWBrowser?
    private var timeoutTask: Task<Void, Never>?
    private let log = AppLog("backend", "lan-primer")

    /// Begin the browse. No-op if already running. Auto-cancels after the timeout.
    func start() {
        guard browser == nil else { return }
        let descriptor = NWBrowser.Descriptor.bonjour(type: primerBonjourType, domain: nil)
        let newBrowser = NWBrowser(for: descriptor, using: .init())
        newBrowser.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.log.info("primer.ready")
            case let .failed(error):
                self?.log.warn("primer.failed code=network")
            case let .waiting(error):
                self?.log.warn("primer.waiting code=network")
            default:
                break
            }
        }
        log.info("primer.start type=\(primerBonjourType) timeout=\(primerTimeoutSeconds)s")
        newBrowser.start(queue: .main)
        browser = newBrowser
        timeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: primerTimeoutSeconds * 1_000_000_000)
            self?.cancel()
        }
    }

    /// Stop the browse and release it. Safe to call multiple times.
    func cancel() {
        timeoutTask?.cancel()
        timeoutTask = nil
        guard let browser else { return }
        log.info("primer.cancel")
        browser.cancel()
        self.browser = nil
    }
}
