import { describe, expect, it } from "bun:test";
import { ToolCallAccumulator } from "./tool-call-accumulator.js";

describe("ToolCallAccumulator", () => {
  it("assembles a call whose id arrives after its index+name", () => {
    const acc = new ToolCallAccumulator();
    acc.feed([{ index: 0, function: { name: "search" } }]); // no id yet
    acc.feed([{ index: 0, id: "call_1", function: { arguments: '{"q":' } }]);
    acc.feed([{ index: 0, function: { arguments: '"weather"}' } }]);
    const calls = acc.flush();
    expect(calls).toEqual([
      { id: "call_1", type: "function", function: { name: "search", arguments: '{"q":"weather"}' } },
    ]);
  });

  it("keeps parallel calls separate by index", () => {
    const acc = new ToolCallAccumulator();
    acc.feed([{ index: 0, id: "a", function: { name: "x", arguments: "{}" } }]);
    acc.feed([{ index: 1, id: "b", function: { name: "y", arguments: "{}" } }]);
    expect(acc.flush().map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("flush() drains and resets", () => {
    const acc = new ToolCallAccumulator();
    acc.feed([{ index: 0, id: "a", function: { name: "x", arguments: "{}" } }]);
    expect(acc.flush()).toHaveLength(1);
    expect(acc.flush()).toHaveLength(0);
  });
});
