import type { Result } from "@sentient/protocol";
import { parse as parseYaml } from "yaml";
import { getLog } from "../logging/logger.js";
import {
  LOOPBACK_PORT_REASON,
  PUBLIC_PORT_REASON,
  type ServiceTemplate,
  ServiceTemplateSchema,
  isAllowedPortMapping,
} from "./types.js";

const log = getLog(["sentient", "system-orch", "template-loader"]);

/** Max chars of an offending port entry echoed into a log/error. */
const PORT_PREVIEW_MAX = 40;

export interface SecretAccessor {
  /** Returns the secret value for a dotted path like
   *  `home_assistant.mcp_server_token`, or null if missing. */
  resolve(path: string): string | null;
}

export type TemplateError =
  | { kind: "parse-error"; reason: string }
  | { kind: "schema-error"; reason: string }
  | { kind: "policy-violation"; reason: string }
  | { kind: "missing-secret"; envVar: string; path: string };

export interface LoadTemplateInput {
  yamlBody: string;
  /** env-var name → dotted secret path. */
  secretBindings: Record<string, string>;
  secrets: SecretAccessor;
  /** Host-side env vars (HOST_HOME, TZ, HOST_DOCKER_GID, etc.) used to
   *  resolve placeholders that aren't secret-bound. Resolved AFTER secrets;
   *  does not produce missing-secret errors. */
  hostEnv?: Record<string, string>;
  /** Grants the §2.3 public-port exception for THIS service. Comes from the
   *  service's policy entry (config.yaml#managed_services.<svc>.public_ports),
   *  never from the template body — a template cannot grant itself LAN exposure. */
  allowPublicPorts?: boolean;
}

const PLACEHOLDER_RE = /\$\{([A-Z][A-Z0-9_]*)\}/g;
const REDACTED = "***";

interface Substituted {
  body: string;
  /** Values that were inlined into the body. Redact these from any error
   *  message produced after substitution so secrets never reach logs or UI. */
  injectedValues: Set<string>;
}

export async function loadServiceTemplate(input: LoadTemplateInput): Promise<Result<ServiceTemplate, TemplateError>> {
  // Substitute first so an unresolved ${SECRET} surfaces as missing-secret
  // before zod ever sees the body.
  const substituted = substituteEnvPlaceholders(
    input.yamlBody,
    input.secretBindings,
    input.secrets,
    input.hostEnv ?? {},
  );
  if (!substituted.ok) return substituted;

  const { body, injectedValues } = substituted.value;

  let parsed: unknown;
  try {
    parsed = parseYaml(body);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const reason = redact(raw, injectedValues);
    log.warn("template.parse-error", { reason });
    return { ok: false, error: { kind: "parse-error", reason } };
  }

  // Reject non-loopback port publishing BEFORE schema parse so the error names
  // the security rule rather than surfacing as a generic zod message. The
  // schema enforces the same shape as defence in depth (it calls
  // isAllowedPortMapping(v, true) — shape only, since it cannot see policy).
  // Both this call and the schema's route through that one predicate, so the
  // two layers cannot drift.
  const portPolicy = enforcePortPolicy(parsed, input.allowPublicPorts === true);
  if (!portPolicy.ok) return portPolicy;

  const result = ServiceTemplateSchema.safeParse(parsed);
  if (!result.success) {
    const reason = redact(result.error.message, injectedValues);
    log.warn("template.schema-error", { reason });
    return { ok: false, error: { kind: "schema-error", reason } };
  }
  return { ok: true, value: result.data };
}

/** Every published port must bind loopback, unless this service's policy grants
 *  the narrow public exception (types.ts#isAllowedPortMapping). A bare
 *  `"8086:8086"` publishes on 0.0.0.0 (docker's default), which would put the
 *  addon on the LAN. */
function enforcePortPolicy(parsed: unknown, allowPublic: boolean): Result<undefined, TemplateError> {
  if (!parsed || typeof parsed !== "object") return { ok: true, value: undefined };
  const ports = (parsed as Record<string, unknown>).ports;
  if (ports === undefined) return { ok: true, value: undefined };
  const rule = allowPublic ? `${LOOPBACK_PORT_REASON}; ${PUBLIC_PORT_REASON}` : LOOPBACK_PORT_REASON;
  if (!Array.isArray(ports)) {
    return { ok: false, error: { kind: "policy-violation", reason: `ports must be a list; ${rule}` } };
  }
  for (const entry of ports) {
    if (typeof entry === "string" && isAllowedPortMapping(entry, allowPublic)) continue;
    const preview = String(entry).slice(0, PORT_PREVIEW_MAX);
    log.warn("template.port-policy-violation", { port: preview, allowPublic, reason: rule });
    return { ok: false, error: { kind: "policy-violation", reason: `${rule}; got ${preview}` } };
  }
  return { ok: true, value: undefined };
}

/** Resolve `${VAR}` placeholders from host env only — no secret bindings, no
 *  errors. Unresolved placeholders are left literal so the failure surfaces at
 *  the point of use (e.g. a native service's argv[0] that does not exist)
 *  rather than as a silently-empty string. */
export function substituteHostEnv(value: string, hostEnv: Record<string, string>): string {
  return value.replace(PLACEHOLDER_RE, (whole, envVar: string) => {
    const hostValue = hostEnv[envVar];
    return hostValue !== undefined && hostValue !== "" ? hostValue : whole;
  });
}

function substituteEnvPlaceholders(
  body: string,
  bindings: Record<string, string>,
  secrets: SecretAccessor,
  hostEnv: Record<string, string>,
): Result<Substituted, TemplateError> {
  let firstError: TemplateError | null = null;
  const injectedValues = new Set<string>();
  const out = body.replace(PLACEHOLDER_RE, (whole, envVar: string) => {
    const path = bindings[envVar];
    if (path !== undefined) {
      const value = secrets.resolve(path);
      if (value === null) {
        firstError ??= { kind: "missing-secret", envVar, path };
        return whole;
      }
      injectedValues.add(value);
      return value;
    }
    // No secret binding — try host env. If still unresolved, leave literal
    // (operator may rely on the container's own runtime env, e.g. NO_PROXY).
    const hostValue = hostEnv[envVar];
    if (hostValue !== undefined && hostValue !== "") {
      return hostValue;
    }
    return whole;
  });
  if (firstError) return { ok: false, error: firstError };
  return { ok: true, value: { body: out, injectedValues } };
}

function redact(message: string, values: Set<string>): string {
  let out = message;
  for (const v of values) {
    if (v.length === 0) continue;
    out = out.split(v).join(REDACTED);
  }
  return out;
}
