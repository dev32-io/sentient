// The inbound gate — the single boundary every piece of non-person text
// crosses on its way into model context (tool results, background-task
// completions, skill bodies, delegation prompts). It composes the pure
// `scanContent` scanner (injection-scanner.ts) with the session's risk
// accumulator (risk-accumulator.ts) and turns their output into two things the
// call sites need: the sanitized text to feed the model, and a running risk
// signal the PDP can escalate on.
//
// ANNOTATE, DON'T BLOCK. The gate never drops a result. It returns
// `sanitizedText` — which differs from the input only when the scanner stripped
// a never-legitimate tool-envelope form — and otherwise leaves content intact.
// Every hostile/suspicious finding feeds the risk accumulator; what that
// elevated risk then GATES is decided elsewhere (the ToolBroker PDP raises a
// confirm on side-effecting tools). Screening is evidence-gathering here, not
// enforcement.
//
// SECURE BY DEFAULT. `enabled` and every per-channel toggle default to `true`
// in config (shared/config), so a missing block scans everything. A channel
// switched off is a deliberate operator choice; this file honours it as a
// passthrough and the boot log (elsewhere) is what makes a silenced channel
// visible in the trail.

import type { InboundScanConfig } from "@sentient/config";
import { getLog } from "../logging/logger.js";
import { scanContent } from "./injection-scanner.js";
import type { ScanProvenance, ScanSeverity } from "./injection-scanner.js";
import type { RiskEvent, RiskLevel, RiskSnapshot } from "./risk-accumulator.js";

const log = getLog(["sentient", "security", "inbound-gate"]);

/** The subset of the risk accumulator the gate holds by value. Matches
 *  `createRiskAccumulator`'s return shape exactly, so the live accumulator is
 *  assignable without a cast, while a test can hand in a deterministic fake. */
export interface RiskAccumulator {
  score(now?: number): number;
  level(s: number): RiskLevel;
  record(event: RiskEvent, now?: number): RiskSnapshot;
  reset(): void;
}

export interface ScreenResult {
  /** The text to hand the model: `sanitizedText` from the scanner (envelope
   *  forms stripped) when the channel is on, the original input otherwise. */
  text: string;
  /** True when the scan produced any finding — a signal for callers/logging,
   *  NOT a block. */
  flagged: boolean;
  maxSeverity: ScanSeverity | null;
}

export interface InboundGate {
  /**
   * Screens one untrusted string on its way into model context. A disabled
   * master switch or a disabled channel is a passthrough (`flagged:false`,
   * original text). Otherwise the scanner runs; each hostile/suspicious finding
   * records an `injection_pattern` risk event, and the envelope-stripped
   * `sanitizedText` comes back. Never throws — `scanContent` is total on
   * attacker-controlled input by contract.
   */
  screen(text: string, provenance: ScanProvenance, ids: ScreenIds): ScreenResult;
  /** The accumulator's current risk level (score → level). Read by the PDP to
   *  decide whether a side-effecting tool needs an extra confirm. */
  getRiskLevel(): RiskLevel;
}

export interface ScreenIds {
  sessionId: string;
  toolCallId?: string;
}

/** Severities that count as evidence worth feeding the accumulator. A `notice`
 *  (a bare normalization signal — invisibles/homoglyphs with no matching
 *  pattern) is logged in the finding set but does not move the risk score on its
 *  own; only a suspicious pattern or a hostile envelope does. */
const RECORDABLE_SEVERITIES: ReadonlySet<ScanSeverity> = new Set<ScanSeverity>(["suspicious", "hostile"]);

/** The risk event every inbound finding maps to (the accumulator's existing
 *  vocabulary — see risk-accumulator.ts's `RiskEvent`). */
const INBOUND_RISK_EVENT: RiskEvent = "injection_pattern";

function uniqueJoined<T>(values: readonly T[]): string {
  return [...new Set(values)].join(",");
}

export function createInboundGate(cfg: InboundScanConfig, risk: RiskAccumulator): InboundGate {
  function isChannelOn(provenance: ScanProvenance): boolean {
    return cfg.enabled && cfg.channels[provenance.channel];
  }

  function screen(text: string, provenance: ScanProvenance, ids: ScreenIds): ScreenResult {
    if (!isChannelOn(provenance)) {
      return { text, flagged: false, maxSeverity: null };
    }

    const result = scanContent(text, provenance);
    const recordable = result.findings.filter((f) => RECORDABLE_SEVERITIES.has(f.severity));
    for (const _finding of recordable) {
      risk.record(INBOUND_RISK_EVENT);
    }

    if (recordable.length > 0) {
      // WARN carries the ids the logging rule wants in every entry, plus the
      // scan shape — categories and severities as pre-joined strings (the
      // formatter renders an array of objects as `[object Object]`). The
      // matched text is deliberately NOT logged: the finding previews are
      // already ≤120 chars, but nothing here needs the content, so none of it
      // is emitted.
      log.warn("inbound-gate.flagged", {
        sessionId: ids.sessionId,
        toolCallId: ids.toolCallId,
        channel: provenance.channel,
        source: provenance.source,
        findingCount: result.findings.length,
        categories: uniqueJoined(result.findings.map((f) => f.category)),
        severities: uniqueJoined(result.findings.map((f) => f.severity)),
        maxSeverity: result.maxSeverity,
      });
    }

    return {
      text: result.sanitizedText,
      flagged: result.findings.length > 0,
      maxSeverity: result.maxSeverity,
    };
  }

  function getRiskLevel(): RiskLevel {
    return risk.level(risk.score());
  }

  return { screen, getRiskLevel };
}

/** A gate that scans nothing and carries no risk — the ToolBroker's default
 *  when the composition root has not yet wired a real gate (that wiring lands
 *  in a later task). Keeps `createToolBroker` closed over this file's set: a
 *  broker built without an `inboundGate` behaves exactly as it did before the
 *  boundary existed. */
export function createPassthroughInboundGate(): InboundGate {
  return {
    screen: (text) => ({ text, flagged: false, maxSeverity: null }),
    getRiskLevel: () => "none",
  };
}
