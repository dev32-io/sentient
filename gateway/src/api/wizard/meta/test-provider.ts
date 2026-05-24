import { ProviderBody } from "@sentient/wizard";
import { getLog } from "../../../logging/logger.js";
import { assertUnlockVerified, jsonResponse } from "../step-pipeline.ts";
import type { WizardDeps } from "../step-pipeline.ts";

const log = getLog(["sentient", "gateway", "api", "wizard", "meta", "test-provider"]);

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;

export async function handleTestProvider(deps: WizardDeps, req: Request): Promise<Response> {
  const gate = await assertUnlockVerified(deps.installState);
  if (gate) return gate;

  const raw = await req.json().catch(() => null);
  const parsed = ProviderBody.safeParse(raw);
  if (!parsed.success) return jsonResponse(HTTP_BAD_REQUEST, { error: "invalid-body" });

  const { provider, api_key, base_url } = parsed.data;
  log.debug("start", { provider });
  const result = await deps.testProvider(provider, api_key ?? null, base_url ?? null);
  log.info("result", { provider, ok: result.ok, modelCount: result.modelCount });
  return jsonResponse(HTTP_OK, result);
}
