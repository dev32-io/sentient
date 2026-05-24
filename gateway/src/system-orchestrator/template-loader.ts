import type { Result } from "@sentient/protocol";
import { parse as parseYaml } from "yaml";
import { getLog } from "../logging/logger.js";
import { type ServiceTemplate, ServiceTemplateSchema } from "./types.js";

const log = getLog(["sentient", "system-orch", "template-loader"]);

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

  // Reject port-binding shapes BEFORE schema parse so the error is specific.
  if (parsed && typeof parsed === "object" && "ports" in (parsed as Record<string, unknown>)) {
    return {
      ok: false,
      error: { kind: "policy-violation", reason: "ports field is forbidden" },
    };
  }

  const result = ServiceTemplateSchema.safeParse(parsed);
  if (!result.success) {
    const reason = redact(result.error.message, injectedValues);
    log.warn("template.schema-error", { reason });
    return { ok: false, error: { kind: "schema-error", reason } };
  }
  return { ok: true, value: result.data };
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
