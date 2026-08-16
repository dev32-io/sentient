import { z } from "zod";

const entityId = z.string().regex(/^[a-z0-9_]+\.[a-z0-9_]+$/);
const resourceId = z
  .string()
  .regex(/^[a-z0-9_]+$/)
  .max(128);
const name = z.string().trim().min(1).max(256);
const scalar = z.union([z.string().max(1024), z.number().finite(), z.boolean(), z.null()]);
const target = z
  .object({
    entity_id: z.union([entityId, z.array(entityId).min(1).max(50)]).optional(),
    area_id: z.union([resourceId, z.array(resourceId).min(1).max(20)]).optional(),
  })
  .strict()
  .refine((value) => value.entity_id !== undefined || value.area_id !== undefined, "target is empty");

export const homeTriggerSchema = z.union([
  z.object({ platform: z.literal("time"), at: z.string().min(1).max(128) }).strict(),
  z
    .object({ platform: z.literal("sun"), event: z.enum(["sunrise", "sunset"]), offset: z.string().max(32).optional() })
    .strict(),
  z
    .object({
      platform: z.literal("state"),
      entity_id: entityId,
      from: z.string().max(512).optional(),
      to: z.string().max(512).optional(),
      for: z.string().max(32).optional(),
    })
    .strict(),
  z
    .object({
      platform: z.literal("numeric_state"),
      entity_id: entityId,
      above: z.number().finite().optional(),
      below: z.number().finite().optional(),
      for: z.string().max(32).optional(),
    })
    .strict()
    .refine((v) => v.above !== undefined || v.below !== undefined),
  z
    .object({
      platform: z.literal("event"),
      event_type: z
        .string()
        .regex(/^[a-zA-Z0-9_]+$/)
        .max(128),
      event_data: z.record(scalar).optional(),
    })
    .strict(),
  z
    .object({
      platform: z.literal("device"),
      device_id: resourceId,
      domain: resourceId,
      type: resourceId,
      entity_id: entityId.optional(),
    })
    .strict(),
  z
    .object({
      platform: z.literal("zone"),
      entity_id: entityId,
      zone: entityId.regex(/^zone\./),
      event: z.enum(["enter", "leave"]),
    })
    .strict(),
]);

export const homeConditionSchema: z.ZodType = z.lazy(() =>
  z.union([
    z
      .object({
        condition: z.literal("state"),
        entity_id: entityId,
        state: z.string().max(512),
        for: z.string().max(32).optional(),
      })
      .strict(),
    z
      .object({
        condition: z.literal("numeric_state"),
        entity_id: entityId,
        above: z.number().finite().optional(),
        below: z.number().finite().optional(),
      })
      .strict()
      .refine((v) => v.above !== undefined || v.below !== undefined),
    z
      .object({
        condition: z.literal("time"),
        after: z.string().max(32).optional(),
        before: z.string().max(32).optional(),
        weekday: z
          .array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]))
          .max(7)
          .optional(),
      })
      .strict(),
    z
      .object({
        condition: z.literal("sun"),
        after: z.enum(["sunrise", "sunset"]).optional(),
        before: z.enum(["sunrise", "sunset"]).optional(),
        after_offset: z.string().max(32).optional(),
        before_offset: z.string().max(32).optional(),
      })
      .strict(),
    z
      .object({ condition: z.enum(["and", "or", "not"]), conditions: z.array(homeConditionSchema).min(1).max(20) })
      .strict(),
  ]),
);

export const homeActionSchema: z.ZodType = z.lazy(() =>
  z.union([
    z
      .object({
        action: z.string().regex(/^[a-z0-9_]+\.[a-z0-9_]+$/),
        target: target.optional(),
        data: z.record(scalar).optional(),
      })
      .strict(),
    z.object({ delay: z.string().min(1).max(32) }).strict(),
    z.object({ scene: entityId.regex(/^scene\./) }).strict(),
    z.object({ condition: homeConditionSchema }).strict(),
    z
      .object({
        choose: z
          .array(
            z
              .object({
                conditions: z.array(homeConditionSchema).max(20),
                sequence: z.array(homeActionSchema).min(1).max(50),
              })
              .strict(),
          )
          .min(1)
          .max(20),
        default: z.array(homeActionSchema).max(50).optional(),
      })
      .strict(),
  ]),
);

export const sceneConfigSchema = z
  .object({
    name,
    icon: z.string().max(128).optional(),
    entities: z
      .record(
        z.union([
          z.string().max(512),
          z.object({ state: z.string().max(512), attributes: z.record(scalar).optional() }).strict(),
        ]),
      )
      .refine((value) => Object.keys(value).length > 0),
  })
  .strict();

export const scriptConfigSchema = z
  .object({
    alias: name,
    description: z.string().max(1024).optional(),
    mode: z.enum(["single", "restart", "queued", "parallel"]).optional(),
    max: z.number().int().min(1).max(100).optional(),
    sequence: z.array(homeActionSchema).min(1).max(100),
  })
  .strict();

const automationBodySchema = z
  .object({
    alias: name,
    description: z.string().max(1024).optional(),
    mode: z.enum(["single", "restart", "queued", "parallel"]).optional(),
    trigger: z.array(homeTriggerSchema).min(1).max(50),
    condition: z.array(homeConditionSchema).max(50).default([]),
    action: z.array(homeActionSchema).min(1).max(100),
  })
  .strict();
const blueprintAutomationSchema = z
  .object({
    alias: name,
    description: z.string().max(1024).optional(),
    use_blueprint: z
      .object({
        path: z
          .string()
          .regex(/^[a-zA-Z0-9_./-]+\.ya?ml$/)
          .max(256),
        input: z.record(z.unknown()).default({}),
      })
      .strict(),
  })
  .strict();
export const automationConfigSchema = z.union([automationBodySchema, blueprintAutomationSchema]);

export const configKindSchema = z.enum(["scene", "script", "automation"]);
export type HomeConfigKind = z.infer<typeof configKindSchema>;
export type HomeConfig =
  | z.infer<typeof sceneConfigSchema>
  | z.infer<typeof scriptConfigSchema>
  | z.infer<typeof automationConfigSchema>;
export const schemaForConfigKind = (kind: HomeConfigKind): z.ZodType =>
  kind === "scene" ? sceneConfigSchema : kind === "script" ? scriptConfigSchema : automationConfigSchema;

export const todoAddSchema = z
  .object({
    list: name,
    summary: name,
    description: z.string().max(2048).optional(),
    due: z.string().max(64).optional(),
  })
  .strict();
export const todoUpdateSchema = z
  .object({
    list: name,
    uid: z.string().min(1).max(256),
    summary: name.optional(),
    description: z.string().max(2048).optional(),
    due: z.string().max(64).nullable().optional(),
    status: z.enum(["needs_action", "completed"]).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.summary !== undefined ||
      value.description !== undefined ||
      value.due !== undefined ||
      value.status !== undefined,
    "no todo changes supplied",
  );
export const todoRemoveSchema = z.object({ list: name, uid: z.string().min(1).max(256) }).strict();
export const calendarReadSchema = z
  .object({ calendar: name, start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }) })
  .strict()
  .refine((v) => Date.parse(v.start) < Date.parse(v.end));
const eventFields = {
  summary: name,
  description: z.string().max(4096).optional(),
  location: z.string().max(512).optional(),
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
};
export const calendarCreateSchema = z
  .object({ calendar: name, ...eventFields })
  .strict()
  .refine((v) => Date.parse(v.start) < Date.parse(v.end));
export const calendarUpdateSchema = z
  .object({ calendar: name, uid: z.string().min(1).max(512), ...eventFields })
  .strict()
  .refine((v) => Date.parse(v.start) < Date.parse(v.end));
export const calendarRemoveSchema = z
  .object({ calendar: name, uid: z.string().min(1).max(512), recurrence_id: z.string().max(128).optional() })
  .strict();

/** Extract references for validation before a write reaches HomeAdapter. */
export function configReferences(value: unknown): { entities: Set<string>; areas: Set<string> } {
  const entities = new Set<string>();
  const areas = new Set<string>();
  const visit = (node: unknown, key?: string): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, key);
      return;
    }
    if (!node || typeof node !== "object") {
      if (typeof node === "string" && (key === "entity_id" || key === "scene" || key === "zone")) entities.add(node);
      if (typeof node === "string" && key === "area_id") areas.add(node);
      return;
    }
    for (const [childKey, child] of Object.entries(node)) {
      if (key === "entities" && /^[a-z0-9_]+\.[a-z0-9_]+$/.test(childKey)) entities.add(childKey);
      if (/^[a-z0-9_]+\.[a-z0-9_]+$/.test(childKey) && key === "input") entities.add(childKey);
      visit(child, childKey);
    }
  };
  visit(value);
  return { entities, areas };
}

export { entityId, resourceId };
