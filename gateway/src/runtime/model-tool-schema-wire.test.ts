import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccessManager } from "../access/access-manager.js";
import { PrivateScheduleResource } from "../access/private-schedule-resource.js";
import { calendarProductToolProvider } from "../bootstrap/product-tools/calendar-provider.js";
import { scheduledMessageProductToolProvider } from "../bootstrap/product-tools/scheduled-message-provider.js";
import { openCalendarPersistence } from "../calendar/calendar-store.js";
import type { CalendarConfig } from "../calendar/types.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import type { ProviderRequest } from "../provider/provider-client.js";
import type { ScheduleCommands } from "../scheduling/contracts.js";
import type { NewSessionEntry } from "../store/entry-types.js";
import { openSessionStore } from "../store/session-store.js";
import type { BackgroundRegistry } from "../tools/background-registry.js";
import type { ToolBroker } from "../tools/tool-broker.js";
import type { ToolDefinition } from "../tools/tool-types.js";
import { runTurn } from "./react-loop.js";

const calendarConfig: CalendarConfig = {
  query: { maxDays: 366, maxOccurrences: 100, pageSize: 100 },
  input: {
    maxTitleChars: 80,
    maxDescriptionChars: 200,
    maxQueryChars: 40,
    maxGroupChars: 20,
    maxTagChars: 20,
    maxTags: 8,
  },
  output: { maxResultChars: 5000 },
  recurrence: { maxOccurrences: 100, maxDays: 366 },
  nudge: { maxPerDay: 10 },
  defaultEventTimeZoneId: "UTC",
};

const schedules: ScheduleCommands = {
  create: async () => ({ ok: false, error: { code: "internal", retryable: false } }),
  patch: async () => ({ ok: false, error: { code: "internal", retryable: false } }),
  delete: async () => ({ ok: true, value: undefined }),
  list: async () => ({ ok: true, value: { schedules: [] } }),
  cards: async () => ({ ok: true, value: { cards: [] } }),
};

function broker(definitions: ToolDefinition[]): ToolBroker {
  const background: BackgroundRegistry = {
    count: () => 0,
    newestStartedAtMs: () => null,
    register: () => {},
    complete: () => {},
  };
  return {
    ownerUserId: "u_aaaaaaaa",
    foregroundInFlight: 0,
    ready: async () => {},
    definitions: () => definitions,
    dispatch: async () => {
      throw new Error("dispatch not expected");
    },
    background,
    setBackgroundCompletionSink: () => {},
  };
}

type Schema = {
  type?: string;
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: Array<string | boolean>;
  anyOf?: Schema[];
};

function providerTool(request: ProviderRequest, name: string): Schema {
  const found = request.tools.find((tool) => tool.function.name === name);
  if (!found) throw new Error(`missing provider tool ${name}`);
  return found.function.parameters as Schema;
}

describe("model tool schema wire", () => {
  it("preserves Ollama-supported schedule and calendar variants in ReAct provider request", async () => {
    const root = mkdtempSync(join(tmpdir(), "model-tool-schema-wire-"));
    const principal = createUserPrincipal("u_aaaaaaaa", "adult", "household-1");
    const access = createAccessManager({ userDataRoot: root });
    const persistence = openCalendarPersistence(access.grant(principal, "calendar-private"), calendarConfig);
    const store = openSessionStore(access.grant(principal, "session-store"));
    const definitions = [
      ...scheduledMessageProductToolProvider.create({
        schedules,
        resource: new PrivateScheduleResource(access.grant(principal, "schedule-private")),
      }),
      ...calendarProductToolProvider.create({
        privatePersistence: persistence,
        privateCap: access.grant(principal, "calendar-private"),
        calendarConfig,
      }),
    ].map((tool) => tool.definition);
    const user: NewSessionEntry = {
      sessionId: "schema-wire",
      turnId: "seed",
      replyId: null,
      kind: "user",
      createdAt: Date.now(),
      text: "test schemas",
      toolCallId: null,
      toolName: null,
      toolArgs: null,
      cutoff: null,
      compactedThroughSeq: null,
      pendingId: null,
    };
    store.append(user);
    const requests: ProviderRequest[] = [];

    try {
      await runTurn(
        {
          provider: {
            async *stream(request) {
              requests.push(request);
              yield { type: "done", finishReason: "stop" };
            },
          },
          broker: broker(definitions),
          store,
          timeZone: { zone: () => "UTC" },
          systemPrompt: "test",
          sessionId: "schema-wire",
          config: { max_iterations: 2 },
          requestTimeoutMs: 30_000,
          onTextDelta: () => {},
          onToolUpdate: () => {},
        },
        { turnId: "turn", signal: new AbortController().signal },
      );

      const request = requests[0];
      if (!request) throw new Error("provider request missing");
      const scheduledCreate = providerTool(request, "scheduled_message_create");
      const timing = scheduledCreate.properties?.timing;
      expect(timing?.anyOf?.map((variant) => variant.properties?.kind?.enum?.[0])).toEqual([
        "once-at",
        "once-after",
        "recurring",
        "recurring",
        "recurring",
      ]);
      expect(timing?.anyOf?.[1]?.properties?.afterSeconds?.type).toBe("integer");

      const calendarCreate = providerTool(request, "calendar_create");
      expect(calendarCreate.properties?.reminder?.anyOf?.[1]?.required).toEqual(["enabled", "mode", "leadMinutes"]);
      const calendarUpdate = providerTool(request, "calendar_update");
      expect(calendarUpdate.type).toBe("object");
      expect(calendarUpdate.properties?.applyTo?.enum).toEqual([
        "this_occurrence",
        "this_and_following",
        "entire_series",
      ]);
      expect(calendarUpdate.properties?.originalStart?.description).toContain("must be omitted");
      expect(
        calendarUpdate.properties?.changes?.properties?.reminder?.anyOf?.at(-1)?.properties?.enabled?.enum,
      ).toEqual([false]);

      const encoded = JSON.stringify(request.tools);
      expect(encoded).not.toContain('"oneOf"');
      expect(encoded).not.toContain('"const"');
      for (const tool of request.tools) expect(tool.function.parameters.type).toBe("object");
    } finally {
      persistence.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
