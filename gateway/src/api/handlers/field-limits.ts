/**
 * Graceful field-length clamping for voice create/clone metadata.
 *
 * Over-length metadata — a long pasted description, an auto-imported Fish
 * blurb, too many tags — is TRUNCATED to fit rather than rejected. A cosmetic
 * overflow must never fail the whole create/clone (bad UX, and worse for
 * auto-imported values the user never typed). Structural problems (missing
 * required name, malformed body, wrong type) remain hard errors — only
 * max-length overflows truncate.
 *
 * Shared by voices-create-form.ts (multipart create) and fish-clone.ts (JSON
 * clone body) so both surfaces clamp identically.
 */

/** Clamp a string to `maxLen` chars. No-op when already within the cap. */
export function truncateField(value: string, maxLen: number): string {
  return value.length > maxLen ? value.slice(0, maxLen) : value;
}

/** Clamp a tag list: truncate each tag to `maxTagLen`, then cap the count to
 *  `maxTags`. Never rejects — over-long tags are trimmed and extras dropped. */
export function clampTags(tags: readonly string[], maxTags: number, maxTagLen: number): string[] {
  return tags.map((t) => truncateField(t, maxTagLen)).slice(0, maxTags);
}
