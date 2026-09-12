import { describe, expect, test } from "bun:test";
import type { ScheduleCreateRequest } from "@sentient/protocol";
import { PrivateScheduleResource } from "../../access/private-schedule-resource.js";
import type { ScheduleCommands } from "../../scheduling/contracts.js";
import { SCHEDULED_MESSAGE_TOOL_SETTINGS, scheduledMessageProductToolProvider } from "./scheduled-message-provider.js";

const commands: ScheduleCommands = {
  create: async () => ({ ok: false, error: { code: "internal", retryable: false } }),
  patch: async () => ({ ok: false, error: { code: "internal", retryable: false } }),
  delete: async () => ({ ok: true, value: undefined }),
  list: async () => ({ ok: true, value: { schedules: [] } }),
  cards: async () => ({ ok: true, value: { cards: [] } }),
};
const resource = new PrivateScheduleResource(
  Object.freeze({
    ownerUserId: "u_aaaaaaaa",
    resource: "schedule-private",
    rootPath: "/tmp/u_aaaaaaaa",
    role: "adult",
  }),
);

describe("scheduled-message product tools", () => {
  test("normalizes provider-emitted once_after delays before confirmation and execution", async () => {
    const created: unknown[] = [];
    const tools = scheduledMessageProductToolProvider.create({
      schedules: {
        ...commands,
        create: async (_resource: PrivateScheduleResource, request: ScheduleCreateRequest) => {
          created.push(request);
          return {
            ok: true,
            value: {
              scheduleId: "sch_model",
              revision: 1,
              message: request.message,
              timing: { kind: "once", at: "2026-09-12T05:00:00.000Z" },
              enabled: true,
              source: { kind: "user" },
              nextRunAt: "2026-09-12T05:00:00.000Z",
              createdAt: "2026-09-12T04:59:00.000Z",
              updatedAt: "2026-09-12T04:59:00.000Z",
            },
          };
        },
      },
      resource,
    });
    const create = tools.find((tool) => tool.definition.name === "scheduled_message_create");
    expect(create).toBeDefined();
    const variants = [
      { type: "once_after", value: 60 },
      { type: "once_after", unit: "minute", value: 1 },
      { type: "once_after", unit: "seconds", interval: 60 },
      { type: "once_after", seconds: 60 },
    ];
    for (let index = 0; index < variants.length; index += 1) {
      const args = { idempotencyKey: `model-${index}`, message: "continue later", timing: variants[index] };
      expect(create?.validate?.(args)).toBeNull();
      expect((await create?.run(args, { signal: new AbortController().signal }))?.isError).toBe(false);
    }
    expect(created).toHaveLength(4);
    for (const request of created as Array<{ timing: unknown }>) {
      expect(request.timing).toEqual({ kind: "once-after", afterSeconds: 60 });
    }

    expect(
      create?.validate?.({
        idempotencyKey: "bad",
        message: "continue later",
        timing: { type: "once_after", value: 0, unit: "minute" },
      })?.isError,
    ).toBe(true);
  });

  test("normalizes observed provider recurring spellings before confirmation and execution", async () => {
    const created: ScheduleCreateRequest[] = [];
    const tools = scheduledMessageProductToolProvider.create({
      schedules: {
        ...commands,
        create: async (_resource: PrivateScheduleResource, request: ScheduleCreateRequest) => {
          created.push(request);
          return { ok: false, error: { code: "internal", retryable: false } };
        },
      },
      resource,
    });
    const create = tools.find((tool) => tool.definition.name === "scheduled_message_create");
    const fields = { frequency: "daily", time: "08:30", timezone: "America/Vancouver" } as const;
    const variants = [
      { type: "recurring", ...fields },
      fields,
      { recurring: fields },
      { recurrence: fields },
      { daily: { time: fields.time, timezone: fields.timezone } },
    ];
    for (let index = 0; index < variants.length; index += 1) {
      const args = { idempotencyKey: `recurring-${index}`, message: "daily check-in", timing: variants[index] };
      expect(create?.validate?.(args)).toBeNull();
      await create?.run(args, { signal: new AbortController().signal });
    }
    expect(created).toHaveLength(5);
    for (const request of created) {
      expect(request.timing).toEqual({
        kind: "recurring",
        frequency: "daily",
        localTime: "08:30",
        timeZone: "America/Vancouver",
      });
    }

    for (const timing of [
      { type: "recurring", ...fields, extra: true },
      { recurring: { ...fields, frequency: "yearly" } },
      { daily: { time: "8:30", timezone: fields.timezone } },
    ]) {
      expect(create?.validate?.({ idempotencyKey: "bad", message: "daily check-in", timing })?.isError).toBe(true);
    }
  });

  test("publish mediated tiers and explain once, recurring, cleanup, and calendar contrast", () => {
    const tools = scheduledMessageProductToolProvider.create({ schedules: commands, resource });
    expect(tools.map((tool) => [tool.definition.name, tool.definition.tier])).toEqual(
      SCHEDULED_MESSAGE_TOOL_SETTINGS.map((tool) => [tool.name, tool.tier]),
    );
    const text = tools
      .map((tool) => `${tool.definition.description} ${JSON.stringify(tool.definition.parameters)}`)
      .join(" ")
      .toLowerCase();
    expect(text).toContain("chat about that in 30 minutes");
    expect(text).toContain("daily news");
    expect(text).toContain("calendar event");
    expect(text).toContain("cleaned up automatically");
    expect(text).toContain("once-after");
    expect(text).toContain("recurring");
  });
});
