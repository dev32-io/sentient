const SENSITIVE_KEYS = /^(token|apikey|api_key|secret|password|authorization|pin|paseto)$/i;

const PASETO_PATTERN = /v4\.local\.\S+/g;
const BEARER_PATTERN = /Bearer \S+/g;
const TOKEN_PATTERN = /Token [0-9a-f]{8,}/gi;
const SENTIENT_AUTH_KEY_PATTERN = /sak_[A-Za-z0-9_-]{10,}/g;

const REDACTED = "[REDACTED]";

/**
 * Redacts a value if the key matches a known sensitive key pattern.
 */
export function sanitizeValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEYS.test(key)) return REDACTED;
  return value;
}

/**
 * Scrubs PASETO tokens, Bearer tokens, and sentient-auth keys from a string.
 */
export function sanitizeMessage(message: string): string {
  return message
    .replace(PASETO_PATTERN, REDACTED)
    .replace(BEARER_PATTERN, REDACTED)
    .replace(TOKEN_PATTERN, REDACTED)
    .replace(SENTIENT_AUTH_KEY_PATTERN, REDACTED);
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
