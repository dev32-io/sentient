// PromptClassifier (Plan 2 Task 5, spec §2.3/§2.4) — the "auto-mode"
// risk-tiering of a free-form `taskPrompt`. This is where real delegation
// safety lives (the static frontmatter envelope in delegation-guard.ts
// cannot constrain free-form intent). Reuses the two dormant shared
// security primitives rather than re-deriving thresholds: `scanForInjection`
// finds pattern hits, `createRiskAccumulator` turns the hit count into one
// of the accumulator's calibrated severity levels.
//
// `findings` returned to callers are injection *category* names only
// (e.g. "ignore_instructions") — never the raw matched text, which could
// carry user-authored prompt content. Callers (delegation-guard.ts) log
// `findings.length` and these category names, never the prompt itself.

import type { RiskConfig } from "@sentient/config";
import { getLog } from "../logging/logger.js";
import { scanForInjection } from "../security/injection-scanner.js";
import { type RiskLevel, createRiskAccumulator } from "../security/risk-accumulator.js";

const log = getLog(["sentient", "tools", "prompt-classifier"]);

export type PromptRiskTier = "low" | "medium" | "high";

export interface PromptClassification {
  tier: PromptRiskTier;
  findings: string[];
}

export interface PromptClassifier {
  classify(prompt: string): PromptClassification;
}

export interface PromptClassifierDeps {
  riskConfig: RiskConfig;
}

/** Maps the risk accumulator's severity level (fed one `injection_pattern`
 *  event per pattern hit) to the classifier's coarser 3-tier scale.
 *  `none`/`warn` collapse to `medium` — ANY injection-pattern hit is at
 *  least medium risk, never `low`; `escalate`/`block` are `high`. */
function tierFromRiskLevel(level: RiskLevel): PromptRiskTier {
  if (level === "escalate" || level === "block") return "high";
  return "medium";
}

export function createPromptClassifier(deps: PromptClassifierDeps): PromptClassifier {
  const { riskConfig } = deps;

  function classify(prompt: string): PromptClassification {
    const hits = scanForInjection(prompt);
    if (hits.length === 0) {
      log.debug("prompt-classifier.classify", { tier: "low", findingsCount: 0 });
      return { tier: "low", findings: [] };
    }

    const accumulator = createRiskAccumulator(riskConfig);
    let level: RiskLevel = "none";
    for (const _hit of hits) {
      level = accumulator.record("injection_pattern").level;
    }

    const tier = tierFromRiskLevel(level);
    const findings = hits.map((hit) => hit.category);
    log.debug("prompt-classifier.classify", { tier, findingsCount: findings.length, riskLevel: level });
    return { tier, findings };
  }

  return { classify };
}
