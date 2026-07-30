// The generic "configure external tool" handler.
//
// An EXTERNAL tool is one the gateway does not supervise: no lifecycle, no
// port, no health check. Hermes is the first — invoked as a one-shot
// `hermes -p <userId> -z <prompt>` by `delegateTask` — but deliberately not the
// only one, so the shape here is a list of implementations, not a Hermes
// special case. Adding a second tool is a new `ExternalTool` plus one line at
// the composition root; making that set declarative (YAML, like `mcp_catalog`)
// is the next step and is recorded in `docs/native-todo.md` § 3.
//
// ORDERING IS A CORRECTNESS CONSTRAINT, not a preference. Configuring before
// the gateway's internal dependencies are up writes config pointing at a
// socket nothing serves — silent, and indistinguishable from the defect this
// handler exists to fix. So the runner takes an explicit readiness gate and,
// when it does not resolve ready, SKIPS loudly rather than configuring blind.
//
// This handler repairs. The destination is installation-time configuration
// (`docs/native-todo.md` § 3), at which point it degrades to a check that
// WARNs on drift — same seam, less authority.

import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "external-tools", "handler"]);

export type ExternalToolError =
  /** The tool's CLI could not be run, timed out, or exited non-zero. */
  | "cli-error"
  /** The CLI reported success but the change is absent on read-back. */
  | "not-registered"
  /** Nothing survived the delegated allow tier, so there was nothing to grant. */
  | "no-allow-tier-tools";

export interface ExternalTool {
  /** Log/grep handle. */
  readonly name: string;
  /** Bring one user's configuration of this tool to the desired state.
   *  MUST be idempotent: it runs on every boot for every user, and again the
   *  moment a user is created. */
  configure(userId: string): Promise<Result<void, ExternalToolError>>;
}

export interface ExternalToolConfigurationDeps {
  readonly tools: readonly ExternalTool[];
  /** User ids to configure. */
  listUserIds(): Promise<readonly string[]>;
  /**
   * Resolves true once the gateway's own dependencies (docker addons, native
   * addons, the per-user MCP sockets) are up. Resolving false — or never
   * resolving, which the caller turns into false — means configuration is
   * skipped, not attempted.
   */
  internalDependenciesReady(): Promise<boolean>;
}

/**
 * Run every external tool's configuration for every user, once, at startup.
 * Never throws: a per-user, per-tool failure is logged and the run continues.
 */
export async function configureExternalTools(deps: ExternalToolConfigurationDeps): Promise<void> {
  if (deps.tools.length === 0) {
    log.debug("external-tools.noop", { reason: "no-tools-registered" });
    return;
  }

  const ready = await deps.internalDependenciesReady();
  if (!ready) {
    log.warn("external-tools.skipped", {
      tools: deps.tools.map((t) => t.name),
      reason: "internal dependencies never reported ready; configuring now would point at sockets nothing serves",
    });
    return;
  }

  const userIds = await deps.listUserIds();
  log.info("external-tools.start", { tools: deps.tools.map((t) => t.name), users: userIds.length });
  for (const tool of deps.tools) {
    for (const userId of userIds) {
      const result = await tool.configure(userId);
      if (result.ok) continue;
      log.warn("external-tools.configure-failed", { tool: tool.name, userId, error: result.error });
    }
  }
  log.info("external-tools.done", { tools: deps.tools.map((t) => t.name), users: userIds.length });
}
