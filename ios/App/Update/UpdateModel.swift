// ---------------------------------------------------------------------------
// UpdateModel — the single, shared OTA-update state holder. Swift mirror of
// Android's UpdateViewModel.
//
// Holds ONE @Published UpdateStatus that three consumers observe:
//   - the force-update gate in UpdateGate (renders ForceUpdateView on mandatory),
//   - the optional banner in UpdateGate (Available && !mandatory),
//   - the Settings update row (status text + check / install action).
//
// Because all three must see the SAME status, the gate owns ONE instance
// (@StateObject in UpdateGate, the authed-scoped root) and passes it down — NOT a
// per-screen VM. It is built with the resolved gateway URL + the running bundle
// build, so a reconfigure (which exits → re-enters the authed branch) rebuilds it
// fresh with the new host.
//
// Thin by design: it delegates the manifest fetch to the shared UpdateChecker (B2,
// constructed via the iOS createUpdateChecker factory) and the install to the
// Swift UpdateInstaller (B6 — opens the itms-services URL). No transform lives here.
//
// SKIE bridges the suspend UpdateChecker.check() as `async throws`; the Kotlin
// body never throws (it returns a typed UpdateStatus.CheckFailed), so the catch is
// only the bridge's failure path. @MainActor: status mutates on the main actor.
// ---------------------------------------------------------------------------
import Foundation
import MobileData

@MainActor
final class UpdateModel: ObservableObject {
    /// Latest known update status. Starts UpToDate; no check runs until requested.
    @Published private(set) var status: UpdateStatus = UpdateStatusUpToDate.shared

    private let checker: UpdateChecker
    private let log = AppLog("update", "model")

    /// Build the checker from the resolved backend. `gatewayWsUrl` →
    /// `deriveHostRoot` (inside the factory) yields the gateway root the
    /// unauthenticated `/download/manifest.json` GET hangs off. The installed
    /// build/name come from the app bundle — the sole version source (no literal).
    init(gatewayWsUrl: String, allowSelfSignedDevHost: Bool) {
        checker = createUpdateChecker(
            gatewayWsUrl: gatewayWsUrl,
            allowSelfSignedDevHost: allowSelfSignedDevHost,
            installedBuild: Self.installedBuild,
            installedVersionName: Self.installedVersionName
        )
        log.info("init build=\(Self.installedBuild) version=\(Self.installedVersionName)")
    }

    /// Fetch the manifest and fold the result into `status`. Idempotent + safe to
    /// call repeatedly (cold start, foreground, Settings button).
    func check() async {
        log.info("check.start")
        do {
            let result = try await checker.check()
            status = result
            log.info("check.result status=\(Self.describe(result))")
        } catch {
            // The Kotlin check() returns CheckFailed rather than throwing; this is
            // only the SKIE suspend-bridge failure path. Keep the last known status.
            log.warn("check.threw reason=bridge")
        }
    }

    /// Hand the current iOS target to the installer. No-op unless the status is
    /// Available with an itms target.
    func install() {
        guard let available = status as? UpdateStatusAvailable else {
            log.warn("install.no-target")
            return
        }
        guard let target = available.target as? UpdateTargetIosItms else {
            log.warn("install.not-itms")
            return
        }
        log.info("install.start build=\(available.latestBuild)")
        UpdateInstaller.start(itmsUrl: target.itmsUrl)
    }

    // ── Bundle version (single source: Info.plist) ────────────────────────────

    /// The running build number from CFBundleVersion (matches the manifest's
    /// per-platform build). 0 if unreadable — a 0 build is always "below" a real
    /// release, so a bad read fails safe toward "update available", never silently
    /// up-to-date.
    private static var installedBuild: Int32 {
        let raw = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? ""
        return Int32(raw) ?? 0
    }

    private static var installedVersionName: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
    }

    /// A privacy-safe status tag for logs (no manifest content — type only).
    private static func describe(_ status: UpdateStatus) -> String {
        switch onEnum(of: status) {
        case .available(let a): return "available(mandatory=\(a.mandatory))"
        case .upToDate: return "up-to-date"
        case .checkFailed: return "check-failed"
        }
    }
}
