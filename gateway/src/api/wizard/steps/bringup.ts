import { getLog } from "../../../logging/logger.js";
import { jsonResponse } from "../step-pipeline.js";
import type { WizardDeps } from "../step-pipeline.js";

const log = getLog(["sentient", "gateway", "api", "wizard", "step", "bringup"]);

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_CONFLICT = 409;
const HTTP_GONE = 410;
const HTTP_PRECONDITION_FAILED = 412;

export async function handleRetry(deps: WizardDeps, _req: Request): Promise<Response> {
  const data = await deps.installState.load();
  if (data.bootstrap_complete) return jsonResponse(HTTP_GONE, { error: "wizard-closed" });
  if (!data.unlock_verified) return jsonResponse(HTTP_UNAUTHORIZED, { error: "unlock-required" });
  if (data.wizard_cursor !== "bringup") {
    return jsonResponse(HTTP_CONFLICT, {
      error: "wizard-cursor-mismatch",
      current_cursor: data.wizard_cursor,
      expected_cursor: "bringup",
    });
  }

  if (!deps.systemOrchestrator) {
    log.warn("retry.no-orchestrator", {});
    return jsonResponse(HTTP_PRECONDITION_FAILED, { error: "no-orchestrator" });
  }
  void deps.systemOrchestrator.applyAll().catch((err: unknown) => {
    log.error("retry.crashed", { reason: String(err) });
  });
  log.info("retry.kicked", {});
  return jsonResponse(HTTP_OK, { ok: true });
}

export async function handleComplete(deps: WizardDeps, _req: Request): Promise<Response> {
  const status = deps.systemOrchestrator?.getStatus() ?? null;
  if (!status || status.state !== "ready") {
    log.warn("complete.not-ready", { state: status?.state ?? "no-orchestrator" });
    return jsonResponse(HTTP_PRECONDITION_FAILED, { error: "not-ready", status });
  }

  const advance = await deps.installState.advanceCursor("bringup", "admin");
  if (!advance.ok) {
    log.warn("complete.advance-failed", { error: advance.error.kind });
    return jsonResponse(HTTP_CONFLICT, { error: "transition", kind: advance.error.kind });
  }

  log.info("complete.success", {});
  return jsonResponse(HTTP_OK, { ok: true, cursor: "admin" });
}
