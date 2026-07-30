// The generic "provide an external tool's configuration" contract.
//
// An EXTERNAL tool is one the gateway does not supervise: no lifecycle, no
// port, no health check. Hermes is the first — invoked as a one-shot
// `hermes -p <userId> -z <prompt>` by `delegateTask` — but deliberately not the
// only one, so the shape here is an interface, not a Hermes special case.
//
// AT DISPATCH, NOT AT BOOT (owner's decision, task 9g). Task 9d ran this once
// per user per boot. That leaves a window: the user edits their own profile at
// 10am and every delegation until the next restart silently gets nothing —
// D8's failure mode wearing a fourth hat. Verifying at the moment of use makes
// drift STRUCTURALLY IMPOSSIBLE rather than merely detected, so `provide` is
// called from `tools/delegate-task.ts` immediately before the delegated agent
// is spawned. There is deliberately no second caller: two writers of one
// profile entry is a race with no owner.
//
// THE ADDITIVE RULE. The user's own MCP setup is theirs — they and Hermes edit
// it by hand and through an LLM. An implementation reads, compares ITS OWN one
// entry, and writes only that. It never prunes, reorders or normalises anything
// else. A declarative reconcile here would delete a user's own MCP servers on
// every delegation.

import type { Result } from "@sentient/protocol";

export type ExternalToolError =
  /** The tool's CLI could not be run, timed out, or exited non-zero. */
  | "cli-error"
  /** The CLI reported success but the change is absent — or still wrong — on
   *  read-back. Exit 0 is not evidence (NM-T9c). */
  | "not-registered"
  /** Nothing survived the delegated allow tier, so there was nothing to grant. */
  | "no-allow-tier-tools";

export interface ExternalTool {
  /** Log/grep handle. */
  readonly name: string;
  /**
   * Bring one user's configuration of this tool to the desired state.
   *
   * MUST be idempotent (it runs before every delegation), MUST be additive
   * (see the file header), and MUST NOT throw — a failure is a typed error the
   * caller logs and continues past. A delegated agent with fewer tools is
   * degraded; one that refuses to run is broken.
   */
  provide(userId: string): Promise<Result<void, ExternalToolError>>;
}
