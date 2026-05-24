import type { RiskConfig } from "@sentient/config";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "security", "risk-accumulator"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RiskLevel = "none" | "warn" | "escalate" | "block";

export type RiskEvent =
  | "injection_pattern"
  | "repeated_offense"
  | "role_violation"
  | "ha_name_prompt_like"
  | "mutating_sensitive_domain"
  | "policy_rejection";

export interface RiskSnapshot {
  score: number;
  level: RiskLevel;
}

interface ScoredEvent {
  time: number;
  weight: number;
}

// ---------------------------------------------------------------------------
// Risk accumulator with exponential decay
// ---------------------------------------------------------------------------

export function createRiskAccumulator(cfg: RiskConfig) {
  const events: ScoredEvent[] = [];
  const halfLifeMs = cfg.ttl_seconds * 1000;
  const decayRate = halfLifeMs > 0 ? Math.LN2 / halfLifeMs : 0;

  function score(now?: number): number {
    if (!cfg.enabled) return 0;
    const t = now ?? Date.now();
    let total = 0;
    for (const evt of events) {
      const elapsed = t - evt.time;
      const factor = elapsed > 0 ? Math.exp(-decayRate * elapsed) : 1;
      total += evt.weight * factor;
    }
    return total;
  }

  function level(s: number): RiskLevel {
    if (s >= cfg.threshold_block) return "block";
    if (s >= cfg.threshold_escalate) return "escalate";
    if (s >= cfg.threshold_warn) return "warn";
    return "none";
  }

  function record(event: RiskEvent, now?: number): RiskSnapshot {
    if (!cfg.enabled) {
      log.debug("risk-accumulator.disabled");
      return { score: 0, level: "none" };
    }
    const weight = cfg.weights[event] ?? 0;
    const time = now ?? Date.now();
    events.push({ time, weight });
    log.debug("risk-accumulator.record", { event, weight, total: events.length });
    const s = score(time);
    return { score: s, level: level(s) };
  }

  function reset(): void {
    events.length = 0;
  }

  return { score, level, record, reset };
}
