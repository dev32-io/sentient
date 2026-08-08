import { getLog } from "../logging/logger.js";
import { normalizeForScan } from "./text-normalizer.js";

const log = getLog(["sentient", "security", "injection-scanner"]);

// ---------------------------------------------------------------------------
// Types (contract — see fixtures/injection-corpus.ts for the frozen category
// set; InjectionCategory here MUST match those eight literals exactly).
// ---------------------------------------------------------------------------

export type ScanChannel = "tool_result" | "background_completion" | "skill_body" | "delegation_prompt";

export interface ScanProvenance {
  channel: ScanChannel;
  /** Tool / server / skill / agent name the content came from. */
  source: string;
}

export type ScanSeverity = "notice" | "suspicious" | "hostile";

export type InjectionCategory =
  | "instruction_override"
  | "role_manipulation"
  | "prompt_leak"
  | "jailbreak"
  | "exfiltration"
  | "context_manipulation"
  | "encoding_obfuscation"
  | "tool_envelope";

export type ScanLayer = "normalization" | "pattern" | "structural";

export interface ScanFinding {
  category: InjectionCategory;
  severity: ScanSeverity;
  match: string;
  layer: ScanLayer;
}

export interface ScanResult {
  findings: ScanFinding[];
  maxSeverity: ScanSeverity | null;
  /** Original text with structural tool-envelope matches removed. Pattern and
   *  normalization findings never mutate this — the model must still see the
   *  real content; only the never-legitimate envelope class is stripped. */
  sanitizedText: string;
}

// ---------------------------------------------------------------------------
// Severity constants
// ---------------------------------------------------------------------------

const SEVERITY_STRUCTURAL: ScanSeverity = "hostile";
const SEVERITY_PATTERN: ScanSeverity = "suspicious";
const SEVERITY_NORMALIZATION: ScanSeverity = "notice";

const SEVERITY_RANK: Record<ScanSeverity, number> = {
  notice: 1,
  suspicious: 2,
  hostile: 3,
};

/** Max characters preserved in a finding's `match` preview (logging rule: ≤120). */
const MATCH_PREVIEW_MAX = 120;

// ---------------------------------------------------------------------------
// Layer 1: bilingual pattern bank (runs on the NORMALIZED text)
//
// One table, `Array<{ category; severity; patterns: RegExp[] }>`. This table is
// the Layer-3 extension point: a future model-classifier layer appends its own
// findings to the same ScanResult behind a config flag — leave that to L3.
// Multiple regexes per category, synonym sets, English + Chinese.
// ---------------------------------------------------------------------------

interface PatternGroup {
  category: InjectionCategory;
  severity: ScanSeverity;
  patterns: RegExp[];
}

const PATTERN_BANK: PatternGroup[] = [
  {
    category: "instruction_override",
    severity: SEVERITY_PATTERN,
    patterns: [
      // EN: verb × (optional determiner/quantifier) × previous-word × noun.
      // The determiner slot is a fixed word set on purpose: it must NOT bridge
      // an obfuscated quantifier (e.g. "aλλ") into a match, so a homoglyph that
      // escapes T2's fold table stays an honest miss.
      /\b(ignore|disregard|forget|skip|override|bypass|disobey)\s+(the\s+|all\s+|any\s+|your\s+|my\s+|these\s+|those\s+)?(previous|prior|earlier|above|preceding|foregoing)\s+(instructions?|rules?|directives?|prompts?|guidelines?|constraints?|commands?)/i,
      // zh: verb × optional connective run × noun.
      /(忽略|无视|忘记|忘掉|不要理会|不用理会|别理会)(之前|以上|上面|上述|前面|先前|所有|全部|这些|那些|的)*(指令|指示|规则|提示词|提示|命令|要求|限制|约束)/,
    ],
  },
  {
    category: "role_manipulation",
    severity: SEVERITY_PATTERN,
    patterns: [
      /\byou\s+are\s+now\b/i,
      /\bfrom\s+now\s+on\b[\s\S]{0,20}\byou\s+are\b/i,
      /\b(pretend|act)\s+(you\s+are|to\s+be|as)\b/i,
      /\b(developer|admin|dan|god|jailbreak)\s+mode\b/i,
      /\bnew\s+persona\b/i,
      // zh
      /(你现在是|现在你是|你现在扮演|扮演|假装|冒充)/,
      /(开发者模式|管理员模式|越狱模式)/,
    ],
  },
  {
    category: "prompt_leak",
    severity: SEVERITY_PATTERN,
    patterns: [
      /\b(reveal|show|print|repeat|output|display|expose|give\s+me|tell\s+me|list)\b[\s\S]{0,40}\b(system\s+prompt|initial\s+instruction|original\s+instruction|hidden\s+(?:instruction|rule|prompt)|the\s+instructions?\s+you\s+were\s+given|everything\s+above)\b/i,
      /\b(your|the)\s+(original|initial|system|hidden|secret|underlying)\s+(instructions?|prompts?|rules?|directives?|message)\b/i,
      // zh: strong compound nouns that do not occur in benign household text.
      /(系统提示词|初始指令|原始指令|隐藏指令|系统指令)/,
    ],
  },
  {
    category: "jailbreak",
    severity: SEVERITY_PATTERN,
    patterns: [
      /\bjailbreak\b/i,
      /\bno\s+(restrictions?|limits?|rules?|filters?|boundaries)\b/i,
      /\bwithout\s+any\s+(restrictions?|filter|content\s+policy|safety|guidelines?|rules?|limits?)\b/i,
      /\bbypass\s+(?:your\s+|the\s+|all\s+)?(safety|content|security|guidelines?|filters?|restrictions?)/i,
      /\bnone\s+of\s+(?:your|the)\s+(rules?|restrictions?|guidelines?)\s+apply/i,
      /\b(uncensored|unfiltered|no\s+longer\s+bound|unrestricted)\b/i,
      // zh
      /(越狱|不受限制|解除限制|没有任何限制|没有限制|无限制|不加过滤)/,
      /绕过(?:你的|所有)?(?:安全|限制|过滤|内容|门锁)/,
    ],
  },
  {
    category: "exfiltration",
    severity: SEVERITY_PATTERN,
    patterns: [
      /\b(send|post|forward|email|upload|exfiltrate|transmit|leak|share)\b[\s\S]{0,60}\b(?:to|at)\b[\s\S]{0,20}(https?:\/\/|www\.|external|@[\w.-]+\.\w+)/i,
      // zh
      /(发送|上传|转发|传送|外传|发送到|上传到|转发给)[\s\S]{0,30}(https?:\/\/|www\.|外部|邮箱|@[\w.-]+\.\w+)/,
    ],
  },
  {
    category: "context_manipulation",
    severity: SEVERITY_PATTERN,
    patterns: [
      /\[SYSTEM\]|\[ADMIN\]/i,
      /\bthe\s+user\s+(?:has\s+)?(?:been\s+)?(approved|authenticated|authorized|confirmed|said|requested)\b/i,
      /\b(already\s+confirmed|has\s+approved|is\s+(?:safe\s+and\s+)?approved|pre-?approved)\b/i,
      /\bend\s+of\s+(?:user\s+)?message\b/i,
      /\bnew\s+system\s+(?:instruction|message|prompt)/i,
      /\bimportant\s*:\s*new\s+instructions?/i,
      /^(?:assistant|system|user)\s*:/im,
      /"role"\s*:\s*"(?:tool|system|assistant|admin)"/i,
      /admin_override|override_granted|full\s+access\s+to\s+all/i,
      // zh
      /(\[系统\]|【系统】|\[管理员\]|【管理员】)/,
      /用户已(?:通过|经)?[\s\S]{0,10}(批准|授权|认证|验证|确认)/,
      /(已经?确认|已批准|已授权)/,
      /(助手|系统|管理员)\s*[:：]/,
      /管理员(?:要求|指示|命令|授权)/,
    ],
  },
  {
    category: "encoding_obfuscation",
    severity: SEVERITY_PATTERN,
    patterns: [
      // Explicit "decode this base64/hex and act on it" — catches the encoded
      // attacks whose payload does NOT decode to printable ASCII (so T2 emits
      // no decode signal), e.g. a base64-wrapped Chinese directive.
      /(decode|解码)[\s\S]{0,40}(base64|hex)/i,
      /(base64|hex)[\s\S]{0,40}(decode|execute|follow|按照|执行|运行)/i,
    ],
  },
];

// ---------------------------------------------------------------------------
// Layer 2: structural tool-envelope detection (runs on the RAW text).
//
// This is the one class that is never legitimate data: its matches are STRIPPED
// from `sanitizedText` and marked hostile. Tag/marker forms are regex-matched;
// JSON forms are PARSED and checked by top-level key so that a page merely
// quoting `"tool_calls":` in prose documentation is not corrupted.
// ---------------------------------------------------------------------------

const STRUCTURAL_TAG_PATTERNS: RegExp[] = [
  /<tool_call\b[\s\S]*?<\/tool_call>/gi,
  /<function[-_]call\b[\s\S]*?<\/function[-_]call>/gi,
  /\[TOOL_(?:CALL|REQUEST)\][\s\S]*?\[\/TOOL_(?:CALL|REQUEST)\]/gi,
  /\[\/?TOOL_(?:CALL|REQUEST)\]/gi,
  /<\|im_start\|>[\s\S]*?(?:<\|im_end\|>|$)/gi,
];

const FENCED_BLOCK = /```([^\n`]*)\n?([\s\S]*?)```/g;

/** Keys that make a BARE top-level JSON object an envelope (strip + hostile).
 *  `tool` is deliberately excluded here: a benign product/record object like
 *  `{"tool":"screwdriver","price":9.99}` is not a tool call. `tool` only counts
 *  as an envelope inside a fenced code block (see FENCED_ENVELOPE_KEYS). */
const STRICT_ENVELOPE_KEYS: ReadonlySet<string> = new Set(["tool_calls", "function_call"]);

/** Keys that make a FENCED code block's JSON body an envelope. The fixture's
 *  fenced attack uses a top-level `tool` key, which is a strong signal inside a
 *  ```` ``` ```` block but not in free-standing JSON. */
const FENCED_ENVELOPE_KEYS: ReadonlySet<string> = new Set(["tool_calls", "function_call", "tool"]);

/** Non-global copies of the tag patterns, for testing whether a JSON string
 *  VALUE embeds an envelope tag/marker (annotate-only; never strips). */
const TAG_VALUE_PATTERNS: RegExp[] = STRUCTURAL_TAG_PATTERNS.map((p) => new RegExp(p.source, "i"));

/** Depth bound for the recursive JSON envelope walkers. `JSON.parse` tolerates
 *  tens of thousands of nesting levels, but a naive recursive walk of that
 *  structure blows the call stack (RangeError) — and the input is
 *  attacker-controlled tool-result text, so an unbounded walk is a DoS / an
 *  uncaught throw escaping scanContent. Beyond this bound we stop descending and
 *  treat the value as a possible envelope (fail toward annotation, never toward
 *  silence or throw). 64 is far deeper than any legitimate tool-call payload. */
const MAX_ENVELOPE_WALK_DEPTH = 64;

interface Span {
  start: number;
  end: number;
  match: string;
}

interface StructuralScan {
  /** Envelope forms removed from `sanitizedText` and reported hostile. */
  stripSpans: Span[];
  /** Envelope forms detected but NOT removed (nested / embedded) — reported
   *  suspicious, so a one-level wrap cannot fail the layer open. */
  annotations: Span[];
}

function truncate(s: string): string {
  return s.length > MATCH_PREVIEW_MAX ? `${s.slice(0, MATCH_PREVIEW_MAX)}…` : s;
}

/** Parses `value` as a JSON object, or null. Never throws. */
function parseJsonObject(value: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function hasTopLevelKey(obj: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(obj).some((key) => keys.has(key));
}

/** True when a strict envelope key appears at NON-top-level depth (depth ≥ 1)
 *  anywhere in the parsed value — a wrapped `{...,"x":{"tool_calls":[...]}}`.
 *  Bounded by MAX_ENVELOPE_WALK_DEPTH: past the bound it returns true (a deeply
 *  nested payload is treated as a possible envelope — fail toward annotation). */
function hasNestedEnvelopeKey(node: unknown, depth: number): boolean {
  if (depth > MAX_ENVELOPE_WALK_DEPTH) return true;
  if (Array.isArray(node)) {
    return node.some((v) => hasNestedEnvelopeKey(v, depth + 1));
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (depth >= 1 && STRICT_ENVELOPE_KEYS.has(key)) return true;
      if (hasNestedEnvelopeKey(value, depth + 1)) return true;
    }
  }
  return false;
}

/** True when any string value inside the parsed node embeds a tag/marker
 *  envelope form (e.g. a `<tool_call>…` smuggled into a JSON string value).
 *  Same depth bound and fail-toward-annotation semantics as above. */
function hasEnvelopeTagInValue(node: unknown, depth: number): boolean {
  if (depth > MAX_ENVELOPE_WALK_DEPTH) return true;
  if (typeof node === "string") {
    return TAG_VALUE_PATTERNS.some((p) => p.test(node));
  }
  if (Array.isArray(node)) {
    return node.some((v) => hasEnvelopeTagInValue(v, depth + 1));
  }
  if (node && typeof node === "object") {
    return Object.values(node as Record<string, unknown>).some((v) => hasEnvelopeTagInValue(v, depth + 1));
  }
  return false;
}

/** Runs both nested-envelope walkers under a defensive guard. The depth bound
 *  above prevents the expected stack overflow, but this belt catches anything
 *  else the parser hands us and degrades to annotation — never throws, never
 *  goes silent (business logic must not throw on attacker-controlled input). */
function looksLikeNestedEnvelope(obj: Record<string, unknown>): boolean {
  try {
    return hasNestedEnvelopeKey(obj, 0) || hasEnvelopeTagInValue(obj, 0);
  } catch (err) {
    log.warn("injection-scanner.envelope-walk-failed", {
      reason: "recursive envelope walk failed — degrading to annotation",
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

/** Finds balanced top-level `{…}` spans, respecting JSON string context so a
 *  brace inside a string value does not desync the depth counter. */
function findTopLevelJsonSpans(text: string): Span[] {
  const spans: Span[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          spans.push({ start, end: i + 1, match: text.slice(start, i + 1) });
          start = -1;
        }
      }
    }
  }
  return spans;
}

function isWithin(inner: { start: number; end: number }, outer: Span): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

function collectStructuralSpans(raw: string): StructuralScan {
  const stripSpans: Span[] = [];
  const annotations: Span[] = [];

  // Parse top-level JSON objects first: they both source annotations AND mask
  // tag matches that live INSIDE a JSON string value (those annotate, never
  // strip — stripping quoted content is the over-reach we reject).
  const jsonSpans = findTopLevelJsonSpans(raw);
  const parsedObjectSpans: Span[] = [];
  for (const span of jsonSpans) {
    const obj = parseJsonObject(span.match);
    if (!obj) continue;
    parsedObjectSpans.push(span);
    if (hasTopLevelKey(obj, STRICT_ENVELOPE_KEYS)) {
      stripSpans.push(span);
    } else if (looksLikeNestedEnvelope(obj)) {
      annotations.push(span);
    }
  }

  for (const pattern of STRUCTURAL_TAG_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null = pattern.exec(raw);
    while (m !== null) {
      const span: Span = { start: m.index, end: m.index + m[0].length, match: m[0] };
      // A tag fully inside a parsed JSON object is smuggled in a string value:
      // it was already annotated via hasEnvelopeTagInValue — do not strip it.
      if (!parsedObjectSpans.some((obj) => isWithin(span, obj))) {
        stripSpans.push(span);
      }
      if (m[0].length === 0) pattern.lastIndex += 1;
      m = pattern.exec(raw);
    }
  }

  FENCED_BLOCK.lastIndex = 0;
  let fence: RegExpExecArray | null = FENCED_BLOCK.exec(raw);
  while (fence !== null) {
    const lang = fence[1]?.trim().toLowerCase() ?? "";
    const body = fence[2]?.trim() ?? "";
    const obj = parseJsonObject(body);
    const span: Span = { start: fence.index, end: fence.index + fence[0].length, match: fence[0] };
    if (lang === "tool" || (obj && hasTopLevelKey(obj, FENCED_ENVELOPE_KEYS))) {
      stripSpans.push(span);
    } else if (obj && looksLikeNestedEnvelope(obj)) {
      annotations.push(span);
    }
    fence = FENCED_BLOCK.exec(raw);
  }

  return { stripSpans, annotations };
}

/** Merges overlapping spans (by index) so the same region is removed once. */
function mergeSpans(spans: Span[]): Span[] {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged: Span[] = [{ ...sorted[0]! }];
  for (let i = 1; i < sorted.length; i += 1) {
    const cur = sorted[i]!;
    const last = merged[merged.length - 1]!;
    if (cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

function stripSpans(raw: string, merged: Span[]): string {
  if (merged.length === 0) return raw;
  let out = "";
  let cursor = 0;
  for (const span of merged) {
    out += raw.slice(cursor, span.start);
    cursor = span.end;
  }
  out += raw.slice(cursor);
  return out;
}

// ---------------------------------------------------------------------------
// Dedup + severity
// ---------------------------------------------------------------------------

function dedupeFindings(findings: ScanFinding[]): ScanFinding[] {
  const seen = new Set<string>();
  const out: ScanFinding[] = [];
  for (const f of findings) {
    const key = `${f.category} ${f.match}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

function computeMaxSeverity(findings: ScanFinding[]): ScanSeverity | null {
  let max: ScanSeverity | null = null;
  for (const f of findings) {
    if (max === null || SEVERITY_RANK[f.severity] > SEVERITY_RANK[max]) {
      max = f.severity;
    }
  }
  return max;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Scans untrusted content for prompt-injection signals across three layers:
 * structural tool-envelope detection on raw text (Layer 2, fail-closed strip),
 * a bilingual pattern bank on the normalized text (Layer 1), and a
 * normalization-signal notice when T2 saw invisible/encoded channels (Layer 0).
 * Returns findings, the max severity, and the envelope-stripped `sanitizedText`.
 */
export function scanContent(text: string, provenance: ScanProvenance): ScanResult {
  if (!text) {
    return { findings: [], maxSeverity: null, sanitizedText: "" };
  }

  const findings: ScanFinding[] = [];

  // Layer 2 — structural, on RAW text. Top-level envelope forms are stripped
  // and reported hostile; nested/embedded envelope forms are ANNOTATED
  // suspicious WITHOUT stripping (a one-level wrap must not fail the layer open,
  // but stripping quoted documentation would corrupt real content).
  const { stripSpans: rawStripSpans, annotations } = collectStructuralSpans(text);
  const merged = mergeSpans(rawStripSpans);
  const sanitizedText = stripSpans(text, merged);
  for (const span of merged) {
    findings.push({
      category: "tool_envelope",
      severity: SEVERITY_STRUCTURAL,
      match: truncate(span.match),
      layer: "structural",
    });
  }
  for (const span of annotations) {
    findings.push({
      category: "tool_envelope",
      severity: SEVERITY_PATTERN,
      match: truncate(span.match),
      layer: "structural",
    });
  }

  // Layer 0/1 — normalize, then pattern-match on the normalized text.
  const { normalized, signals } = normalizeForScan(text);

  for (const group of PATTERN_BANK) {
    for (const pattern of group.patterns) {
      const m = normalized.match(pattern);
      if (m?.[0]) {
        findings.push({
          category: group.category,
          severity: group.severity,
          match: truncate(m[0]),
          layer: "pattern",
        });
      }
    }
  }

  // Layer 0 — a normalization signal (invisibles / homoglyph / encoded payload)
  // is itself evidence of obfuscation, emitted as a single notice regardless of
  // whether a pattern also fired (the deobfuscated content may or may not match).
  if (signals.length > 0) {
    findings.push({
      category: "encoding_obfuscation",
      severity: SEVERITY_NORMALIZATION,
      match: signals.map((s) => s.kind).join(","),
      layer: "normalization",
    });
  }

  const deduped = dedupeFindings(findings);
  const maxSeverity = computeMaxSeverity(deduped);

  if (deduped.length > 0) {
    log.debug("injection-scanner.findings", {
      channel: provenance.channel,
      source: provenance.source,
      count: deduped.length,
      maxSeverity,
      categories: [...new Set(deduped.map((f) => f.category))],
      strippedEnvelopes: merged.length,
    });
  }

  return { findings: deduped, maxSeverity, sanitizedText };
}
