import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "security", "text-normalizer"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NormalizationSignalKind =
  | "zero_width"
  | "tags_block"
  | "bidi_override"
  | "homoglyph_fold"
  | "base64_candidate"
  | "hex_candidate";

export interface NormalizationSignal {
  kind: NormalizationSignalKind;
  count: number;
}

export interface NormalizationResult {
  normalized: string;
  signals: NormalizationSignal[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Shortest base64 run that plausibly hides a directive. */
const MIN_BASE64_RUN_CHARS = 24;
/** Shortest hex run that plausibly hides a directive (16 bytes). */
const MIN_HEX_RUN_CHARS = 32;
/** Minimum fraction of printable ASCII a decoded candidate must contain to be surfaced. */
const MIN_PRINTABLE_ASCII_RATIO = 0.85;

// ---------------------------------------------------------------------------
// Character-class regexes (research grounding: spec §6.1)
// ---------------------------------------------------------------------------

/** Zero-width chars: U+200B-U+200D, U+FEFF, U+2060. */
// biome-ignore lint/suspicious/noMisleadingCharacterClass: matching the ZWJ/ZWNJ codepoints individually is the point \u2014 this strips invisible chars, it never matches grapheme clusters
const ZERO_WIDTH_CHARS = /[\u200B-\u200D\uFEFF\u2060]/gu;

/** Unicode Tags block: U+E0000-U+E007F — invisible-ASCII payload channel. */
const TAGS_BLOCK_CHARS = /[\u{E0000}-\u{E007F}]/gu;

/** Bidi override/isolate controls: U+202A-U+202E, U+2066-U+2069. */
const BIDI_OVERRIDE_CHARS = /[\u202A-\u202E\u2066-\u2069]/gu;

/**
 * Exported for skill-file lint (T4): zero-width + tags-block + bidi, combined.
 * Deliberately NOT `g`-flagged: a global-flagged regex advances `lastIndex`
 * across repeated `.test()` calls on a shared instance, silently returning
 * wrong results every other call. Callers that need repeated `.test()` (the
 * expected T4 usage) get correct, stateless behavior; module-internal strip
 * logic uses its own separately-scoped `g`-flagged regexes below instead of
 * this export.
 */
// biome-ignore lint/suspicious/noMisleadingCharacterClass: matching the ZWJ/ZWNJ codepoints individually is the point \u2014 this detects invisible chars, it never matches grapheme clusters
export const INVISIBLE_CHARS = /[\u200B-\u200D\uFEFF\u2060\u{E0000}-\u{E007F}\u202A-\u202E\u2066-\u2069]/u;

/** Candidate base64 run: 4-char alphabet, optional padding, at least MIN_BASE64_RUN_CHARS. */
const BASE64_RUN = new RegExp(`[A-Za-z0-9+/]{${MIN_BASE64_RUN_CHARS},}={0,2}`, "g");

/** Candidate hex run: paired hex digits, at least 16 bytes (MIN_HEX_RUN_CHARS chars). */
const HEX_RUN = /(?:[0-9a-f]{2}){16,}/gi;

// ---------------------------------------------------------------------------
// Confusables fold — curated Cyrillic/Greek lookalikes -> Latin (spec §6.1)
// ---------------------------------------------------------------------------

const CONFUSABLES_MAP: ReadonlyMap<string, string> = new Map([
  ["а", "a"],
  ["е", "e"],
  ["о", "o"],
  ["р", "p"],
  ["с", "c"],
  ["х", "x"],
  ["і", "i"],
  ["ѕ", "s"],
  ["А", "A"],
  ["Е", "E"],
  ["О", "O"],
  ["Р", "P"],
  ["С", "C"],
  ["Н", "H"],
  ["В", "B"],
  ["М", "M"],
  ["Т", "T"],
  ["к", "k"],
  ["у", "y"],
]);

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function stripAndCount(
  text: string,
  pattern: RegExp,
  kind: NormalizationSignalKind,
): {
  text: string;
  signal: NormalizationSignal | null;
} {
  const matches = text.match(pattern);
  if (!matches || matches.length === 0) {
    return { text, signal: null };
  }
  const stripped = text.replace(pattern, "");
  log.debug("stripped normalization signal", { kind, count: matches.length });
  return { text: stripped, signal: { kind, count: matches.length } };
}

function foldConfusables(text: string): { text: string; signal: NormalizationSignal | null } {
  let count = 0;
  let folded = "";
  for (const ch of text) {
    const replacement = CONFUSABLES_MAP.get(ch);
    if (replacement !== undefined) {
      folded += replacement;
      count += 1;
    } else {
      folded += ch;
    }
  }
  if (count === 0) {
    return { text, signal: null };
  }
  log.debug("stripped normalization signal", { kind: "homoglyph_fold", count });
  return { text: folded, signal: { kind: "homoglyph_fold", count } };
}

/** Fraction of chars in `s` that are printable ASCII (0x20-0x7E). */
function printableAsciiRatio(s: string): number {
  if (s.length === 0) {
    return 0;
  }
  let printable = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code >= 0x20 && code <= 0x7e) {
      printable += 1;
    }
  }
  return printable / s.length;
}

function decodeBase64Candidates(text: string): { appended: string; signal: NormalizationSignal | null } {
  const runs = text.match(BASE64_RUN);
  if (!runs || runs.length === 0) {
    return { appended: "", signal: null };
  }
  let appended = "";
  let decodedCount = 0;
  for (const run of runs) {
    let decoded: string;
    try {
      decoded = Buffer.from(run, "base64").toString("utf8");
    } catch (err: unknown) {
      log.debug("candidate failed to decode", {
        reason: "candidate failed to decode",
        kind: "base64_candidate",
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (decoded.length === 0 || printableAsciiRatio(decoded) < MIN_PRINTABLE_ASCII_RATIO) {
      continue;
    }
    appended += `\n[decoded] ${decoded}`;
    decodedCount += 1;
  }
  if (decodedCount === 0) {
    return { appended: "", signal: null };
  }
  log.debug("stripped normalization signal", { kind: "base64_candidate", count: decodedCount });
  return { appended, signal: { kind: "base64_candidate", count: decodedCount } };
}

function decodeHexCandidates(text: string): { appended: string; signal: NormalizationSignal | null } {
  const runs = text.match(HEX_RUN);
  if (!runs || runs.length === 0) {
    return { appended: "", signal: null };
  }
  let appended = "";
  let decodedCount = 0;
  for (const run of runs) {
    if (run.length < MIN_HEX_RUN_CHARS) {
      continue;
    }
    let decoded: string;
    try {
      decoded = Buffer.from(run, "hex").toString("utf8");
    } catch (err: unknown) {
      log.debug("candidate failed to decode", {
        reason: "candidate failed to decode",
        kind: "hex_candidate",
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (decoded.length === 0 || printableAsciiRatio(decoded) < MIN_PRINTABLE_ASCII_RATIO) {
      continue;
    }
    appended += `\n[decoded] ${decoded}`;
    decodedCount += 1;
  }
  if (decodedCount === 0) {
    return { appended: "", signal: null };
  }
  log.debug("stripped normalization signal", { kind: "hex_candidate", count: decodedCount });
  return { appended, signal: { kind: "hex_candidate", count: decodedCount } };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Normalizes text for injection scanning (Layer 0). Strips invisible-character
 * payload channels, folds curated homoglyphs, applies NFKC, and surfaces
 * decoded base64/hex runs so Layer 1's pattern matcher can see through them.
 *
 * Case folding is deliberately NOT performed here — Layer 1's patterns are
 * all case-insensitive (`/i`), which is the case fold; folding here would
 * corrupt the normalized text for any other consumer.
 */
export function normalizeForScan(text: string): NormalizationResult {
  const signals: NormalizationSignal[] = [];

  const tagsStripped = stripAndCount(text, TAGS_BLOCK_CHARS, "tags_block");
  if (tagsStripped.signal) {
    signals.push(tagsStripped.signal);
  }

  const zeroWidthStripped = stripAndCount(tagsStripped.text, ZERO_WIDTH_CHARS, "zero_width");
  if (zeroWidthStripped.signal) {
    signals.push(zeroWidthStripped.signal);
  }

  const bidiStripped = stripAndCount(zeroWidthStripped.text, BIDI_OVERRIDE_CHARS, "bidi_override");
  if (bidiStripped.signal) {
    signals.push(bidiStripped.signal);
  }

  const nfkc = bidiStripped.text.normalize("NFKC");

  const folded = foldConfusables(nfkc);
  if (folded.signal) {
    signals.push(folded.signal);
  }

  const base64 = decodeBase64Candidates(folded.text);
  if (base64.signal) {
    signals.push(base64.signal);
  }

  const hex = decodeHexCandidates(folded.text);
  if (hex.signal) {
    signals.push(hex.signal);
  }

  const normalized = folded.text + base64.appended + hex.appended;

  return { normalized, signals };
}
