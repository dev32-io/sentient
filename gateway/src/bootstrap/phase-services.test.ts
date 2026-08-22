import { rmSync } from "node:fs";
import type { OrchestratorConfig } from "@sentient/config";
import { afterEach, describe, expect, it } from "vitest";
import { createAccessManager } from "../access/access-manager.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import { buildSessionCalendar, resolveCalendarConfig, resolveDreamerModel } from "./phase-services.js";

function memCfg(model: string): OrchestratorConfig["memory"] {
  return { dreamer: { model } } as unknown as OrchestratorConfig["memory"];
}

function providerCfg(model: string): OrchestratorConfig["provider"] {
  return { model } as unknown as OrchestratorConfig["provider"];
}

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function calendarCfg(enabled = true): OrchestratorConfig {
  return {
    calendar: {
      enabled,
      query: { max_days: 30, max_occurrences: 25, page_size: 10 },
      input: {
        max_title_chars: 64,
        max_description_chars: 256,
        max_query_chars: 64,
        max_group_chars: 32,
        max_tag_chars: 16,
        max_tags: 4,
      },
      output: { max_result_chars: 4000 },
      recurrence: { max_occurrences: 1000, max_days: 366 },
      nudge: { max_per_day: 10 },
      default_event_tz_id: "household",
    },
    tools: { max_tool_result_chars: 20_000 },
  } as unknown as OrchestratorConfig;
}

describe("calendar bootstrap", () => {
  it("maps limits into one immutable config and resolves the household sentinel", () => {
    const resolved = resolveCalendarConfig(calendarCfg(), "America/Toronto");
    expect(resolved.defaultEventTimeZoneId).toBe("America/Toronto");
    expect(resolved.query.maxOccurrences).toBe(25);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.query)).toBe(true);
  });

  it("does not mint calendar capabilities when the session path is disabled", () => {
    let grants = 0;
    const access = {
      grant: () => {
        grants++;
        throw new Error("unexpected grant");
      },
    } as never;
    const principal = createUserPrincipal("u_12345678", "adult", "home");
    expect(buildSessionCalendar(calendarCfg(false), access, principal)).toBeNull();
    expect(grants).toBe(0);
  });

  it("opens two shared V2 handles and makes session close idempotent", () => {
    const root = `/tmp/sentient-calendar-bootstrap-${crypto.randomUUID()}`;
    tempRoots.push(root);
    const access = createAccessManager({ userDataRoot: root });
    const principal = createUserPrincipal("u_12345678", "adult", "home");
    const session = buildSessionCalendar(
      calendarCfg(),
      access,
      principal,
      resolveCalendarConfig(calendarCfg(), "UTC"),
      "UTC",
    );
    expect(session?.tools.filter((tool) => tool.definition.productGroup === "calendar")).toHaveLength(6);
    session?.close();
    session?.close();
    expect(session?.privateStore.readBaseCandidates(1, {})).toMatchObject({ ok: false, error: "closed" });
  });
});

describe("resolveDreamerModel", () => {
  it("inherits provider.model when dreamer.model is the default empty string", () => {
    expect(resolveDreamerModel(memCfg(""), providerCfg("chat-model"))).toBe("chat-model");
  });

  it("overrides with a non-empty dreamer.model, ignoring provider.model", () => {
    expect(resolveDreamerModel(memCfg("deepseek-v4-flash:cloud"), providerCfg("chat-model"))).toBe(
      "deepseek-v4-flash:cloud",
    );
  });
});
