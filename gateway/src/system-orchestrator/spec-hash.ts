// Stable fingerprint of a container create-spec, so a reconcile can tell "this
// container is already exactly what I would create" from "this one is stale".
//
// WHY IT HASHES THE CREATE-SPEC AND NOT THE INSPECTED CONTAINER: docker
// normalises what it stores — it fills defaults, reorders, and rewrites some
// fields — so comparing our intent against docker's readback compares two
// different vocabularies and reports drift that is not drift. Hashing what we
// SEND, and stamping that hash on the container as a label, compares intent to
// intent.
import { createHash } from "node:crypto";

/** Excluded from the hash because the hash itself is stored in Labels — feeding
 *  it back in would make the value depend on itself. Every other create-spec
 *  field participates: image, command, env, ports, binds, networks, limits. */
const EXCLUDED_KEYS = new Set(["Labels"]);

/** Deterministic JSON: object keys sorted at every depth, arrays left in order
 *  (array order IS semantic for Cmd, Binds and Env). Without the sort, two
 *  identical specs built from differently-ordered object literals hash
 *  differently and the skip never fires. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([k]) => !EXCLUDED_KEYS.has(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** Hex SHA-256 of the create-spec, `Labels` excluded. */
export function computeSpecHash(spec: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(spec)).digest("hex");
}
