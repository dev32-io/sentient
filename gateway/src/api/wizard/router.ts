import { type WizardStepId, findStep } from "@sentient/wizard";
import { getLog } from "../../logging/logger.js";
import { handleBack } from "./meta/back.js";
import { handleActiveLlm, handleModels, handleVoices } from "./meta/catalog.js";
import { handleTestProvider } from "./meta/test-provider.js";
import { handleUnlock } from "./meta/unlock.js";
import { type StepHandler, type WizardDeps, jsonResponse, runStep } from "./step-pipeline.js";
import { handleComplete, handleRetry } from "./steps/bringup.js";
import { handleFinish } from "./steps/finish.js";
import { providerStep } from "./steps/provider.js";
import { secretsStep } from "./steps/secrets.js";
import { voiceStep } from "./steps/voice.js";

const log = getLog(["sentient", "gateway", "api", "wizard", "router"]);

const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;

const STEP_HANDLERS: Partial<Record<WizardStepId, StepHandler<unknown>>> = {
  provider: providerStep as StepHandler<unknown>,
  voice: voiceStep as StepHandler<unknown>,
  secrets: secretsStep as StepHandler<unknown>,
  // bringup: bespoke handleRetry/handleComplete (not runStep-driven)
  // admin:   bespoke (advance triggered from /auth/setup, no /wizard/admin POST)
  // finish:  bespoke handleFinish
};

export function createWizardRouter(deps: WizardDeps): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    log.debug("request", { method: req.method, path });

    if (req.method === "GET") {
      if (path === "/api/v1/wizard/active-llm") return handleActiveLlm(deps);
      if (path === "/api/v1/wizard/providers/models") return handleModels(deps);
      if (path === "/api/v1/wizard/providers/voices") return handleVoices(deps, url);
      return jsonResponse(HTTP_NOT_FOUND, { error: "not-found" });
    }

    if (req.method !== "POST") {
      return jsonResponse(HTTP_METHOD_NOT_ALLOWED, { error: "method-not-allowed" });
    }

    if (path === "/api/v1/wizard/unlock") return handleUnlock(deps, req);
    if (path === "/api/v1/wizard/back") return handleBack(deps, req);
    if (path === "/api/v1/wizard/test-provider") return handleTestProvider(deps, req);
    if (path === "/api/v1/wizard/retry-bringup") return handleRetry(deps, req);
    if (path === "/api/v1/wizard/complete-bringup") return handleComplete(deps, req);
    if (path === "/api/v1/wizard/finalize") return handleFinish(deps, req);

    // Step-pipeline dispatch: /api/v1/wizard/<step-id>
    const stepMatch = path.match(/^\/api\/v1\/wizard\/([a-z]+)$/);
    if (stepMatch) {
      const id = stepMatch[1] as WizardStepId;
      const handler = STEP_HANDLERS[id];
      const def = findStep(id);
      if (handler && def) return runStep(deps, handler, def, req);
    }

    return jsonResponse(HTTP_NOT_FOUND, { error: "not-found" });
  };
}
