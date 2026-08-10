import { ADMIN_ROLE, type Result, type UserRole } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import { isDockerService } from "../system-orchestrator/types.js";
import type { ManagedService, OrchestratorStatus, ServiceName } from "../system-orchestrator/types.js";

const log = getLog(["sentient", "apply", "router"]);

export interface ApplyBody {
  profile: Record<string, unknown> | null;
  secrets: Record<string, Record<string, unknown>> | null;
}

export interface RouterDeps {
  /** The user's CURRENT role, or `null` when no such user exists. Returning
   *  the role rather than a boolean keeps the one decision below — "may this
   *  caller apply system-level config?" — in this file, instead of splitting
   *  it across a predicate whose name would stop matching the vocabulary. */
  roleOf(userId: string): Promise<UserRole | null>;
  /** Returns the dotted-path list of secrets that changed vs the stored
   *  values, given the inbound `secrets` partial. Empty array on no change. */
  diffSecrets(secrets: ApplyBody["secrets"]): Promise<string[]>;
  perUserApply(
    userId: string,
    profile: ApplyBody["profile"],
  ): Promise<Result<{ state: string; elapsedMs: number }, { kind: string; reason?: string }>>;
  systemOrchestrator: { applySubset(names: ReadonlySet<ServiceName>): Promise<OrchestratorStatus> };
  registry: Map<ServiceName, ManagedService>;
}

export interface ApplyRouterResult {
  status: number;
  body: { error?: string; perUser?: unknown; system?: OrchestratorStatus | null };
}

export interface ApplyDiff {
  userLevel: ApplyBody["profile"];
  systemLevel: ApplyBody["secrets"];
}

export function splitApplyDiff(body: ApplyBody): ApplyDiff {
  return { userLevel: body.profile ?? null, systemLevel: body.secrets ?? null };
}

export async function runApplyRouted(body: ApplyBody, deps: RouterDeps, userId: string): Promise<ApplyRouterResult> {
  const diff = splitApplyDiff(body);
  const hasUser = diff.userLevel !== null;
  const hasSystem = diff.systemLevel !== null;

  if (!hasUser && !hasSystem) {
    return { status: 200, body: { perUser: null, system: null } };
  }

  if (hasSystem) {
    const role = await deps.roleOf(userId);
    if (role !== ADMIN_ROLE) {
      log.warn("router.rbac-denied", { userId, role });
      return { status: 403, body: { error: "admin role required" } };
    }
  }

  const out: ApplyRouterResult["body"] = { perUser: null, system: null };

  if (hasUser) {
    const userResult = await deps.perUserApply(userId, diff.userLevel);
    out.perUser = userResult;
  }

  if (hasSystem) {
    const changedPaths = await deps.diffSecrets(diff.systemLevel);
    if (changedPaths.length > 0) {
      const targets = collectTargets(deps.registry, changedPaths);
      out.system = await deps.systemOrchestrator.applySubset(targets);
    }
  }

  return { status: 200, body: out };
}

function collectTargets(reg: Map<ServiceName, ManagedService>, changed: ReadonlyArray<string>): Set<ServiceName> {
  const out = new Set<ServiceName>();
  const want = new Set(changed);
  for (const ms of reg.values()) {
    // Only docker services bind secrets; a native service's argv carries no
    // secret material, so a secrets diff can never target one.
    if (!isDockerService(ms)) continue;
    for (const path of Object.values(ms.config.secrets)) {
      if (want.has(path)) out.add(ms.name);
    }
  }
  return out;
}
