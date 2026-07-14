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

// local-tts needs no API key — this step just acknowledges and advances the
// wizard cursor. Per-user voice selection happens later via profile.json#voice.id
// (defaults to "default"); an in-app voice-cloning UI is a future webui feature,
// not a wizard concern.
async function apply(_deps: WizardDeps, _body: Body): Promise<Result<void, StepError>> {
  log.info("acknowledged", {});
  return { ok: true, value: undefined };
}

export const voiceStep: StepHandler<Body> = {
  id: "voice",
  parse,
  apply,
};
