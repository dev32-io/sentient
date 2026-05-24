import { parse as parseYaml } from "yaml";
import type { ZodType, ZodTypeDef } from "zod";

const ENV_VAR_PATTERN = /\$\{([^}]+)\}/g;

/** Replace ${VAR} placeholders with environment variable values.
 *  Missing env vars resolve to empty string — non-secret config values
 *  like voice_id may be unset in dev environments. */
export function resolveEnvVars(value: string): string {
  return value.replace(ENV_VAR_PATTERN, (_, varName: string) => {
    return process.env[varName] ?? "";
  });
}

/** Recursively resolve env vars in a parsed YAML object */
export function resolveEnvVarsDeep(obj: unknown): unknown {
  if (typeof obj === "string") return resolveEnvVars(obj);
  if (Array.isArray(obj)) return obj.map(resolveEnvVarsDeep);
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvVarsDeep(value);
    }
    return result;
  }
  return obj;
}

/** Load and validate a YAML config file */
export function loadConfig<Output, Def extends ZodTypeDef, Input>(
  yamlContent: string,
  schema: ZodType<Output, Def, Input>,
): Output {
  const raw = parseYaml(yamlContent);
  const resolved = resolveEnvVarsDeep(raw);
  return schema.parse(resolved) as Output;
}
