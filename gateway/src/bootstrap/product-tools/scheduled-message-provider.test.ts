import { describe, expect, test } from "bun:test";
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
