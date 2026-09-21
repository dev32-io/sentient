import Foundation
import MobileData

enum AttachmentImportSource: String, Hashable, Sendable {
    case files, photos, camera, mixed, unknown

    static func combined(_ items: [AttachmentImportItem]) -> Self {
        let sources = Set(items.map(\.source))
        return sources.count == 1 ? sources.first ?? .unknown : .mixed
    }
}

struct AttachmentImportRequest {
    let count: Int
    let source: AttachmentImportSource
    let prepare: () async throws -> [AttachmentImportItem]

    init(
        count: Int,
        source: AttachmentImportSource = .unknown,
        prepare: @escaping () async throws -> [AttachmentImportItem]
    ) {
        self.count = count
        self.source = source
        self.prepare = prepare
    }
}

struct AttachmentImportItem: Sendable {
    let url: URL
    let ownsTemporaryFile: Bool
    let displayName: String?
    let mediaType: String?
    let previewSourceURL: URL?
    let source: AttachmentImportSource

    static func file(_ url: URL) -> Self {
        Self(
            url: url,
            ownsTemporaryFile: false,
            displayName: nil,
            mediaType: nil,
            previewSourceURL: nil,
            source: .files
        )
    }

    static func temporary(
        _ url: URL,
        displayName: String? = nil,
        mediaType: String? = nil,
        previewSourceURL: URL? = nil,
        source: AttachmentImportSource = .unknown
    ) -> Self {
        Self(
            url: url,
            ownsTemporaryFile: true,
            displayName: displayName,
            mediaType: mediaType,
            previewSourceURL: previewSourceURL,
            source: source
        )
    }

    var ownedTemporaryURLs: Set<URL> {
        guard ownsTemporaryFile else { return [] }
        return Set([url, previewSourceURL].compactMap { $0 })
    }
}

func withAttachmentSecurityScope<T>(
    _ url: URL,
    operation: () async throws -> T
) async rethrows -> T {
    try await withAttachmentSecurityScope(
        url,
        start: { $0.startAccessingSecurityScopedResource() },
        stop: { $0.stopAccessingSecurityScopedResource() },
        operation: operation
    )
}

func withAttachmentSecurityScope<T>(
    _ url: URL,
    start: (URL) -> Bool,
    stop: (URL) -> Void,
    operation: () async throws -> T
) async rethrows -> T {
    let scoped = start(url)
    defer {
        if scoped { stop(url) }
    }
    return try await operation()
}

enum AttachmentImportPickerIssue: Error, Equatable, Sendable {
    case cameraDenied, cameraRestricted, cameraUnavailable, captureFailed, attachmentLimit
}

enum AttachmentImportFailureReason: String, Equatable, Sendable {
    case cancelled
    case unsupportedType = "unsupported_type"
    case unreadable
    case sourceMissing = "source_missing"
    case sourceTooLarge = "source_too_large"
    case localCopy = "local_copy"
    case conflict
    case timeout
    case denied
    case restricted
    case unavailable
    case captureFailed = "capture_failed"
    case limit
    case sendInProgress = "send_in_progress"
    case storageUnavailable = "storage_unavailable"
    case unknown
}

struct AttachmentImportAlert: Identifiable, Equatable, Sendable {
    let generation: Int
    let source: AttachmentImportSource
    let reason: AttachmentImportFailureReason

    var id: Int { generation }

    private var isPhoto: Bool {
        source == .photos || source == .camera
    }

    private var noun: String { isPhoto ? "photo" : "file" }
    private var label: String { isPhoto ? "Photo" : "File" }

    var title: String {
        switch reason {
        case .unsupportedType: "Unsupported \(label) format"
        case .unreadable: "Couldn't read \(noun)"
        case .sourceMissing: "\(label) unavailable"
        case .sourceTooLarge: "\(label) too large"
        case .denied: source == .camera ? "Camera access needed" : "\(label) access denied"
        case .restricted: "Camera access restricted"
        case .unavailable: "Camera unavailable"
        case .storageUnavailable: "Attachment storage unavailable"
        case .timeout: "Attachment import timed out"
        default: "Couldn't import \(noun)"
        }
    }

    var message: String {
        switch reason {
        case .unsupportedType:
            "\(label) format isn't supported. Choose a compatible \(noun) and try again."
        case .unreadable:
            "\(label) couldn't be read. Choose another \(noun) and try again."
        case .sourceMissing:
            "Selected \(noun) is no longer available. Choose it again and try again."
        case .sourceTooLarge:
            "\(label) is too large. Choose a smaller \(noun) and try again."
        case .localCopy:
            "\(label) couldn't be copied into draft storage. Try again."
        case .conflict:
            "Attachment changed while it was being imported. Try again."
        case .timeout:
            "\(label) took too long to prepare. Try again."
        case .denied:
            if source == .camera {
                "Camera access is denied. Allow camera access in Settings and try again."
            } else {
                "\(label) couldn't be accessed. Check permission and try again."
            }
        case .restricted:
            "Camera access is restricted. Try another attachment source."
        case .unavailable:
            "Camera is unavailable. Try another attachment source."
        case .captureFailed:
            "Photo couldn't be captured. Try again."
        case .limit:
            "Remove an attachment before adding another."
        case .sendInProgress:
            "Wait for current upload to finish before adding files."
        case .storageUnavailable:
            "Attachment storage is unavailable. Try again."
        case .unknown:
            "\(label) couldn't be imported. Try again."
        case .cancelled:
            ""
        }
    }
}

func isUserCancelledAttachmentImport(_ error: Error) -> Bool {
    if error is CancellationError || (error as? URLError)?.code == .cancelled { return true }
    let nsError = error as NSError
    return nsError.domain == NSCocoaErrorDomain &&
        nsError.code == CocoaError.Code.userCancelled.rawValue
}

func attachmentImportFailureReason(forKotlinException kotlin: Any?) -> AttachmentImportFailureReason? {
    guard let kotlin else { return nil }
    if kotlin is IosNativeDraftStorageException { return .storageUnavailable }
    if kotlin is NativeDraftSourceTooLargeException { return .sourceTooLarge }
    if kotlin is NativeDraftConflictException ||
        kotlin is NativeDraftDiscardedException ||
        kotlin is NativePendingSendConflictException ||
        kotlin is NativeConversationPendingDeleteException {
        return .conflict
    }
    if let request = kotlin as? AttachmentRequestException {
        switch request.code {
        case "timeout": return .timeout
        case "local_file_error": return .localCopy
        case "conflict", "draft_conflict": return .conflict
        case "source_too_large": return .sourceTooLarge
        default: return .unknown
        }
    }
    return nil
}

/// Returns only stable, allowlisted diagnostics. Never expose NSError descriptions,
/// domains, URLs, picker names, or shared error codes directly to logs.
func attachmentImportFailureReason(for error: Error?) -> AttachmentImportFailureReason {
    guard let error else { return .unknown }
    if isUserCancelledAttachmentImport(error) { return .cancelled }
    if let issue = error as? AttachmentImportPickerIssue {
        switch issue {
        case .cameraDenied: return .denied
        case .cameraRestricted: return .restricted
        case .cameraUnavailable: return .unavailable
        case .captureFailed: return .captureFailed
        case .attachmentLimit: return .limit
        }
    }
    if let urlError = error as? URLError {
        switch urlError.code {
        case .timedOut: return .timeout
        case .fileDoesNotExist, .cannotOpenFile, .badURL: return .sourceMissing
        case .cancelled: return .cancelled
        default: return .localCopy
        }
    }

    let nsError = error as NSError
    if let reason = attachmentImportFailureReason(forKotlinException: nsError.kotlinException) {
        return reason
    }

    if nsError.domain == NSItemProvider.errorDomain {
        switch NSItemProvider.ErrorCode(rawValue: nsError.code) {
        case .itemUnavailableError: return .sourceMissing
        case .unexpectedValueClassError, .unavailableCoercionError: return .unsupportedType
        case .unknownError: return .unreadable
        default: return .localCopy
        }
    }
    guard nsError.domain == NSCocoaErrorDomain else { return .unknown }
    switch CocoaError.Code(rawValue: nsError.code) {
    case .fileReadUnsupportedScheme: return .unsupportedType
    case .fileNoSuchFile: return .sourceMissing
    case .fileReadTooLarge: return .sourceTooLarge
    case .fileReadNoPermission, .fileWriteNoPermission: return .denied
    case .fileReadUnknown, .fileReadCorruptFile: return .unreadable
    case .fileWriteOutOfSpace: return .storageUnavailable
    case .fileWriteUnknown: return .localCopy
    case .userCancelled: return .cancelled
    default: return .unknown
    }
}

enum AttachmentImportPolicy {
    // Client contract matches shipped gateway default. Server remains authoritative
    // when operators configure a different limit.
    static let maximumPerMessage = 8

    static func remaining(existing: Int, pending: Int) -> Int {
        max(0, maximumPerMessage - existing - pending)
    }

    static func accepts(selectionCount: Int, existing: Int, pending: Int) -> Bool {
        selectionCount <= remaining(existing: existing, pending: pending)
    }
}

@MainActor
final class DraftMutationBarrier {
    private var tail: Task<Void, Never>?
    private var tasks: [UUID: Task<Void, Never>] = [:]

    func enqueue(_ operation: @escaping @MainActor () async -> Void) {
        let id = UUID()
        let previous = tail
        let task = Task { @MainActor [weak self] in
            if let previous { await previous.value }
            await operation()
            self?.tasks[id] = nil
        }
        tasks[id] = task
        tail = task
    }

    func perform<T>(_ operation: @escaping @MainActor () async throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<T, Error>) in
            enqueue {
                do {
                    continuation.resume(returning: try await operation())
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    func cancelAll() {
        tasks.values.forEach { $0.cancel() }
    }
}

func withAttachmentImportCleanup<T>(
    _ items: [AttachmentImportItem],
    operation: () async throws -> T
) async throws -> T {
    defer {
        for url in Set(items.flatMap(\.ownedTemporaryURLs)) {
            try? FileManager.default.removeItem(at: url)
        }
    }
    return try await operation()
}
