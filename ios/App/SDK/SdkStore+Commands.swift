// ---------------------------------------------------------------------------
// SdkStore+Commands — connection, session-lifecycle, mic, and TTS commands.
//
// Fire-and-forget ops (interrupt, mic toggles) are plain calls — the SDK
// launches their own work on its own scope internally. Async ops (connect,
// setTtsEnabled) are wrapped in Task and errors are logged, not propagated,
// because callers are SwiftUI views with no error-recovery path.
// ---------------------------------------------------------------------------
import MobileSdk

extension SdkStore {
    func connect() {
        guard let sdk else { return }
        log.info("connect")
        Task { [weak self] in
            do { try await sdk.connect() } catch { self?.log.error("connect failed: \(error)") }
        }
    }

    func disconnect() {
        guard let sdk else { return }
        log.info("disconnect")
        // Consumer-initiated teardown clears the session (gate → login). SKIE does
        // not bridge the Kotlin default arg, so clearSession is passed explicitly.
        sdk.disconnect(clearSession: true)
    }

    /// Manual reconnect (web-sdk parity, sentient-sdk.ts forceReconnect()). Re-arms
    /// the reconnect controller, clears the terminal connectionLost/authExpired
    /// flags, and drives a fresh recovery loop. Wired to the connection-lost
    /// banner's tap-to-reconnect CTA. Idempotent — a no-op while a loop is already
    /// in flight (status RECONNECTING).
    func forceReconnect() {
        guard let sdk else { return }
        log.info("forceReconnect status=\(state.status.name)")
        sdk.forceReconnect()
    }

    /// Logs the user out: disconnect (WS teardown + cycle cancel) THEN clear the
    /// persisted token. Inverse of login (`save(token:)` → `connect()`), so we
    /// disconnect first — the SDK can't read a half-cleared store mid-teardown.
    /// Clearing the token is what prevents auto-resume on relaunch. Navigation
    /// back to login is NOT modelled here: RootView derives login-vs-chat from
    /// the SDK's single state surface (hasSession == false ⇒ login), and the
    /// default disconnect() (logout teardown) clears hasSession. Mirrors Android
    /// SettingsViewModel.logout().
    /// Idempotent — both calls are safe when already logged out.
    func logout() {
        log.info("logout.start")
        sdk?.disconnect(clearSession: true)
        tokenStore.clear()
        log.info("logout.done")
    }

    func interrupt() {
        guard let sdk else { return }
        log.info("interrupt")
        sdk.interrupt()
    }

    func startMic() {
        guard let sdk else { return }
        log.info("startMic")
        sdk.startMic()
    }

    func stopMic() {
        guard let sdk else { return }
        log.info("stopMic")
        sdk.stopMic()
    }

    func setTtsEnabled(_ enabled: Bool) {
        guard let sdk else { return }
        log.info("setTtsEnabled enabled=\(enabled)")
        Task { [weak self] in
            do {
                try await sdk.setTtsEnabled(enabled: enabled)
            } catch {
                self?.log.error("setTtsEnabled failed: \(error)")
            }
        }
    }
}
