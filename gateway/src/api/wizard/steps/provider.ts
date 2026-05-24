import type { Result } from "@sentient/protocol";
import { ProviderBody } from "@sentient/wizard";
import type { z } from "zod";
import { getLog } from "../../../logging/logger.js";
import type { StepError, StepHandler, WizardDeps } from "../step-pipeline.ts";

const log = getLog(["sentient", "gateway", "api", "wizard", "step", "provider"]);

type Body = z.infer<typeof ProviderBody>;

async function parse(req: Request): Promise<Result<Body, "invalid-body">> {
  const raw = await req.json().catch(() => null);
  const parsed = ProviderBody.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid-body" };
  return { ok: true, value: parsed.data };
}

async function apply(deps: WizardDeps, body: Body): Promise<Result<void, StepError>> {
  const { provider, api_key, base_url } = body;
  const patch = { api_key: api_key ?? null, base_url: base_url ?? null };

  const keyResult = await deps.secretsStore.setLlmProviderKey(provider, patch);
  if (!keyResult.ok) {
    log.warn("set-key-failed", { provider, error: keyResult.error.kind });
    return { ok: false, error: { kind: "secrets-write-failed" } };
  }

  const activeResult = await deps.secretsStore.setActiveLlmProvider(provider);
  if (!activeResult.ok) {
    log.warn("set-active-failed", { provider, error: activeResult.error.kind });
    return { ok: false, error: { kind: "secrets-write-failed" } };
  }

  return { ok: true, value: undefined };
}

export const providerStep: StepHandler<Body> = {
  id: "provider",
  parse,
  apply,
};
