import { describe, expect, it } from "vitest";
import { createToolRegistry } from "./tool-registry.js";

const dummyHandler = {
  def: {
    name: "x",
    description: "",
    inputSchema: { type: "object" as const, properties: {} },
  },
  async run() {
    return { content: [{ type: "text" as const, text: "" }] };
  },
};

describe("createToolRegistry", () => {
  it("lists and gets handlers", () => {
    const r = createToolRegistry([dummyHandler]);
    expect(r.list()).toHaveLength(1);
    expect(r.get("x")?.def.name).toBe("x");
    expect(r.get("missing")).toBeNull();
  });
});
