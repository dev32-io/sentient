import type { InstallState } from "../../admin/install-state.js";
import { getLog } from "../../logging/logger.js";
import type { ServiceVersionRecord, SystemOrchestratorService } from "../../system-orchestrator/index.js";
import type { TokenService } from "../../user-auth/token-service.js";

const log = getLog(["sentient", "gateway", "api", "services-versions"]);

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_PRECONDITION_FAILED = 412;
const HTTP_INTERNAL_ERROR = 500;

export interface ServicesVersionsDeps {
  installState: InstallState;
  systemOrchestrator: SystemOrchestratorService | null;
  gatewayVersion: string;
  hermesVersionPath: string;
  sttHealthUrl: string;
  ttsHealthUrl: string;
  tokens: Pick<TokenService, "validate">;
  /** Mirrors cfg.providers.fish_browse_enabled — surfaced so the webui can
   *  show/hide the "Clone from Fish Audio" tab without a separate fetch. */
  fishBrowseEnabled: boolean;
}

/** Namespaced, extensible feature-flag block appended to the versions
 *  payload. Add future operator-toggleable flags here, not as top-level
 *  fields, so the webui can extend `features` without a shape migration. */
export interface ServicesVersionsFeatures {
  fish_browse_enabled: boolean;
}

export type ServicesVersionsResponse = ServiceVersionRecord & { features: ServicesVersionsFeatures };

export type ServicesVersionsHandler = (req: Request) => Promise<Response>;

export function createServicesVersionsHandler(deps: ServicesVersionsDeps): ServicesVersionsHandler {
  return async (req: Request) => {
    if (req.method !== "GET") {
      return new Response("Method Not Allowed", { status: HTTP_METHOD_NOT_ALLOWED });
    }

    const token = readBearer(req);
    if (!token) {
      return Response.json({ error: "unauthorized" }, { status: HTTP_UNAUTHORIZED });
    }
    const valid = await deps.tokens.validate(token);
    if (!valid.ok) {
      return Response.json({ error: "unauthorized" }, { status: HTTP_UNAUTHORIZED });
    }

    // Bootstrap-complete check is orthogonal to version resolution — we still
    // gate this endpoint on install completion to avoid exposing data before
    // the setup wizard is done.
    let state: Awaited<ReturnType<InstallState["load"]>>;
    try {
      state = await deps.installState.load();
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error("services-versions.state-load-failed", { reason });
      return Response.json({ error: "state-load-failed", reason }, { status: HTTP_INTERNAL_ERROR });
    }

    if (!state.bootstrap_complete) {
      return Response.json({ error: "bootstrap-incomplete" }, { status: HTTP_PRECONDITION_FAILED });
    }

    const features: ServicesVersionsFeatures = { fish_browse_enabled: deps.fishBrowseEnabled };

    if (!deps.systemOrchestrator) {
      // Orchestrator not available — return gateway version only; other fields
      // degrade to "unknown" rather than crashing the webui version chips.
      const fallback: ServicesVersionsResponse = {
        gateway: deps.gatewayVersion,
        hermes: "unknown",
        stt_service: "unknown",
        tts_service: "unknown",
        features,
      };
      log.warn("services-versions.no-orchestrator", { userId: valid.value.userId });
      return Response.json(fallback, { status: HTTP_OK });
    }

    let versions: ServiceVersionRecord;
    try {
      versions = await deps.systemOrchestrator.getRequiredServicesStatus(
        deps.gatewayVersion,
        deps.hermesVersionPath,
        deps.sttHealthUrl,
        deps.ttsHealthUrl,
      );
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error("services-versions.resolve-failed", { reason });
      return Response.json({ error: "resolve-failed", reason }, { status: HTTP_INTERNAL_ERROR });
    }

    const response: ServicesVersionsResponse = { ...versions, features };
    log.debug("services-versions.fetched", { userId: valid.value.userId, fishBrowseEnabled: deps.fishBrowseEnabled });
    return Response.json(response, { status: HTTP_OK });
  };
}

function readBearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const parts = h.split(" ");
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") return null;
  return parts[1] ?? null;
}
