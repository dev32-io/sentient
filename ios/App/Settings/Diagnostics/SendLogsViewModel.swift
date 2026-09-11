// ---------------------------------------------------------------------------
// SendLogsViewModel — the command surface for the Settings "Send diagnostic log"
// section. Swift mirror of Android's SettingsViewModel diagnostics half.
//
// Loads the vitals sessions on appear, uploads a chosen one, and surfaces
// per-upload progress + a terminal ref/error outcome. The vitals facade owns the
// authenticated POST; this VM drives it and folds the result into published state
// the row binds to (button → progress bar → result line).
//
// @MainActor at class level (UI-bound state). The upload runs as a Task whose
// onProgress callback hops back to the main actor to publish progress.
// ---------------------------------------------------------------------------
import Foundation
import MobileData

/// Terminal upload outcome surfaced on a row, or nil while idle / in-flight.
enum DiagnosticsLoadPhase: Equatable {
    case loading
    case ready
    case failed
}

enum UploadOutcome: Equatable {
    /// Uploaded; `ref` is the server ref ("" when the upload succeeded but no ref parsed).
    case sent(ref: String)
    /// Upload failed (transport error / non-2xx / missing body). Offer a retry.
    case failed
}

@MainActor
final class SendLogsViewModel: ObservableObject {
    /// Newest-first vitals sessions; empty until `load()` runs.
    @Published private(set) var sessions: [VitalsSessionInfo] = []
    @Published private(set) var loadPhase: DiagnosticsLoadPhase = .loading
    /// The path being uploaded, or nil when idle. Drives which row morphs.
    @Published private(set) var uploadingPath: String?
    /// Upload progress in 0...1; nil = idle / done. The row shows a bar while non-nil.
    @Published private(set) var progress: Double?
    /// Terminal outcome (ref or failure) for `uploadingPath`; nil until an upload completes.
    @Published private(set) var outcome: UploadOutcome?

    private let holder: VitalsHolder
    private let log = AppLog("settings", "send-logs-vm")
    private var uploadTask: Task<Void, Never>?

    init(holder: VitalsHolder = .shared, initialLoadPhase: DiagnosticsLoadPhase = .loading) {
        self.holder = holder
        loadPhase = initialLoadPhase
    }

    /// Load the session list (newest-first). Idempotent; safe to call on each appear.
    /// Runs the flush + file reads off the main thread; assigns back on MainActor.
    func load() async {
        loadPhase = .loading
        let result = await Task.detached(priority: .utility) { [holder] in
            holder.listSessions()
        }.value
        guard !Task.isCancelled else { return }
        sessions = result // back on MainActor after await
        loadPhase = .ready
        log.info("load count=\(result.count)")
    }

    /// Upload the session at `path`. Drives `progress` during the POST and sets
    /// `outcome` on completion. A missing / unreadable body is a `.failed` outcome
    /// (never throws). Cancels any in-flight upload before starting a new one.
    func upload(path: String) {
        uploadTask?.cancel()
        let fileName = (path as NSString).lastPathComponent
        uploadingPath = path
        outcome = nil
        progress = 0
        log.info("upload.start file=\(fileName)")

        uploadTask = Task { [weak self] in
            guard let self else { return }
            // Read the session file off the main actor before the network await.
            let body = await Task.detached(priority: .utility) { [holder = self.holder] in
                holder.readSessionBody(path: path)
            }.value
            guard let body else {
                self.log.warn("upload.no-body file=\(fileName)")
                self.finish(.failed)
                return
            }
            // The facade's upload throws only on CancellationException; treat any
            // throw or a nil ref as a failed outcome (no retry-on-success contract).
            let ref = try? await self.holder.vitals.upload(
                fileName: fileName,
                body: body,
                onProgress: { [weak self] value in
                    let p = value.doubleValue
                    Task { @MainActor in self?.progress = p }
                }
            )
            self.log.info("upload.done file=\(fileName) ok=\(ref != nil)")
            // `try? await … -> String?` yields String??; flatten then map to the outcome.
            let parsed: String? = ref.flatMap { $0 }
            self.finish(parsed.map { UploadOutcome.sent(ref: sanitizedDiagnosticsReference($0)) } ?? .failed)
        }
    }

    private func finish(_ result: UploadOutcome) {
        progress = nil
        outcome = result
    }
}

/// Recovery references are identifiers, not free-form server copy. Keep only a
/// short, conservative identifier alphabet before presenting them in Diagnostics.
func sanitizedDiagnosticsReference(_ reference: String) -> String {
    String(reference.unicodeScalars.lazy.filter {
        CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_"
    }.prefix(32).map(Character.init))
}
