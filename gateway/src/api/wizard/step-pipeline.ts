import type { Result } from "@sentient/protocol";
import type { WizardStepDef, WizardStepId } from "@sentient/wizard";
import type { InstallState, WizardCursor } from "../../admin/install-state.js";
import type { LlmProvider, SecretsStore } from "../../admin/secrets-store.js";
import type { UnlockCode } from "../../admin/unlock-code.js";
import { getLog } from "../../logging/logger.js";
import type { ModelEntry } from "../../providers/catalogs/types.js";
import type { OrchestratorStatus } from "../../system-orchestrator/types.js";
import type { ProvidersListResult } from "../handlers/providers.js";

const log = getLog(["sentient", "gateway", "api", "wizard", "pipeline"]);

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_CONFLICT = 409;
const HTTP_GONE = 410;
const HTTP_INTERNAL_ERROR = 500;

export interface SystemOrchestratorHandle {
  getStatus(): OrchestratorStatus;
  applyAll(): Promise<OrchestratorStatus>;
}

export interface TestProviderResult {
  ok: boolean;
  modelCount?: number;
  sampleModels?: string[];
  error?: string;
}

export interface WizardDeps {
  installState: InstallState;
  unlockCode: UnlockCode;
  secretsStore: SecretsStore;
  testProvider: (provider: LlmProvider, apiKey: string | null, baseUrl: string | null) => Promise<TestProviderResult>;
  listModels?: () => Promise<ProvidersListResult<ModelEntry[]>>;
  systemOrchestrator?: SystemOrchestratorHandle | null;
}

export type StepError = { kind: string; reason?: string };

export interface StepHandler<Body> {
  id: WizardStepId;
  /** Pure: read JSON, zod-validate. Returns "invalid-body" on failure. */
  parse(req: Request): Promise<Result<Body, "invalid-body">>;
  /** Atomic side-effect application. Returns a step error on failure. */
  apply(deps: WizardDeps, body: Body): Promise<Result<void, StepError>>;
  /** Optional fire-and-forget hook fired AFTER cursor advance. */
  postAdvance?(deps: WizardDeps): void;
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function assertWizardOpen(state: InstallState, expectedCursor: WizardCursor): Promise<Response | null> {
  const data = await state.load();
  if (data.bootstrap_complete) return jsonResponse(HTTP_GONE, { error: "wizard-closed" });
  if (!data.unlock_verified) return jsonResponse(HTTP_UNAUTHORIZED, { error: "unlock-required" });
  if (data.wizard_cursor !== expectedCursor) {
    return jsonResponse(HTTP_CONFLICT, {
      error: "wizard-cursor-mismatch",
      current_cursor: data.wizard_cursor,
      expected_cursor: expectedCursor,
    });
  }
  return null;
}

export async function assertUnlockVerified(state: InstallState): Promise<Response | null> {
  const data = await state.load();
  if (data.bootstrap_complete) return jsonResponse(HTTP_GONE, { error: "wizard-closed" });
  if (!data.unlock_verified) return jsonResponse(HTTP_UNAUTHORIZED, { error: "unlock-required" });
  return null;
}

export async function runStep<B>(
  deps: WizardDeps,
  handler: StepHandler<B>,
  def: WizardStepDef,
  req: Request,
): Promise<Response> {
  const gate = await assertWizardOpen(deps.installState, def.id);
  if (gate) return gate;

  const parsed = await handler.parse(req);
  if (!parsed.ok) {
    log.warn(`wizard.${def.id}.invalid-body`, {});
    return jsonResponse(HTTP_BAD_REQUEST, { error: "invalid-body" });
  }

  const applied = await handler.apply(deps, parsed.value);
  if (!applied.ok) {
    log.warn(`wizard.${def.id}.apply-failed`, { error: applied.error.kind });
    return jsonResponse(HTTP_INTERNAL_ERROR, {
      error: "step-apply-failed",
      kind: applied.error.kind,
    });
  }

  if (def.advanceTo !== null) {
    const advance = await deps.installState.advanceCursor(def.id, def.advanceTo);
    if (!advance.ok) {
      log.warn(`wizard.${def.id}.advance-failed`, { error: advance.error.kind });
      return jsonResponse(HTTP_CONFLICT, { error: "transition", kind: advance.error.kind });
    }
  }

  try {
    handler.postAdvance?.(deps);
  } catch (err: unknown) {
    log.warn(`wizard.${def.id}.post-advance-throw`, { reason: String(err) });
  }

  log.info(`wizard.${def.id}.success`, { cursor: def.advanceTo });
  return jsonResponse(HTTP_OK, { ok: true, cursor: def.advanceTo });
}
