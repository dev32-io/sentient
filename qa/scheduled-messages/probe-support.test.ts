import { describe, expect, test } from "bun:test";
import { safeLogStages } from "./probe-support.ts";

describe("scheduled-message QA evidence sanitizer", () => {
  test("retains only allowlisted stages for exact call and drops content", () => {
    const logs = [
      '{"event":"tool-broker.dispatch.native.invalid-args","toolCallId":"call-a","message":"private"}',
      '{"event":"tool-broker.dispatch.denied","toolCallId":"call-b"}',
      '{"event":"tool-broker.dispatch.native.done","toolCallId":"call-a","result":"private"}',
      '{"event":"provider.prompt","toolCallId":"call-a","prompt":"private"}',
    ].join("\n");
    expect(safeLogStages(logs, "call-a")).toEqual([
      "tool-broker.dispatch.native.invalid-args",
      "tool-broker.dispatch.native.done",
    ]);
    expect(JSON.stringify(safeLogStages(logs, "call-a"))).not.toContain("private");
    expect(safeLogStages(logs, null)).toEqual([]);
  });
});
