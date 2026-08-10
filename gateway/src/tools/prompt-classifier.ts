// PromptClassifier (Plan 2 Task 5, spec §2.3/§2.4) — the "auto-mode"
// risk-tiering of a free-form `taskPrompt`. This is where real delegation
// safety lives (the static frontmatter envelope in delegation-guard.ts
// cannot constrain free-form intent). It runs the free-form prompt through
// the v2 injection scanner (`scanContent`) and maps the scanner's max
// severity onto the classifier's coarse 3-tier scale.
//
// `findings` returned to callers are injection *category* names only
// (e.g. "instruction_override") — never the raw matched text, which could
// carry user-authored prompt content. Callers (delegation-guard.ts) log
// `findings.length` and these category names, never the prompt itself.

import { getLog } from "../logging/logger.js";
import { type ScanSeverity, scanContent } from "../security/injection-scanner.js";

const log = getLog(["sentient", "tools", "prompt-classifier"]);

/** Provenance source for delegation-prompt scans. The classifier is invoked
 *  without the concrete agent name in scope; source is pure scan metadata and
 *  does not affect findings or severity. */
const DELEGATION_SOURCE = "delegation";

export type PromptRiskTier = "low" | "medium" | "high";

export interface PromptClassification {
  tier: PromptRiskTier;
  findings: string[];
}

export interface PromptClassifier {
  classify(prompt: string): PromptClassification;
}

/** Maps the scanner's max severity onto the classifier's 3-tier scale:
 *  no findings → `low`; any `notice`/`suspicious` finding → `medium`; a
 *  `hostile` finding (a structural tool-envelope) → `high`. The hostile→high
 *  step is a deliberate escalation: a single structural envelope reaches the
 *  top tier in one move, without needing accumulated risk. */
function tierFromSeverity(severity: ScanSeverity | null): PromptRiskTier {
  if (severity === null) return "low";
  if (severity === "hostile") return "high";
  return "medium";
}

export function createPromptClassifier(): PromptClassifier {
  function classify(prompt: string): PromptClassification {
    const result = scanContent(prompt, { channel: "delegation_prompt", source: DELEGATION_SOURCE });
    const tier = tierFromSeverity(result.maxSeverity);
    const findings = [...new Set(result.findings.map((f) => f.category))];
    log.debug("prompt-classifier.classify", {
      tier,
      findingsCount: findings.length,
      maxSeverity: result.maxSeverity,
    });
    return { tier, findings };
  }

  return { classify };
}
