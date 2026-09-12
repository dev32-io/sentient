import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpCatalog, OrchestratorConfig } from "@sentient/config";
import type { ScheduleCreateRequest } from "@sentient/protocol";
import { createAccessManager } from "../../access/access-manager.js";
import { PrivateScheduleResource } from "../../access/private-schedule-resource.js";
import { createUserPrincipal } from "../../identity/user-principal.js";
import type { ScheduleCommands } from "../../scheduling/contracts.js";
import { createScheduleService } from "../../scheduling/service.js";
import { openSessionStore } from "../../store/session-store.js";
import type { McpClient } from "../../tools/mcp-client.js";
import { createToolBroker } from "../../tools/tool-broker.js";
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

const brokerToolsConfig: OrchestratorConfig["tools"] = {
  foreground_timeout_ms: 30_000,
  max_concurrent_background_tasks: 1,
  background_completion_request_echo_chars: 240,
  max_tool_result_chars: 20_000,
};

const emptyMcp: McpClient = {
  async listTools() {
    return [];
  },
  async callTool() {
    throw new Error("no MCP calls expected");
  },
  async close() {},
};

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

  test("advertises canonical recurrence constraints and returns safe actionable issue paths", () => {
    const tools = scheduledMessageProductToolProvider.create({ schedules: commands, resource });
    const create = tools.find((tool) => tool.definition.name === "scheduled_message_create");
    const parameters = create?.definition.parameters as {
      properties?: {
        timing?: { oneOf?: Array<{ properties?: { frequency?: { const?: string } }; required?: string[] }> };
      };
    };
    const variants = parameters.properties?.timing?.oneOf ?? [];
    expect(variants.find((variant) => variant.properties?.frequency?.const === "weekly")?.required).toContain(
      "weekdays",
    );
    expect(variants.find((variant) => variant.properties?.frequency?.const === "monthly")?.required).toContain(
      "dayOfMonth",
    );

    const invalid = create?.validate?.({
      idempotencyKey: "weekly-retry",
      message: "weekly check-in",
      timing: { kind: "recurring", frequency: "weekly", localTime: "09:00", timeZone: "UTC" },
    });
    expect(invalid?.isError).toBe(true);
    const body = JSON.parse(invalid?.content ?? "{}") as {
      code?: string;
      issues?: Array<{ path: string; code: string }>;
      expected?: string;
    };
    expect(body.code).toBe("invalid_arguments");
    expect(body.issues).toContainEqual({ path: "timing.weekdays", code: "custom" });
    expect(body.expected).toContain("weekly also requires weekdays");
    expect(invalid?.content).not.toContain("weekly check-in");
  });

  test("broker validates before approval and idempotent corrected replay creates one schedule", async () => {
    const root = mkdtempSync(join(tmpdir(), "scheduled-model-broker-"));
    const principal = createUserPrincipal("u_aaaaaaaa", "adult", "household-1");
    const accessManager = createAccessManager({ userDataRoot: root });
    const brokerCapability = accessManager.grant(principal, "tool-broker");
    const sessionStore = openSessionStore(accessManager.grant(principal, "session-store"));
    const scheduleService = createScheduleService({ userDataRoot: root, id: () => "schedule-model" });
    const scheduleResource = new PrivateScheduleResource(accessManager.grant(principal, "schedule-private"));
    const nativeTools = new Map(
      scheduledMessageProductToolProvider
        .create({
          schedules: scheduleService,
          resource: scheduleResource,
          clock: () => new Date("2026-09-12T08:00:00Z"),
        })
        .map((tool) => [tool.definition.name, tool]),
    );
    let approvals = 0;
    const broker = createToolBroker({
      mcp: emptyMcp,
      catalog: {} as McpCatalog,
      store: sessionStore,
      capability: brokerCapability,
      sessionId: "session-model",
      backgroundTools: new Map(),
      nativeTools,
      config: brokerToolsConfig,
      toolPermissions: async () => ({ native: { scheduled_message_create: "ask" } }),
      requestConfirm: async () => {
        approvals += 1;
        return true;
      },
    });
    const base = {
      toolCallId: "call-invalid",
      name: "scheduled_message_create",
      args: {
        idempotencyKey: "logical-weekly",
        message: "weekly check-in",
        timing: { kind: "recurring", frequency: "weekly", localTime: "09:00", timeZone: "UTC" },
      },
      signal: new AbortController().signal,
      turnId: "turn-model",
    };
    try {
      const invalid = await broker.dispatch(base);
      expect("isError" in invalid && invalid.isError).toBe(true);
      expect(approvals).toBe(0);
      expect((await scheduleService.list(scheduleResource, undefined, 20)).ok).toBe(true);
      const corrected = {
        ...base,
        toolCallId: "call-corrected",
        args: { ...base.args, timing: { ...base.args.timing, weekdays: ["monday"] } },
      };
      const first = await broker.dispatch(corrected);
      const replay = await broker.dispatch({ ...corrected, toolCallId: "call-replay" });
      expect("isError" in first && first.isError).toBe(false);
      expect("isError" in replay && replay.isError).toBe(false);
      expect(approvals).toBe(2);
      const listed = await scheduleService.list(scheduleResource, undefined, 20);
      expect(listed.ok && listed.value.schedules).toHaveLength(1);
    } finally {
      scheduleService.close();
      sessionStore.close();
      rmSync(root, { recursive: true, force: true });
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
