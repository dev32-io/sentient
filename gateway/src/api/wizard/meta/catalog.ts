import { getLog } from "../../../logging/logger.js";
import { assertUnlockVerified, jsonResponse } from "../step-pipeline.js";
import type { ListVoicesOptions, WizardDeps } from "../step-pipeline.js";

const log = getLog(["sentient", "gateway", "api", "wizard", "meta", "catalog"]);

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVICE_UNAVAILABLE = 503;

export async function handleActiveLlm(deps: WizardDeps): Promise<Response> {
  const gate = await assertUnlockVerified(deps.installState);
  if (gate) return gate;

  const result = await deps.secretsStore.getActiveLlm();
  if (!result.ok) {
    log.warn("active-llm.failed", { kind: result.error.kind });
    return jsonResponse(HTTP_NOT_FOUND, { error: "no-provider-configured" });
  }
  log.debug("active-llm.ok", { provider: result.value.provider });
  return jsonResponse(HTTP_OK, { provider: result.value.provider });
}

export async function handleModels(deps: WizardDeps): Promise<Response> {
  const gate = await assertUnlockVerified(deps.installState);
  if (gate) return gate;

  if (!deps.listModels) {
    log.warn("providers-models.no-impl", {});
    return jsonResponse(HTTP_NOT_FOUND, { error: "not-configured" });
  }

  const result = await deps.listModels();
  if (!result.ok) {
    log.warn("providers-models.upstream-failed", { kind: result.error.kind });
    return jsonResponse(HTTP_SERVICE_UNAVAILABLE, { error: "upstream-unavailable" });
  }
  const stale = result.stale ?? false;
  log.info("providers-models.ok", { count: result.value.length, stale });
  return jsonResponse(HTTP_OK, { models: result.value, stale });
}

export async function handleVoices(deps: WizardDeps, url: URL): Promise<Response> {
  const gate = await assertUnlockVerified(deps.installState);
  if (gate) return gate;

  if (!deps.listVoices) {
    log.warn("providers-voices.no-impl", {});
    return jsonResponse(HTTP_NOT_FOUND, { error: "not-configured" });
  }

  const opts = parseListVoicesOptions(url.searchParams);
  const result = await deps.listVoices(opts);
  if (!result.ok) {
    log.warn("providers-voices.upstream-failed", { kind: result.error.kind });
    return jsonResponse(HTTP_SERVICE_UNAVAILABLE, { error: "upstream-unavailable" });
  }
  const stale = result.stale ?? false;
  log.info("providers-voices.ok", { count: result.value.voices.length, hasMore: result.value.hasMore, stale });
  return jsonResponse(HTTP_OK, { voices: result.value.voices, hasMore: result.value.hasMore, stale });
}

function parseListVoicesOptions(params: URLSearchParams): ListVoicesOptions {
  const opts: ListVoicesOptions = {};
  const title = params.get("title");
  if (title !== null) opts.title = title;
  const pageRaw = params.get("page");
  if (pageRaw !== null) {
    const page = Number.parseInt(pageRaw, 10);
    if (Number.isFinite(page) && page >= 1) opts.page = page;
  }
  return opts;
}
