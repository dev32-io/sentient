// ---------------------------------------------------------------------------
// Log — thin os.Logger wrapper for the iOS app shell.
//
// The SDK owns its own structured logger (createLogger) for everything inside
// the transport / FSM / connectors. From Swift that logger is NOT ergonomic:
// SKIE exposes `createLogger(tags: KotlinArray<NSString>)` and a `Log` protocol
// whose `info(message:props:)` requires building an NSDictionary per call with
// no default for `props`. The ios rules permit a thin os_log wrapper when the
// SDK logger is awkward from Swift (no bare print/NSLog in shipped code), so the
// app shell logs through this. Tags mirror the SDK's hierarchy convention
// (["sentient", "ios", ...]) so app and SDK log lines read consistently.
// ---------------------------------------------------------------------------
import os

/// Tagged logger for the iOS app shell. Wraps `os.Logger` with a hierarchical
/// category so app-side lifecycle/state lines match the SDK's tag shape.
struct AppLog {
    private let logger: os.Logger

    /// Build a logger whose category is the dot-joined tag path under the
    /// shared root, e.g. `tags("sdk", "store")` → category `sentient.ios.sdk.store`.
    init(_ tags: String...) {
        let category = (["sentient", "ios"] + tags).joined(separator: ".")
        self.logger = os.Logger(subsystem: "io.sentient.app", category: category)
    }

    func debug(_ message: String) { logger.debug("\(sanitize(message), privacy: .public)") }
    func info(_ message: String) { logger.info("\(sanitize(message), privacy: .public)") }
    func warn(_ message: String) { logger.warning("\(sanitize(message), privacy: .public)") }
    func error(_ message: String) { logger.error("\(sanitize(message), privacy: .public)") }

    /// App-side logs do not pass through the Kotlin sanitizer. Remove endpoint
    /// material and all free-form reason/error fields before os_log emission.
    private func sanitize(_ message: String) -> String {
        var value = message
        let patterns = [
            #"(?i)\b(?:https?|wss?)://[^\s]+"#,
            #"(?i)(reason|error|host|url)=.*$"#,
        ]
        for pattern in patterns {
            value = value.replacingOccurrences(
                of: pattern,
                with: "[redacted]",
                options: .regularExpression
            )
        }
        return value
    }
}
