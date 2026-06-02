package io.sentient.mobilesdk.log

/**
 * Log sanitizer — mirrors gateway/src/logging/log-sanitizer.ts intent.
 *
 * Patterns covered (v1):
 *   PASETO v4.local.* and v4.public.* — session auth tokens
 *   Bearer <token>                    — HTTP Authorization header values
 *   sak_<key>                         — sentient-auth service-auth keys
 *
 * Preview truncation caps at MAX_PREVIEW chars to avoid raw buffer dumps in logs.
 */

private val PASETO = Regex("""v4\.(local|public)\.[A-Za-z0-9_\-]+""")
private val BEARER = Regex("""(?i)bearer\s+[A-Za-z0-9._\-]+""")
private val SENTIENT_AUTH_KEY = Regex("""sak_[A-Za-z0-9_\-]{10,}""")

private const val REDACTED = "[redacted]"

/** Maximum string preview length before truncation. */
const val MAX_PREVIEW = 120

/**
 * Scrubs known secret patterns from [s].
 * Safe to call on any log message before emission.
 */
fun sanitizeLog(s: String): String =
    s.replace(PASETO, REDACTED)
        .replace(BEARER, REDACTED)
        .replace(SENTIENT_AUTH_KEY, REDACTED)

/**
 * Truncates [s] to [MAX_PREVIEW] chars, appending an ellipsis if cut.
 * Keeps log line sizes bounded per the logging rule (≤120 chars for previews).
 */
fun truncatePreview(s: String): String =
    if (s.length <= MAX_PREVIEW) s else s.take(MAX_PREVIEW) + "…"
