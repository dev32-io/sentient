import type { Result } from "@sentient/protocol";
import { VoiceBody } from "@sentient/wizard";
import type { z } from "zod";
import { getLog } from "../../../logging/logger.js";
import type { StepError, StepHandler, WizardDeps } from "../step-pipeline.ts";

const log = getLog(["sentient", "gateway", "api", "wizard", "step", "voice"]);

type Body = z.infer<typeof VoiceBody>;

async function parse(req: Request): Promise<Result<Body, "invalid-body">> {
  const raw = await req.json().catch(() => null);
  const parsed = VoiceBody.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid-body" };
  return { ok: true, value: parsed.data };
}

async function apply(deps: WizardDeps, body: Body): Promise<Result<void, StepError>> {
  if ("skip" in body) {
    log.info("skipped", {});
    return { ok: true, value: undefined };
  }
  const result = await deps.secretsStore.setFishAudioKey(body.api_key);
  if (!result.ok) {
    log.warn("set-key-failed", { error: result.error.kind });
    return { ok: false, error: { kind: "secrets-write-failed" } };
  }
  return { ok: true, value: undefined };
}

export const voiceStep: StepHandler<Body> = {
  id: "voice",
  parse,
  apply,
};
