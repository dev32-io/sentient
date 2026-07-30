const SENSITIVE_KEYS = /^(token|apikey|api_key|secret|password|authorization|pin|paseto)$/i;

const PASETO_PATTERN = /v4\.local\.\S+/g;
const BEARER_PATTERN = /Bearer \S+/g;
const TOKEN_PATTERN = /Token [0-9a-f]{8,}/gi;
const SENTIENT_AUTH_KEY_PATTERN = /sak_[A-Za-z0-9_-]{10,}/g;

/**
 * `<secret-ish key><sep><value>` inside a free-text blob — the shape a dumped
 * yaml/env config has. Needed because the key-NAME redaction in
 * `sanitizeValue` only sees a log property's own name: captured subprocess
 * output arrives under a neutral name like `preview`, so a credential inside
 * the text was previously logged verbatim. Truncating that preview bounds its
 * volume, not its content — a key at char 10 survives any cap.
 *
 * Groups: 1 = key, 2 = separator, 3 = opening quote (if any). The value is
 * dropped. Value stops at whitespace or a yaml/json terminator so the rest of
 * the line survives.
 */
const INLINE_SECRET_ASSIGNMENT =
  /\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd)\b(\s*[:=]\s*)(["']?)[^\s"',}\]]+/gi;

/**
 * Bare LLM-provider API keys, which carry a vendor prefix and no key name —
 * e.g. an OpenRouter `sk-or-v1-…` echoed in a 401 body. The list above covered
 * sentient's own auth shapes and missed this class entirely, which is exactly
 * what a delegated Hermes profile's credential looks like. The >=16-char tail
 * keeps short hyphenated identifiers (model names like `sk-tiny`) intact.
 */
const PROVIDER_API_KEY_PATTERN = /\b(?:sk|pk|hf|gsk|xai|rk)[-_][A-Za-z0-9_-]{16,}/g;

const REDACTED = "[REDACTED]";

/**
 * Redacts a value if the key matches a known sensitive key pattern.
 */
export function sanitizeValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEYS.test(key)) return REDACTED;
  return value;
}

/**
 * Scrubs PASETO tokens, Bearer tokens, sentient-auth keys, bare provider API
 * keys, and inline `key: value` secret assignments from a string.
 *
 * Order matters: the inline-assignment pass runs FIRST so a value it owns is
 * gone before the narrower shape patterns look at it, and so a quoted value is
 * dropped as one unit.
 */
export function sanitizeMessage(message: string): string {
  return message
    .replace(INLINE_SECRET_ASSIGNMENT, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`)
    .replace(PASETO_PATTERN, REDACTED)
    .replace(BEARER_PATTERN, REDACTED)
    .replace(TOKEN_PATTERN, REDACTED)
    .replace(SENTIENT_AUTH_KEY_PATTERN, REDACTED)
    .replace(PROVIDER_API_KEY_PATTERN, REDACTED);
}

/**
 * Returns a new properties object with sensitive keys redacted
 * and pattern-based scrubbing applied to string values.
 */
export function sanitizeProperties(props: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(props)) {
    const sanitized = sanitizeValue(key, value);
    result[key] = typeof sanitized === "string" ? sanitizeMessage(sanitized) : sanitized;
  }

  return result;
}
