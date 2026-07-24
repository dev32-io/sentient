// DelegationGuard (Plan 2 Task 5, spec §2.3) — the delegation-category
// security layer for `delegateTask`. Split in two, per the spec:
//
//   1. Static frontmatter envelope (this file's `DelegationEnvelope` +
//      loader below) — a claude-code-skill-style header per `agent` enum
//      value (`allowed_tools`, `network`, `confirm_class`). Coarse capability
//      envelope. Deliberately the reference template for the future Skill
//      security layer — same shape, same loader pattern, different consumer.
//   2. Dynamic per-invocation classification (`PromptClassifier`) — the
//      load-bearing part, since #1 cannot constrain a free-form prompt.
//
// A denied/unknown/disabled agent short-circuits before the classifier ever
// runs. An allowed agent's `taskPrompt` is classified; `low` allows, `medium`
// always requires confirmation, and `high` resolves per the agent's own
// `confirm_class` (some future agent may want a hard deny on high risk,
// others confirm — that is the point of keeping it per-envelope, not global).
//
// Plan 2 has no wired confirm-UI seam for delegation yet (Plan 3 adds real
// permission-prompt UI, mirroring the tool PDP's own `confirm` handling in
// tool-broker.ts). `delegate-task.ts` treats `confirm` as `deny` until that
// seam exists — fail-closed, never silently auto-approved.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { getLog } from "../logging/logger.js";
import type { PromptClassifier } from "./prompt-classifier.js";

const log = getLog(["sentient", "tools", "delegation-guard"]);

const FRONTMATTER_DELIMITER = "---";
const MD_EXTENSION = ".md";

// ---------------------------------------------------------------------------
// Static envelope + loader
// ---------------------------------------------------------------------------

/** Coarse per-agent capability envelope loaded from a frontmatter file
 *  (`gateway/config/delegation/<agent>.md`). */
export interface DelegationEnvelope {
  agent: string;
  /** Tool names the delegated worker may use once it re-enters our MCP host
   *  (the free mitigation hook noted in spec §2.3) — informational in v1,
   *  not yet enforced against the worker's own tool calls. */
  allowed_tools: string[];
  network: "none" | "restricted" | "full";
  /** What a `high`-tier classified prompt resolves to for this agent. */
  confirm_class: "confirm" | "deny";
  /** Operator kill switch — flip off in the frontmatter file without
   *  deleting it. Must be explicitly `true` to enable; absent, `false`, or
   *  any other value defaults to disabled (fail-closed on a security
   *  boundary — a present-but-empty frontmatter block must not silently
   *  grant the agent). */
  enabled: boolean;
}

/** Parses the YAML frontmatter block out of `content`. Returns `null` when
 *  the delimiters are missing/unbalanced OR the YAML body fails to parse —
 *  both route the caller into the same fail-closed (`enabled: false`)
 *  branch. Never throws: a single operator YAML typo in one delegation
 *  config file must not crash gateway boot or block loading of the other,
 *  well-formed files. */
function parseFrontmatterBlock(content: string): Record<string, unknown> | null {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) return null;
  const closeIndex = lines.findIndex((line, i) => i > 0 && line.trim() === FRONTMATTER_DELIMITER);
  if (closeIndex < 0) return null;

  let parsed: unknown;
  try {
    parsed = parseYaml(lines.slice(1, closeIndex).join("\n"));
  } catch {
    // Never log the raw content/error message here — a YAML parse error
    // message frequently echoes back the offending source snippet, which
    // would leak operator-authored file content into logs.
    log.warn("delegation-guard.frontmatter.parse-error", {
      reason: "invalid YAML — treating as disabled",
    });
    return null;
  }
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

/** Loads one agent's static envelope from a claude-code-skill-style `.md`
 *  file (YAML frontmatter + markdown body). A missing/malformed frontmatter
 *  block fails closed: `enabled: false`, so a broken file denies rather
 *  than silently granting the agent's default field values. */
export function loadDelegationEnvelope(agent: string, filePath: string): DelegationEnvelope {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    log.warn("delegation-guard.load.file-unreadable", {
      agent,
      filePath,
      reason: err instanceof Error ? err.message : String(err),
    });
    return { agent, allowed_tools: [], network: "none", confirm_class: "deny", enabled: false };
  }

  const fm = parseFrontmatterBlock(raw);
  if (!fm) {
    log.warn("delegation-guard.load.no-frontmatter", { agent, filePath });
    return { agent, allowed_tools: [], network: "none", confirm_class: "deny", enabled: false };
  }

  return {
    agent,
    allowed_tools: Array.isArray(fm.allowed_tools) ? fm.allowed_tools.map(String) : [],
    network: fm.network === "restricted" || fm.network === "full" ? fm.network : "none",
    confirm_class: fm.confirm_class === "confirm" ? "confirm" : "deny",
    enabled: fm.enabled === true,
  };
}

/** Scans `dir` for `<agent>.md` frontmatter files and builds the map
 *  `createDelegationGuard` consumes. A missing/unreadable directory
 *  resolves to an empty map — fail-closed, since an agent absent from the
 *  map is denied by `evaluate`. Per-file loading is isolated: a single
 *  agent file that fails to load for any reason (defense-in-depth beyond
 *  `loadDelegationEnvelope`'s own fail-closed handling) is skipped and
 *  logged, never allowed to abort the scan — one bad operator file must
 *  never crash loading of the other, well-formed agents. */
export function loadDelegationFrontmatterDir(dir: string): Map<string, DelegationEnvelope> {
  const map = new Map<string, DelegationEnvelope>();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    log.warn("delegation-guard.load.dir-unreadable", { dir, reason: err instanceof Error ? err.message : String(err) });
    return map;
  }

  for (const entry of entries) {
    if (!entry.endsWith(MD_EXTENSION)) continue;
    const agent = entry.slice(0, -MD_EXTENSION.length);
    try {
      map.set(agent, loadDelegationEnvelope(agent, join(dir, entry)));
    } catch (err) {
      log.warn("delegation-guard.load.agent-load-failed", {
        agent,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  log.info("delegation-guard.load.ok", { dir, agents: [...map.keys()] });
  return map;
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

export type DelegationDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | { action: "confirm"; reason: string };

export interface DelegationGuard {
  evaluate(agent: string, taskPrompt: string): DelegationDecision;
}

export interface DelegationGuardDeps {
  frontmatter: Map<string, DelegationEnvelope>;
  classifier: PromptClassifier;
}

const MEDIUM_TIER_REASON = "task prompt flagged medium risk — confirmation required";

export function createDelegationGuard(deps: DelegationGuardDeps): DelegationGuard {
  const { frontmatter, classifier } = deps;

  function logAndReturn(
    agent: string,
    decision: DelegationDecision,
    tier: string,
    findingsCount: number,
  ): DelegationDecision {
    log.info("delegation-guard.evaluate", {
      agent,
      action: decision.action,
      reason: decision.action === "allow" ? undefined : decision.reason,
      tier,
      findingsCount,
    });
    return decision;
  }

  function evaluate(agent: string, taskPrompt: string): DelegationDecision {
    const envelope = frontmatter.get(agent);
    if (!envelope || !envelope.enabled) {
      const reason = envelope ? `delegation disabled for agent "${agent}"` : `unknown delegation agent "${agent}"`;
      return logAndReturn(agent, { action: "deny", reason }, "n/a", 0);
    }

    const { tier, findings } = classifier.classify(taskPrompt);

    if (tier === "low") {
      return logAndReturn(agent, { action: "allow" }, tier, findings.length);
    }
    if (tier === "medium") {
      return logAndReturn(agent, { action: "confirm", reason: MEDIUM_TIER_REASON }, tier, findings.length);
    }

    // tier === "high" — resolved per the agent's static confirm_class.
    const reason = `task prompt flagged high risk (${findings.join(", ")})`;
    const decision: DelegationDecision =
      envelope.confirm_class === "deny" ? { action: "deny", reason } : { action: "confirm", reason };
    return logAndReturn(agent, decision, tier, findings.length);
  }

  return { evaluate };
}
