import UIKit

// Opens the itms-services manifest URL → the OS downloads + installs over the
// existing app. Works only on UDID-registered devices (ad-hoc). Outbound open
// only; no inbound URL-scheme handler is needed.
@MainActor
enum UpdateInstaller {
    static func start(itmsUrl: String) {
        guard let url = URL(string: itmsUrl) else { return }
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
    }
}
