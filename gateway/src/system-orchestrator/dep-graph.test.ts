import { expect, test } from "bun:test";
import { blockedByFailedDeps, topoOrder } from "./dep-graph.js";

test("topoOrder returns deps before dependents", () => {
  const r = topoOrder({
    a: [],
    b: ["a"],
    c: ["a", "b"],
  });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.indexOf("a")).toBeLessThan(r.value.indexOf("b"));
  expect(r.value.indexOf("b")).toBeLessThan(r.value.indexOf("c"));
});

test("topoOrder detects cycles", () => {
  const r = topoOrder({
    a: ["b"],
    b: ["a"],
  });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("cycle");
});

test("topoOrder rejects unknown dependency targets", () => {
  const r = topoOrder({ a: ["ghost"] });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("unknown-dependency");
});

test("blockedByFailedDeps returns transitive set", () => {
  const out = blockedByFailedDeps({ a: [], b: ["a"], c: ["b"], d: [] }, new Set(["a"]));
  expect(out).toEqual(new Set(["b", "c"]));
});
