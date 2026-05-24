import { z } from "zod";
import { type RouterDeps, runApplyRouted } from "../../apply/router.js";
import { getLog } from "../../logging/logger.js";

const log = getLog(["sentient", "api", "apply"]);

// HTTP status constants
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_UNAUTHORIZED = 401;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNPROCESSABLE = 422;

const ApplyBodySchema = z.object({
  profile: z.record(z.string(), z.unknown()).nullable().default(null),
  secrets: z.record(z.string(), z.record(z.string(), z.unknown())).nullable().default(null),
});

export interface ApplyHandlerDeps {
  routerDeps: RouterDeps;
  authenticate(req: Request): Promise<{ ok: true; userId: string } | { ok: false }>;
}

export function createApplyHandler(deps: ApplyHandlerDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== "POST") {
      return Response.json({ error: "method-not-allowed" }, { status: HTTP_METHOD_NOT_ALLOWED });
    }

    const auth = await deps.authenticate(req);
    if (!auth.ok) {
      return Response.json({ error: "unauthorized" }, { status: HTTP_UNAUTHORIZED });
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return Response.json({ error: "bad-json" }, { status: HTTP_BAD_REQUEST });
    }

    const parsed = ApplyBodySchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json({ error: "schema", detail: parsed.error.message }, { status: HTTP_UNPROCESSABLE });
    }

    const result = await runApplyRouted(parsed.data, deps.routerDeps, auth.userId);
    log.info("apply.routed", { userId: auth.userId, status: result.status });
    return Response.json(result.body, { status: result.status });
  };
}
