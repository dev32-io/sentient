import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "security", "injection-scanner"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InjectionCategory =
  | "ignore_instructions"
  | "override_system"
  | "leak_prompt"
  | "disobey_role"
  | "jailbreak_phrases"
  | "inline_tool_invocation";

export interface InjectionFinding {
  category: InjectionCategory;
  pattern: string;
  match: string;
}

// ---------------------------------------------------------------------------
// Patterns — regex-based, observability only, does NOT block output
// ---------------------------------------------------------------------------

const PATTERNS: Array<{ category: InjectionCategory; pattern: RegExp }> = [
  {
    category: "ignore_instructions",
    pattern: /ignore\s+(previous|prior|all|above|earlier|past)\s*(instructions?|prompts?|rules?|directives?)/i,
  },
  {
    category: "override_system",
    pattern: /you\s+are\s+now\s+a?\s*(different|new|unrestricted|DAN|developer|admin)/i,
  },
  {
    category: "leak_prompt",
    pattern:
      /reveal|show|display|print|output|repeat\s+(your|the|this|system|initial|original)\s*(prompt|instructions?|directives?|system\s*message)/i,
  },
  {
    category: "disobey_role",
    pattern: /disregard\s+(your|the|all)\s*(role|character|persona|identity|rules)/i,
  },
  {
    category: "jailbreak_phrases",
    pattern: /jailbreak|escape\s+the\s+(matrix|simulation|confines)|break\s+out\s+of/i,
  },
  {
    category: "inline_tool_invocation",
    pattern: /<function-call>|<tool_call>|```tool\b|invoke\s+tool\s*\(/i,
  },
];

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/** Scan text for known injection patterns. Returns findings; does NOT block. */
export function scanForInjection(text: string): InjectionFinding[] {
  if (!text) return [];

  const findings: InjectionFinding[] = [];
  for (const { category, pattern } of PATTERNS) {
    const match = text.match(pattern);
    if (match?.[0]) {
      findings.push({
        category,
        pattern: pattern.source,
        match: match[0],
      });
    }
  }

  if (findings.length > 0) {
    log.debug("injection-scanner.findings", {
      count: findings.length,
      categories: findings.map((f) => f.category),
    });
  }

  return findings;
}
