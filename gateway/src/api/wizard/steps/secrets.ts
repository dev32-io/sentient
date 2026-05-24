import type { Result } from "@sentient/protocol";
import { SecretsBody } from "@sentient/wizard";
import type { z } from "zod";
import type { SecretsStore } from "../../../admin/secrets-store.js";
import { getLog } from "../../../logging/logger.js";
import type { StepError, StepHandler, WizardDeps } from "../step-pipeline.ts";

const log = getLog(["sentient", "gateway", "api", "wizard", "step", "secrets"]);

type Body = z.infer<typeof SecretsBody>;

async function writeAll(store: SecretsStore, body: Body): Promise<string | null> {
  const ha = body.home_assistant;
  if (ha) {
    if (ha.url !== undefined) {
      const r = await store.setHomeAssistantUrl(ha.url);
      if (!r.ok) return r.error.kind;
    }
    if (ha.local_ip !== undefined) {
      const r = await store.setHomeAssistantLocalIp(ha.local_ip);
      if (!r.ok) return r.error.kind;
    }
    if (ha.observe_token !== undefined) {
      const r = await store.setHomeAssistantToken("observe_token", ha.observe_token);
      if (!r.ok) return r.error.kind;
    }
    if (ha.mcp_server_token !== undefined) {
      const r = await store.setHomeAssistantToken("mcp_server_token", ha.mcp_server_token);
      if (!r.ok) return r.error.kind;
    }
  }
  const ma = body.music_assistant;
  if (ma) {
    if (ma.url !== undefined) {
      const r = await store.setMusicAssistantUrl(ma.url);
      if (!r.ok) return r.error.kind;
    }
    if (ma.local_ip !== undefined) {
      const r = await store.setMusicAssistantLocalIp(ma.local_ip);
      if (!r.ok) return r.error.kind;
    }
    if (ma.token !== undefined) {
      const r = await store.setMusicAssistantToken(ma.token);
      if (!r.ok) return r.error.kind;
    }
  }
  return null;
}

async function parse(req: Request): Promise<Result<Body, "invalid-body">> {
  const raw = await req.json().catch(() => null);
  const parsed = SecretsBody.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, error: "invalid-body" };
  return { ok: true, value: parsed.data };
}

async function apply(deps: WizardDeps, body: Body): Promise<Result<void, StepError>> {
  const writeError = await writeAll(deps.secretsStore, body);
  if (writeError) {
    log.warn("write-failed", { error: writeError });
    return { ok: false, error: { kind: "secrets-write-failed", reason: writeError } };
  }
  return { ok: true, value: undefined };
}

function postAdvance(deps: WizardDeps): void {
  if (!deps.systemOrchestrator) {
    log.warn("first-apply.no-orchestrator", {});
    return;
  }
  void deps.systemOrchestrator.applyAll().catch((err: unknown) => {
    log.error("first-apply.crashed", { reason: String(err) });
  });
}

export const secretsStep: StepHandler<Body> = {
  id: "secrets",
  parse,
  apply,
  postAdvance,
};
