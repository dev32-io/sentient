import { getLog } from "../logging/logger.ts";

// ---------------------------------------------------------------------------
// PartialJsonFieldExtractor — pulls the growing value of a named string
// field out of a partial JSON object as it streams in.
//
// Required because OpenRouter / OpenAI streaming tool calls emit the
// function.arguments JSON as incremental string chunks. The speak effect
// needs the `text` field's value as a live text stream for the
// UtteranceAggregator — not the fully parsed object at stream end.
//
// Safe with arbitrary boundary points: the input is fed chunk-by-chunk
// and an escape sequence (\uXXXX, \n, \", etc.) may be split across
// chunks. `feed()` only emits characters it has fully resolved; partially
// scanned escape sequences wait for the next chunk.
// ---------------------------------------------------------------------------

const log = getLog(["sentient", "cerebrum", "partial-json-field-extractor"]);

export class PartialJsonFieldExtractor {
  private accum = "";
  private valueStart: number | null = null;
  private emitted = "";
  private terminated = false;

  constructor(private readonly fieldName: string) {
    log.debug("start", { fieldName });
  }

  /**
   * Append a JSON fragment. Returns the new characters of the target
   * field's string value that are now fully resolved (past any partial
   * escape sequences). Empty string if nothing new yet.
   */
  feed(chunk: string): string {
    if (this.terminated || chunk.length === 0) return "";
    this.accum += chunk;

    if (this.valueStart === null) {
      const start = locateFieldValueStart(this.accum, this.fieldName);
      if (start === null) return "";
      this.valueStart = start;
      log.debug("field-located", {
        fieldName: this.fieldName,
        valueStartIdx: start,
        accumChars: this.accum.length,
      });
    }

    const decoded = decodeJsonStringBody(this.accum, this.valueStart);
    if (decoded.terminated) this.terminated = true;

    if (decoded.value.length <= this.emitted.length) return "";
    const newPart = decoded.value.slice(this.emitted.length);
    this.emitted = decoded.value;
    log.debug("emit", {
      fieldName: this.fieldName,
      newChars: newPart.length,
      totalEmitted: this.emitted.length,
      terminated: this.terminated,
    });
    return newPart;
  }

  isTerminated(): boolean {
    return this.terminated;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Find the index of the first character inside the field's string value
 * (just after the opening quote). Returns null if the opening quote
 * hasn't arrived yet. Skips over other fields / whitespace / the colon.
 */
function locateFieldValueStart(accum: string, fieldName: string): number | null {
  const key = `"${fieldName}"`;
  const keyIdx = accum.indexOf(key);
  if (keyIdx === -1) return null;
  let i = keyIdx + key.length;
  // Skip whitespace + colon + whitespace
  while (i < accum.length && /\s/.test(accum[i] ?? "")) i++;
  if (i >= accum.length || accum[i] !== ":") return null;
  i++;
  while (i < accum.length && /\s/.test(accum[i] ?? "")) i++;
  if (i >= accum.length) return null;
  if (accum[i] !== '"') return null;
  return i + 1;
}

interface DecodeResult {
  readonly value: string;
  readonly terminated: boolean;
}

/**
 * Decode the contents of a JSON string starting at `start` (just after the
 * opening quote). Returns the decoded characters resolved so far AND
 * whether the closing unescaped quote has been seen. Partial/split escape
 * sequences at the end are left pending — decoding returns what was
 * resolved before the partial escape.
 */
function decodeJsonStringBody(s: string, start: number): DecodeResult {
  let out = "";
  let i = start;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') return { value: out, terminated: true };
    if (ch !== "\\") {
      out += ch;
      i++;
      continue;
    }
    const esc = s[i + 1];
    if (esc === undefined) return { value: out, terminated: false };
    switch (esc) {
      case '"':
        out += '"';
        i += 2;
        break;
      case "\\":
        out += "\\";
        i += 2;
        break;
      case "/":
        out += "/";
        i += 2;
        break;
      case "n":
        out += "\n";
        i += 2;
        break;
      case "t":
        out += "\t";
        i += 2;
        break;
      case "r":
        out += "\r";
        i += 2;
        break;
      case "b":
        out += "\b";
        i += 2;
        break;
      case "f":
        out += "\f";
        i += 2;
        break;
      case "u": {
        if (i + 6 > s.length) return { value: out, terminated: false };
        const hex = s.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          // Malformed; stop here and keep what we have.
          return { value: out, terminated: false };
        }
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 6;
        break;
      }
      default:
        out += esc;
        i += 2;
    }
  }
  return { value: out, terminated: false };
}
