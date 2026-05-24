/**
 * Streaming sentence splitter for LLM output → TTS pipeline.
 * Yields complete sentences as soon as a boundary is detected.
 * Handles abbreviations, ellipsis, and numeric decimals.
 */

// Common abbreviations that end with a period but aren't sentence boundaries
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'ave', 'blvd',
  'vs', 'etc', 'inc', 'ltd', 'dept', 'est', 'approx', 'fig', 'vol',
  'no', 'e.g', 'i.e', 'a.m', 'p.m',
]);

interface SplitResult {
  complete: string[];
  remainder: string;
}

export function extractCompleteSentences(buffer: string): SplitResult {
  const complete: string[] = [];
  let pos = 0;

  while (pos < buffer.length) {
    // Find next sentence-ending punctuation
    const match = findSentenceEnd(buffer, pos);
    if (match === -1) break;

    const sentence = buffer.slice(pos, match + 1).trim();
    if (sentence.length > 0) {
      complete.push(sentence);
    }
    pos = match + 1;

    // Skip whitespace after sentence boundary
    while (pos < buffer.length && buffer[pos] === ' ') pos++;
  }

  return {
    complete,
    remainder: buffer.slice(pos),
  };
}

function findSentenceEnd(buffer: string, start: number): number {
  for (let i = start; i < buffer.length; i++) {
    const ch = buffer[i];

    // Period — check for abbreviations and decimals
    if (ch === '.') {
      // Ellipsis: skip "..."
      if (buffer[i + 1] === '.' || (i > 0 && buffer[i - 1] === '.')) continue;

      // Decimal number: "3.14"
      if (i > 0 && /\d/.test(buffer[i - 1]) && i + 1 < buffer.length && /\d/.test(buffer[i + 1])) continue;

      // Abbreviation: "Dr." — check word before period
      const wordStart = findWordStart(buffer, i - 1);
      const word = buffer.slice(wordStart, i).toLowerCase();
      if (ABBREVIATIONS.has(word)) continue;

      // Need to see whitespace + uppercase (or end of buffer with enough content) to confirm sentence end
      const afterPeriod = i + 1;
      if (afterPeriod >= buffer.length) {
        // At end of buffer — don't split yet, might get more text
        continue;
      }
      // Whitespace after period followed by uppercase or end = sentence
      if (buffer[afterPeriod] === ' ') {
        if (afterPeriod + 1 < buffer.length) {
          const nextChar = buffer[afterPeriod + 1];
          if (nextChar === nextChar.toUpperCase() && /[A-Z]/.test(nextChar)) {
            return i;
          }
          // Lowercase after period+space — might be abbreviation context, skip
          continue;
        }
        // Space at end of buffer — ambiguous, wait for more
        continue;
      }
      continue;
    }

    // Question mark and exclamation point — clear sentence boundaries
    if (ch === '?' || ch === '!') {
      // Skip "?!" or "!!" chains
      while (i + 1 < buffer.length && (buffer[i + 1] === '?' || buffer[i + 1] === '!')) i++;
      return i;
    }

    // Newline — treat as sentence boundary if there's content
    if (ch === '\n') {
      const before = buffer.slice(start, i).trim();
      if (before.length > 0) return i;
    }
  }

  return -1;
}

function findWordStart(buffer: string, end: number): number {
  let i = end;
  while (i >= 0 && /[a-zA-Z.]/.test(buffer[i])) i--;
  return i + 1;
}

/**
 * Streaming sentence splitter as an AsyncGenerator.
 * Takes LLM token stream, yields complete sentences.
 */
export async function* sentenceSplit(
  llmStream: AsyncGenerator<{ text: string }>,
): AsyncGenerator<string> {
  let buffer = '';

  for await (const chunk of llmStream) {
    buffer += chunk.text;
    const result = extractCompleteSentences(buffer);

    for (const sentence of result.complete) {
      yield sentence;
    }
    buffer = result.remainder;
  }

  // Flush any remaining text as final sentence
  const trimmed = buffer.trim();
  if (trimmed) yield trimmed;
}
