### Task 2: a place to put a session's identity

**Spec:** §4.1. **Model:** sonnet.

The store has exactly **one** table — `entries`, append-only — with a deliberately frozen baseline DDL. There is nowhere to record that a session exists, what it is called, or who named it. Tasks 3, 4 and 10 all need one.

**Files:**
- Modify: `gateway/src/store/schema.ts` (append a migration; **do not touch `STORE_DDL`**)
- Create: `gateway/src/store/session-metadata.ts`
- Modify: `gateway/src/store/session-store.ts` (expose the new operations)
- Test: `gateway/src/store/session-metadata.test.ts`

**Interfaces produced:**

```ts
export type TitleProvenance = "generated" | "user";

export interface SessionMetadata {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  title: string | null;
  titleProvenance: TitleProvenance | null;
  /** Bumped on every title write. The CAS token. */
  version: number;
}
```

Added to `SessionStore`:
- `createSession(sessionId: string, mintKey: string): SessionMetadata` — throws a **typed, distinguishable** error when `mintKey` already exists
- `findSessionByMintKey(mintKey: string): SessionMetadata | null`
- `getSession(sessionId: string): SessionMetadata | null`
- `listSessionsWithMetadata(): SessionMetadata[]` — newest-updated first
- `setTitle(sessionId: string, title: string, provenance: TitleProvenance, expectedVersion: number): boolean` — `false` when the version moved

---

- [ ] **Step 1: Read the migration ladder's header before writing anything**

`store/schema.ts`'s header explains why `CREATE TABLE IF NOT EXISTS` in `STORE_DDL` is not a migration: every per-user database under `~/.sentient` already exists, so a table added to the baseline reaches **none** of them, while every fresh-database test stays green. That exact blind spot deleted the `pending_id` round trip (D14).

Append to `STORE_MIGRATIONS` as a new `{ version, name, statements }` entry. `STORE_SCHEMA_VERSION` derives itself.

- [ ] **Step 2: Failing test — the table reaches an EXISTING database, not just a fresh one**

This is the D14 lesson as an executable check, and it is the most valuable test in this task:

```ts
it("INVARIANT: the sessions table is created in a database that predates it", () => {
  const db = openStoreAtSchemaVersion(0);   // baseline only
  migrateStore(db, "u_test");
  expect(db.query("SELECT name FROM sqlite_master WHERE name='sessions'").all()).toHaveLength(1);
});
```

Match `migrate-store.ts`'s real signature; read it first.

- [ ] **Step 3: Failing test — the mint key is unique, and that IS the idempotency**

```ts
it("INVARIANT: creating a session twice with one mint key yields one row", () => {
  const first = store.createSession("s_aaa", "mint-1");
  expect(() => store.createSession("s_bbb", "mint-1")).toThrow();
  expect(store.findSessionByMintKey("mint-1")?.sessionId).toBe(first.sessionId);
});
```

Put a `UNIQUE` constraint on `mint_key` and let **SQLite** enforce it. A read-then-write check in TypeScript is a race; the constraint is not. Task 3 turns the caught violation into "return the existing id".

- [ ] **Step 4: Failing test — compare-and-set refuses a stale write**

```ts
it("INVARIANT: a title write with a stale version is refused", () => {
  const s = store.createSession("s_ccc", "mint-2");
  expect(store.setTitle("s_ccc", "Renamed", "user", s.version)).toBe(true);
  expect(store.setTitle("s_ccc", "Generated", "generated", s.version)).toBe(false);
});
```

- [ ] **Step 5: Failing test — a generated title never overwrites a person**

```ts
it("INVARIANT: provenance=user is never overwritten by a generated title", () => {
  const created = store.createSession("s_ddd", "mint-3");
  store.setTitle("s_ddd", "Kitchen lights", "user", created.version);
  const named = store.getSession("s_ddd");
  expect(named).not.toBeNull();
  expect(store.setTitle("s_ddd", "Auto title", "generated", named.version)).toBe(false);
});
```

Two independent guards, and both are needed: the version catches a *concurrent* write, the provenance check catches a *later* one that happens to carry the right version. Task 10 depends on both.

- [ ] **Step 6: Implement `session-metadata.ts`**

Keep it a pure data module over a `Database` handle — no capability logic (the store already resolved that), no title-generation logic (task 10 owns it). `updatedAt` is bumped by writes; `listSessionsWithMetadata` orders by it descending so the drawer's "newest first" needs no client sort.

- [ ] **Step 7: Backfill is NOT this task**

Existing partitions have `entries` rows but no `sessions` row. Task 3 defines how a legacy id is recognised. **Do not** write a backfill that invents metadata here — a half-designed backfill is harder to remove than to add.

- [ ] **Step 8: Gate and commit**

```bash
source scripts/env.sh
bun run --filter '*' typecheck && bunx biome check . && (cd gateway/src && bun test store 2>&1 | tail -4)
```

```bash
git add -A gateway/src/store
git commit -m "feat(store): a sessions table, via the ladder rather than the frozen baseline"
```
