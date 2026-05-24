import type { Result } from "@sentient/protocol";
import { z } from "zod";
import { getLog } from "../logging/logger.js";
import { type SecretAccessor, type TemplateError, loadServiceTemplate } from "./template-loader.js";
import {
  type ManagedService,
  type ManagedServiceConfig,
  ManagedServiceConfigSchema,
  type ServiceName,
  ServiceNameSchema,
} from "./types.js";

const log = getLog(["sentient", "system-orch", "service-registry"]);

export type RegistryError =
  | { kind: "config-schema-error"; reason: string }
  | { kind: "template-error"; service: ServiceName; cause: TemplateError }
  | { kind: "policy-violation"; service: ServiceName; reason: string }
  | { kind: "invalid-dependency"; service: ServiceName; missing: ServiceName };

export interface BuildRegistryInput {
  config: Record<string, unknown>;
  readTemplate: (name: string) => Promise<string>;
  secrets: SecretAccessor;
  /** Host-side env values (HOST_HOME, TZ, HOST_DOCKER_GID, etc.) substituted
   *  into templates after secret bindings are tried. */
  hostEnv?: Record<string, string>;
}

const ConfigMapSchema = z.record(ServiceNameSchema, ManagedServiceConfigSchema);

export async function buildServiceRegistry(
  input: BuildRegistryInput,
): Promise<Result<Map<ServiceName, ManagedService>, RegistryError>> {
  const cfgParse = ConfigMapSchema.safeParse(input.config);
  if (!cfgParse.success) {
    return { ok: false, error: { kind: "config-schema-error", reason: cfgParse.error.message } };
  }

  const out = new Map<ServiceName, ManagedService>();
  for (const [name, cfg] of Object.entries(cfgParse.data)) {
    const typedCfg = cfg as ManagedServiceConfig;
    const tplResult = await loadOneTemplate(name, typedCfg, input);
    if (!tplResult.ok) {
      // Optional services with missing secrets get skipped (logged), not
      // hard-failed — operator may not have provided HA/MA tokens yet.
      // Required services with any error still abort the registry build.
      if (
        typedCfg.optional &&
        tplResult.error.kind === "template-error" &&
        tplResult.error.cause.kind === "missing-secret"
      ) {
        log.info("registry.optional-skipped", {
          service: name,
          envVar: tplResult.error.cause.envVar,
          path: tplResult.error.cause.path,
        });
        continue;
      }
      return tplResult;
    }
    out.set(name, tplResult.value);
  }

  // depends_on validation requires the full registry to be populated first.
  for (const ms of out.values()) {
    for (const dep of ms.config.depends_on) {
      if (!out.has(dep)) {
        return { ok: false, error: { kind: "invalid-dependency", service: ms.name, missing: dep } };
      }
    }
  }

  log.info("registry.built", { count: out.size, services: Array.from(out.keys()) });
  return { ok: true, value: out };
}

async function loadOneTemplate(
  name: ServiceName,
  cfg: ManagedServiceConfig,
  input: BuildRegistryInput,
): Promise<Result<ManagedService, RegistryError>> {
  const yamlBody = await input.readTemplate(cfg.template);
  const tplResult = await loadServiceTemplate({
    yamlBody,
    secretBindings: cfg.secrets,
    secrets: input.secrets,
    ...(input.hostEnv ? { hostEnv: input.hostEnv } : {}),
  });
  if (!tplResult.ok) {
    return { ok: false, error: { kind: "template-error", service: name, cause: tplResult.error } };
  }
  const tpl = tplResult.value;

  if (!cfg.allowed_images.includes(tpl.image)) {
    return {
      ok: false,
      error: { kind: "policy-violation", service: name, reason: `image ${tpl.image} not in allowed_images` },
    };
  }

  for (const net of tpl.networks) {
    if (!cfg.networks.includes(net)) {
      return {
        ok: false,
        error: { kind: "policy-violation", service: name, reason: `template network ${net} not in config.networks` },
      };
    }
  }

  return { ok: true, value: { name, config: cfg, template: tpl } };
}
