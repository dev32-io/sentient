// ---------------------------------------------------------------------------
// VitalsHolder — app-lifetime owner of the single SentientMobileVitals facade.
//
// Swift mirror of Android's VitalsHolder (android/sdk/VitalsHolder.kt). One
// process-wide diagnostic facade, started ONCE in SentientApp.init and reused at
// every call site (background flush, Settings list/upload). Held as an app global
// (not in UserSession) on purpose: vitals must capture crashes from the EARLIEST
// point — before login, before any connection scope — and must survive
// logout→login.
//
// Init strategy (correctness of crash capture over auto-upload immediacy, matching
// Android): the file / ring / crash parts come up unconditionally at app start so a
// crash is captured from launch. The uploader is built ONLY when a backend is
// already configured (resolveBackend → .configured); if the backend is still
// unconfigured at first launch the uploader is nil and a prior crash simply
// auto-uploads on the next launch where a backend + token exist.
//
// The Ktor HttpClient, the app CoroutineScope, and the device id are built by
// iosMain Kotlin factories (createVitalsUploader / createVitalsAppScope /
// createVitalsDeviceId) — Swift cannot construct Ktor types or a CoroutineScope,
// exactly as createUserSession / createSessionsHttpClient already do.
//
// deviceId comes from the SAME DeviceIdProvider the SDK uses, so the vitals
// session header's deviceId matches the gateway's session.configure deviceId.
// userId is NOT available at app start (the persisted token is opaque PASETO), so
// it is passed nil per the task — matching Android.
// ---------------------------------------------------------------------------
import Foundation
import MobileData

/// App-lifetime holder for the single `SentientMobileVitals` facade. `start()`
/// runs once from `SentientApp.init`; everything else reads the already-built
/// instance. A reference type so the closures it installs (crash bridge) outlive
/// the call.
@MainActor
final class VitalsHolder {
    /// The process-wide singleton. Built lazily on first access (app init).
    static let shared = VitalsHolder()

    /// Process-wide diagnostic facade. The same instance at start / background / Settings.
    let vitals = SentientMobileVitals()

    private let log = AppLog("vitals", "holder")
    private var started = false

    // Held so the Settings VM can read a chosen session's body for upload without
    // re-resolving the platform/file plumbing. Same platform instance vitals writes through.
    private let platform = IosVitalsPlatform()

    private init() {}

    /// One-shot start. Crash capture + file rotation come up unconditionally; the
    /// uploader is built only if a backend is already configured. Safe to call
    /// before login. Idempotent.
    func start() {
        guard !started else { log.warn("start.duplicate"); return }
        started = true

        let deviceId = createVitalsDeviceId()
        let uploader = Self.buildUploaderOrNil(log: log)

        vitals.doInit(
            // createVitalsConfig applies the commonMain default tunables (ring/file
            // caps, keepFiles, sdkVersion) — Kotlin defaults don't cross the bridge,
            // so this keeps them in one place instead of restating magic numbers here.
            config: createVitalsConfig(
                appVersion: Self.bundleString("CFBundleShortVersionString"),
                build: Self.bundleString("CFBundleVersion")
            ),
            platform: platform,
            deviceId: deviceId,
            userId: nil, // not available at app start; see file header.
            nowMs: Self.nowMs(),
            network: NetworkProbe.current(),
            uploader: uploader,
            scope: createVitalsAppScope()
        )
        log.info("start uploader=\(uploader != nil) deviceId.len=\(deviceId.count)")

        // ObjC NSException → flush+mark synchronously in the dying process. The
        // IosVitalsPlatform.registerCrashHandler already wired the Kotlin/Native
        // terminal hook AND stashed onCrash on IosCrashBridge; this routes the
        // ObjC side into the SAME closure. NON-GOAL: native POSIX signal crashes
        // (SIGSEGV / SIGABRT) are NOT covered — only K/N throws + ObjC NSException.
        NSSetUncaughtExceptionHandler { _ in
            IosCrashBridge.shared.onCrash?()
        }
    }

    /// Forward app-background to flush the ring to the current session file.
    func onAppBackground() {
        guard started else { return }
        vitals.onAppBackground()
    }

    /// Newest-first vitals sessions (flushes the ring first).
    func listSessions() -> [VitalsSessionInfo] {
        vitals.listSessions()
    }

    /// Read a chosen session's file body for upload. Nil if missing/unreadable.
    /// Mirrors Android's `VitalsHolder.readSessionBody` (on the holder, not the facade).
    func readSessionBody(path: String) -> String? {
        platform.readFile(path: path)
    }

    // ── Uploader construction ─────────────────────────────────────────────────

    /// Best-effort uploader: built only when the backend resolves `.configured`.
    /// Uses the iosMain factory (Darwin engine + dev-TLS posture) over the resolved
    /// gateway URL + a token supplier off the same Keychain store the SDK reads.
    private static func buildUploaderOrNil(log: AppLog) -> VitalsUploader? {
        let resolved = resolveBackend(
            override: BackendConfigStore().load(),
            buildTimeDefaultURL: GatewayConfig.buildTimeDefaultWsURL,
            buildTimeAllowSelfSigned: GatewayConfig.buildTimeAllowSelfSigned
        )
        guard case let .configured(gatewayWsURL, allowSelfSigned) = resolved else {
            log.info("uploader.skip reason=backend-unconfigured")
            return nil
        }
        let tokenStore = createTokenStore()
        return createVitalsUploader(
            gatewayWsUrl: gatewayWsURL,
            allowSelfSignedDevHost: allowSelfSigned,
            token: { tokenStore.load() ?? "" }
        )
    }

    // ── Small helpers ─────────────────────────────────────────────────────────

    private static func bundleString(_ key: String) -> String {
        (Bundle.main.infoDictionary?[key] as? String) ?? ""
    }

    /// Wall-clock epoch-ms as the Int64 the facade expects.
    private static func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }
}
