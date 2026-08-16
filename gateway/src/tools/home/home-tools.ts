import { z } from "zod";
import type { NativeToolRunner } from "../tool-broker.js";
import type { ToolResult } from "../tool-types.js";
import type { HomeAdapter, HomeEntity, HomeOutcome } from "./home-adapter.js";
import { resolveHomeEntity } from "./home-resolver.js";

const targetSchema = z
  .object({ target: z.string().min(1).max(256), area_id: z.string().min(1).max(128).optional() })
  .strict();
const searchSchema = z
  .object({
    query: z.string().min(1).max(256),
    area_id: z.string().min(1).max(128).optional(),
    kinds: z
      .array(z.enum(["entity", "scene", "script", "automation"]))
      .max(4)
      .optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();
const historySchema = targetSchema.extend({ start: z.string().datetime({ offset: true }).optional() });
const controlSchema = targetSchema.extend({ action: z.enum(["on", "off", "toggle"]) });
const operationSchema = z.object({ operation_id: z.string().uuid() }).strict();

function result(value: unknown, isError = false): ToolResult {
  return { content: JSON.stringify(value), isError };
}
function invalid(): ToolResult {
  return result({ outcome: "rejected", reason: "invalid_arguments" }, true);
}
function validate(schema: z.ZodType) {
  return (args: Record<string, unknown>): ToolResult | null => (schema.safeParse(args).success ? null : invalid());
}
function domainsForKinds(kinds?: readonly string[]): readonly string[] | undefined {
  if (!kinds || kinds.includes("entity")) return undefined;
  return kinds;
}
function entityView(entity: HomeEntity) {
  return {
    entity_id: entity.entityId,
    name: entity.name,
    state: entity.state,
    area_id: entity.areaId,
    last_changed: entity.lastChanged,
  };
}
function domain(entityId: string): string {
  return entityId.split(".")[0] ?? "";
}
function errorOutcome(outcome: HomeOutcome): boolean {
  return outcome === "unavailable" || outcome === "rejected" || outcome === "failed";
}

async function resolve(
  adapter: HomeAdapter,
  target: string,
  areaId: string | undefined,
  domains: readonly string[] | undefined,
  signal: AbortSignal,
) {
  const listed = await adapter.entities(signal);
  if (listed.outcome !== "succeeded") return listed;
  return resolveHomeEntity(listed.entities, target, { ...(areaId ? { areaId } : {}), ...(domains ? { domains } : {}) });
}

function definition(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  tier: "read" | "write",
): NativeToolRunner["definition"] {
  return {
    name,
    description,
    parameters,
    category: "foreground",
    tier,
    productGroup: "home",
    defaultExposure: "standard",
  };
}

const targetParameters = {
  type: "object",
  properties: { target: { type: "string", description: "Entity id or natural name" }, area_id: { type: "string" } },
  required: ["target"],
  additionalProperties: false,
};

export function buildHomeTools(adapter: HomeAdapter): readonly NativeToolRunner[] {
  const safeRun =
    (run: NativeToolRunner["run"]): NativeToolRunner["run"] =>
    async (args, ctx) => {
      try {
        return await run(args, ctx);
      } catch {
        return result({ outcome: "unavailable" }, true);
      }
    };

  return [
    {
      definition: definition(
        "home_overview",
        "Summarize current household entities and availability.",
        { type: "object", properties: {}, additionalProperties: false },
        "read",
      ),
      validate: validate(z.object({}).strict()),
      run: safeRun(async (_args, { signal }) => {
        const response = await adapter.overview(signal);
        if (response.outcome !== "succeeded") return result(response, true);
        const byDomain: Record<string, number> = {};
        for (const entity of response.entities)
          byDomain[domain(entity.entityId)] = (byDomain[domain(entity.entityId)] ?? 0) + 1;
        return result({
          outcome: "succeeded",
          total: response.entities.length,
          by_domain: byDomain,
          unavailable: response.entities
            .filter((e) => e.state === "unavailable")
            .slice(0, 30)
            .map(entityView),
        });
      }),
    },
    {
      definition: definition(
        "home_search",
        "Search entities, scenes, scripts, and automations by name, optionally in an area.",
        {
          type: "object",
          properties: {
            query: { type: "string" },
            area_id: { type: "string" },
            kinds: { type: "array", items: { enum: ["entity", "scene", "script", "automation"] }, maxItems: 4 },
            limit: { type: "integer", minimum: 1, maximum: 50 },
          },
          required: ["query"],
          additionalProperties: false,
        },
        "read",
      ),
      validate: validate(searchSchema),
      run: safeRun(async (args, { signal }) => {
        const parsed = searchSchema.parse(args);
        const listed = await adapter.entities(signal);
        if (listed.outcome !== "succeeded") return result(listed, true);
        const domains = domainsForKinds(parsed.kinds);
        const needle = parsed.query.toLocaleLowerCase("en-US");
        const matches = listed.entities
          .filter(
            (entity) =>
              (!parsed.area_id || entity.areaId === parsed.area_id) &&
              (!domains || domains.includes(domain(entity.entityId))) &&
              [entity.entityId, entity.name, ...entity.aliases].some((v) =>
                v.toLocaleLowerCase("en-US").includes(needle),
              ),
          )
          .sort((a, b) => a.entityId.localeCompare(b.entityId))
          .slice(0, parsed.limit ?? 20)
          .map(entityView);
        return result(matches.length ? { outcome: "succeeded", matches } : { outcome: "not_found", matches: [] });
      }),
    },
    {
      definition: definition(
        "home_state",
        "Read one entity's current state; ambiguity returns candidate ids.",
        targetParameters,
        "read",
      ),
      validate: validate(targetSchema),
      run: safeRun(async (args, { signal }) => {
        const parsed = targetSchema.parse(args);
        const found = await resolve(adapter, parsed.target, parsed.area_id, undefined, signal);
        if (found.outcome !== "succeeded") return result(found, found.outcome === "unavailable");
        const state = await adapter.state(found.entity.entityId, signal);
        return result(
          state.outcome === "succeeded" ? { outcome: "succeeded", entity: entityView(state.entity) } : state,
          state.outcome === "unavailable",
        );
      }),
    },
    {
      definition: definition(
        "home_history",
        "Read bounded recent state history for one entity.",
        {
          ...targetParameters,
          properties: { ...(targetParameters.properties as object), start: { type: "string", format: "date-time" } },
        },
        "read",
      ),
      validate: validate(historySchema),
      run: safeRun(async (args, { signal }) => {
        const parsed = historySchema.parse(args);
        const found = await resolve(adapter, parsed.target, parsed.area_id, undefined, signal);
        if (found.outcome !== "succeeded") return result(found, found.outcome === "unavailable");
        const response = await adapter.history(found.entity.entityId, parsed.start, signal);
        return result(response, response.outcome === "unavailable");
      }),
    },
    {
      definition: definition(
        "home_locations",
        "List configured floors, areas, and zones.",
        { type: "object", properties: {}, additionalProperties: false },
        "read",
      ),
      validate: validate(z.object({}).strict()),
      run: safeRun(async (_args, { signal }) => {
        const response = await adapter.locations(signal);
        return result(response, response.outcome === "unavailable");
      }),
    },
    {
      definition: definition(
        "home_camera",
        "Read permitted camera image metadata without exposing image bytes.",
        targetParameters,
        "read",
      ),
      validate: validate(targetSchema),
      run: safeRun(async (args, { signal }) => {
        const parsed = targetSchema.parse(args);
        const found = await resolve(adapter, parsed.target, parsed.area_id, ["camera"], signal);
        if (found.outcome !== "succeeded") return result(found, found.outcome === "unavailable");
        const response = await adapter.camera(found.entity.entityId, signal);
        return result(
          { ...response, ...(response.outcome === "succeeded" ? { entity_id: found.entity.entityId } : {}) },
          errorOutcome(response.outcome),
        );
      }),
    },
    {
      definition: definition(
        "home_operation",
        "Check a previously returned Home operation id.",
        {
          type: "object",
          properties: { operation_id: { type: "string", format: "uuid" } },
          required: ["operation_id"],
          additionalProperties: false,
        },
        "read",
      ),
      validate: validate(operationSchema),
      run: safeRun(async (args) => {
        const parsed = operationSchema.parse(args);
        const response = adapter.operation(parsed.operation_id);
        return result(response, response.outcome === "failed" || response.outcome === "rejected");
      }),
    },
    {
      definition: definition(
        "home_control",
        "Turn on, turn off, or toggle a routine light, switch, fan, or input boolean.",
        {
          ...targetParameters,
          properties: { ...(targetParameters.properties as object), action: { enum: ["on", "off", "toggle"] } },
          required: ["target", "action"],
        },
        "write",
      ),
      validate: validate(controlSchema),
      run: safeRun(async (args, { signal }) => {
        const parsed = controlSchema.parse(args);
        const found = await resolve(
          adapter,
          parsed.target,
          parsed.area_id,
          ["light", "switch", "fan", "input_boolean"],
          signal,
        );
        if (found.outcome !== "succeeded") return result(found, found.outcome === "unavailable");
        const response = await adapter.control(found.entity.entityId, parsed.action, signal);
        return result({ ...response, target_id: found.entity.entityId }, errorOutcome(response.outcome));
      }),
    },
    ...(["scene", "script", "automation"] as const).map(
      (kind): NativeToolRunner => ({
        definition: definition(
          `home_activate_${kind}`,
          `Activate one Home Assistant ${kind} by id or natural name.`,
          targetParameters,
          "write",
        ),
        validate: validate(targetSchema),
        run: safeRun(async (args, { signal }) => {
          const parsed = targetSchema.parse(args);
          const found = await resolve(adapter, parsed.target, parsed.area_id, [kind], signal);
          if (found.outcome !== "succeeded") return result(found, found.outcome === "unavailable");
          const response = await adapter.activate(found.entity.entityId, kind, signal);
          return result({ ...response, target_id: found.entity.entityId }, errorOutcome(response.outcome));
        }),
      }),
    ),
  ];
}
