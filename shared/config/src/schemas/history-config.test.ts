import { describe, expect, it } from "vitest";
import { historyConfigSchema } from "./history-config";

describe("history retention policy", () => {
  it("defaults to 90 days and accepts disabling or at least 30 days", () => {
    expect(historyConfigSchema.parse({}).retention_days).toBe(90);
    for (const days of [0, 30, 90, 36500]) {
      expect(historyConfigSchema.parse({ retention_days: days }).retention_days).toBe(days);
    }
    for (const days of [-1, 1, 29, 30.5, 36501, Number.POSITIVE_INFINITY]) {
      expect(historyConfigSchema.safeParse({ retention_days: days }).success).toBe(false);
    }
  });
});
