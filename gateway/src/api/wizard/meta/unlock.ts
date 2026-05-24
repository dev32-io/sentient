import { z } from "zod";
import { getLog } from "../../../logging/logger.js";
import { jsonResponse } from "../step-pipeline.js";
import type { WizardDeps } from "../step-pipeline.js";

const log = getLog(["sentient", "gateway", "api", "wizard", "meta", "unlock"]);

const UNLOCK_FAIL_DELAY_MS = 800;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_GONE = 410;
const HTTP_INTERNAL_ERROR = 500;

const UnlockBody = z.object({ code: z.string().regex(/^\d{6}$/) });

export async function handleUnlock(deps: WizardDeps, req: Request): Promise<Response> {
  const raw = await req.json().catch(() => null);
  const parsed = UnlockBody.safeParse(raw);
  if (!parsed.success) return jsonResponse(HTTP_BAD_REQUEST, { error: "invalid-body" });

  const data = await deps.installState.load();
  if (data.bootstrap_complete) return jsonResponse(HTTP_GONE, { error: "wizard-closed" });

  const valid = await deps.unlockCode.verify(parsed.data.code);
  if (!valid) {
    await new Promise<void>((resolve) => setTimeout(resolve, UNLOCK_FAIL_DELAY_MS));
    log.warn("failed", {});
    return jsonResponse(HTTP_UNAUTHORIZED, { error: "invalid-code" });
  }

  const result = await deps.installState.setUnlockVerified();
  if (!result.ok) {
    log.warn("set-verified-failed", { error: result.error.kind });
    return jsonResponse(HTTP_INTERNAL_ERROR, { error: "state-write-failed" });
  }
  log.info("success", {});
  return jsonResponse(HTTP_OK, { ok: true });
}
