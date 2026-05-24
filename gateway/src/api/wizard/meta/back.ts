import { type WizardStepId, findStep } from "@sentient/wizard";
import { z } from "zod";
import { getLog } from "../../../logging/logger.js";
import { jsonResponse } from "../step-pipeline.js";
import type { WizardDeps } from "../step-pipeline.js";

const log = getLog(["sentient", "gateway", "api", "wizard", "meta", "back"]);

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_CONFLICT = 409;
const HTTP_GONE = 410;

const BackBody = z.object({
  from: z.enum(["voice", "secrets", "provider", "bringup", "admin", "finish"]),
});

export async function handleBack(deps: WizardDeps, req: Request): Promise<Response> {
  const data = await deps.installState.load();
  if (data.bootstrap_complete) return jsonResponse(HTTP_GONE, { error: "wizard-closed" });
  if (!data.unlock_verified) return jsonResponse(HTTP_UNAUTHORIZED, { error: "unlock-required" });

  const raw = await req.json().catch(() => null);
  const parsed = BackBody.safeParse(raw);
  if (!parsed.success) return jsonResponse(HTTP_BAD_REQUEST, { error: "invalid-body" });

  const def = findStep(parsed.data.from as WizardStepId);
  if (!def?.backTo) {
    log.warn("no-back-target", { from: parsed.data.from });
    return jsonResponse(HTTP_CONFLICT, { error: "no-back-target" });
  }

  const result = await deps.installState.retreatCursor(def.id, def.backTo);
  if (!result.ok) {
    log.warn("failed", { from: def.id, to: def.backTo, error: result.error.kind });
    return jsonResponse(HTTP_CONFLICT, { error: "transition", kind: result.error.kind });
  }

  log.info("success", { from: def.id, to: def.backTo });
  return jsonResponse(HTTP_OK, { ok: true, cursor: def.backTo });
}
