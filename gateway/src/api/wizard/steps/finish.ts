import { getLog } from "../../../logging/logger.js";
import { jsonResponse } from "../step-pipeline.js";
import type { WizardDeps } from "../step-pipeline.js";

const log = getLog(["sentient", "gateway", "api", "wizard", "step", "finish"]);

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_CONFLICT = 409;
const HTTP_GONE = 410;
const HTTP_INTERNAL_ERROR = 500;

export async function handleFinish(deps: WizardDeps, _req: Request): Promise<Response> {
  const data = await deps.installState.load();
  if (data.bootstrap_complete) return jsonResponse(HTTP_GONE, { error: "wizard-closed" });
  if (!data.unlock_verified) return jsonResponse(HTTP_UNAUTHORIZED, { error: "unlock-required" });
  if (data.wizard_cursor !== "finish") {
    return jsonResponse(HTTP_CONFLICT, {
      error: "wizard-cursor-mismatch",
      current_cursor: data.wizard_cursor,
      expected_cursor: "finish",
    });
  }

  const finishResult = await deps.installState.finish();
  if (!finishResult.ok) {
    log.warn("finish-failed", { error: finishResult.error.kind });
    return jsonResponse(HTTP_INTERNAL_ERROR, { error: "state-write-failed" });
  }

  await deps.unlockCode.clear();
  log.info("success", {});
  return jsonResponse(HTTP_OK, { ok: true });
}
