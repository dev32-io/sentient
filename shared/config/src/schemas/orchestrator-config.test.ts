import { describe, expect, it } from "vitest";
import { orchestratorConfigSchema } from "./orchestrator-config";

const base = {
  provider: { base_url: "https://x/api/v1", model: "m" },
  loop: {},
  tools: {},
  delegation: {},
};

describe("orchestratorConfigSchema", () => {
  it("applies defaults for optional tunables", () => {
    const c = orchestratorConfigSchema.parse(base);
    expect(c.loop.max_iterations).toBe(10);
    expect(c.tools.max_concurrent_background_tasks).toBe(50);
    expect(c.provider.request_timeout_ms).toBe(120000);
    expect(c.calendar.query).toEqual({ max_days: 366, max_occurrences: 250, page_size: 100 });
    expect(c.calendar.input).toEqual({
      max_title_chars: 512,
      max_description_chars: 8000,
      max_query_chars: 512,
      max_group_chars: 128,
      max_tag_chars: 64,
      max_tags: 32,
    });
    expect(c.calendar.output.max_result_chars).toBe(16000);
    expect(c.calendar.recurrence).toEqual({ max_occurrences: 1000, max_days: 366 });
    expect(c.calendar.nudge.max_per_day).toBe(10);
    expect(c.calendar.default_event_tz_id).toBe("household");
  });
  it("accepts explicit lower calendar safety limits", () => {
    const c = orchestratorConfigSchema.parse({
      ...base,
      calendar: {
        query: { max_days: 1, max_occurrences: 1, page_size: 1 },
        input: {
          max_title_chars: 1,
          max_description_chars: 1,
          max_query_chars: 1,
          max_group_chars: 1,
          max_tag_chars: 1,
          max_tags: 1,
        },
        output: { max_result_chars: 1 },
      },
    });
    expect(c.calendar.query.max_occurrences).toBe(1);
    expect(c.calendar.input.max_tags).toBe(1);
    expect(c.calendar.output.max_result_chars).toBe(1);
  });
  it("rejects zero, negative, and excessive calendar limits", () => {
    const invalid = [
      { query: { max_days: 0 } },
      { query: { max_occurrences: -1 } },
      { query: { page_size: 101 } },
      { recurrence: { max_occurrences: 1001 } },
      { recurrence: { max_days: 367 } },
      { nudge: { max_per_day: 0 } },
      { nudge: { max_per_day: 1001 } },
      { input: { max_title_chars: 513 } },
      { input: { max_description_chars: 8001 } },
      { input: { max_query_chars: 513 } },
      { input: { max_group_chars: 129 } },
      { input: { max_tag_chars: 65 } },
      { input: { max_tags: 33 } },
      { output: { max_result_chars: 0 } },
      { output: { max_result_chars: 20_000 } },
    ];
    for (const calendar of invalid) {
      expect(() => orchestratorConfigSchema.parse({ ...base, calendar })).toThrow();
    }
  });
  it("keeps the proactive output limit strictly below the generic 20000-character backstop", () => {
    const c = orchestratorConfigSchema.parse({ ...base, calendar: { output: { max_result_chars: 19_999 } } });
    expect(c.calendar.output.max_result_chars).toBe(19_999);
    expect(() =>
      orchestratorConfigSchema.parse({ ...base, calendar: { output: { max_result_chars: 20_000 } } }),
    ).toThrow();
  });
  it("rejects a non-url base_url", () => {
    expect(() =>
      orchestratorConfigSchema.parse({ ...base, provider: { ...base.provider, base_url: "not-a-url" } }),
    ).toThrow();
  });
  it("rejects an out-of-range max_iterations", () => {
    expect(() => orchestratorConfigSchema.parse({ ...base, loop: { max_iterations: 999 } })).toThrow();
  });
  it("defaults base_url to empty string when omitted — the composition root then relies entirely on the secrets store", () => {
    const c = orchestratorConfigSchema.parse({ ...base, provider: { model: "m" } });
    expect(c.provider.base_url).toBe("");
  });
  it("no longer accepts/needs api_key_env — the key comes from the secrets store, not config", () => {
    const c = orchestratorConfigSchema.parse(base);
    expect("api_key_env" in c.provider).toBe(false);
  });
  it('defaults memory.dreamer.model to "" (inherit provider.model) when the memory block is omitted', () => {
    const c = orchestratorConfigSchema.parse(base);
    expect(c.memory.dreamer.model).toBe("");
  });
  it("parses a non-empty memory.dreamer.model override", () => {
    const c = orchestratorConfigSchema.parse({
      ...base,
      memory: { dreamer: { model: "deepseek-v4-flash:cloud" } },
    });
    expect(c.memory.dreamer.model).toBe("deepseek-v4-flash:cloud");
  });
});
