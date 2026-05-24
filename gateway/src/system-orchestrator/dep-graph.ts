import type { Result } from "@sentient/protocol";

export type DepGraphError =
  | { kind: "cycle"; nodes: string[] }
  | { kind: "unknown-dependency"; from: string; to: string };

export type DepMap = Record<string, ReadonlyArray<string>>;

/** Returns a topological ordering: every dependency precedes its dependents.
 *  Detects cycles + unknown targets. */
export function topoOrder(deps: DepMap): Result<string[], DepGraphError> {
  for (const [node, edges] of Object.entries(deps)) {
    for (const e of edges) {
      if (!(e in deps)) {
        return { ok: false, error: { kind: "unknown-dependency", from: node, to: e } };
      }
    }
  }

  const visited = new Set<string>();
  const stack = new Set<string>();
  const order: string[] = [];

  function visit(node: string, path: string[]): DepGraphError | null {
    if (stack.has(node)) {
      return { kind: "cycle", nodes: [...path, node] };
    }
    if (visited.has(node)) return null;
    stack.add(node);
    for (const dep of deps[node] ?? []) {
      const err = visit(dep, [...path, node]);
      if (err) return err;
    }
    stack.delete(node);
    visited.add(node);
    order.push(node);
    return null;
  }

  for (const node of Object.keys(deps)) {
    const err = visit(node, []);
    if (err) return { ok: false, error: err };
  }
  return { ok: true, value: order };
}

/** Returns the transitive set of nodes whose dependency set intersects
 *  `failed`. Used to mark services as `blocked-by-dep` once an upstream
 *  fails. Does not include the failed nodes themselves. */
export function blockedByFailedDeps(deps: DepMap, failed: ReadonlySet<string>): Set<string> {
  const blocked = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [node, edges] of Object.entries(deps)) {
      if (failed.has(node) || blocked.has(node)) continue;
      for (const e of edges) {
        if (failed.has(e) || blocked.has(e)) {
          blocked.add(node);
          changed = true;
          break;
        }
      }
    }
  }
  return blocked;
}
