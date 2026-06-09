package io.sentient.mobilesdk.log

/** Log severity levels, mirroring web-sdk tagged logger shape. */
enum class LogLevel { DEBUG, INFO, WARN, ERROR }

/**
 * Platform-specific log sink. Each target provides an `actual` that routes to
 * the native log facility (android.util.Log on Android, NSLog on iOS).
 *
 * All messages MUST be pre-sanitized before reaching this function.
 */
expect fun platformLogSink(tag: String, level: LogLevel, message: String)
