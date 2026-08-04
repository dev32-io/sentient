import { expect, test } from "bun:test";
import { computeSpecHash } from "./spec-hash.js";

// INVARIANT, documented in spec-hash.ts: the `Labels` exclusion exists for
// exactly one reason — the hash is stamped INTO the root `Labels`, so
// including it would make the value depend on itself. That self-reference
// does not exist at any other depth. Excluding `Labels` everywhere (not just
// at the root) is a landmine: `NetworkingConfig` is omitted today, but if it
// is ever reintroduced, `EndpointsConfig.<net>.Labels` becomes real, ordinary
// content, and a difference there would silently vanish from the hash — the
// skip would fire when it should not, and a stale container would keep
// serving while the orchestrator reports everything fine.
test("computeSpecHash ignores a difference in the ROOT Labels value", () => {
  const a = { Image: "x", Labels: { "sentient.spec-hash": "aaa" } };
  const b = { Image: "x", Labels: { "sentient.spec-hash": "bbb" } };
  expect(computeSpecHash(a)).toBe(computeSpecHash(b));
});

test("computeSpecHash detects a difference in a NESTED Labels value", () => {
  const a = { Image: "x", NetworkingConfig: { EndpointsConfig: { net: { Labels: { team: "a" } } } } };
  const b = { Image: "x", NetworkingConfig: { EndpointsConfig: { net: { Labels: { team: "b" } } } } };
  expect(computeSpecHash(a)).not.toBe(computeSpecHash(b));
});
