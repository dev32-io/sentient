// Session metadata (spec §4.1) — one row per session: identity, timestamps,
// and title. Lives in the `sessions` table added by the schema-2 migration
// (schema.ts), inside the same per-user database `entries` already lives in.
//
// Pure data module over an already-open `Database` handle: no capability
// logic (session-store.ts resolved that before this module ever sees the
// handle) and no title-generation logic (task 10 owns deciding WHAT a
// generated title says — this module only stores it, gated by provenance and
// a compare-and-set version).

import { type Database, SQLiteError } from "bun:sqlite";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "store", "session-metadata"]);

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

/**
 * Thrown by `createSession` when `mintKey` already names a session. Typed and
 * distinguishable from any other SQLite failure — the `UNIQUE` constraint on
 * `mint_key` (not a read-then-write check, which would race) is what makes
 * minting idempotent; this class is what lets a caller (task 3) catch that
 * specific case and resolve to the existing row instead of surfacing an
 * error.
 */
export class MintKeyConflictError extends Error {
  constructor(readonly mintKey: string) {
    super(`mint key already claimed by an existing session: ${mintKey}`);
    this.name = "MintKeyConflictError";
  }
}

export interface SessionMetadataOps {
  /** Throws `MintKeyConflictError` when `mintKey` already names a session. */
  createSession(sessionId: string, mintKey: string): SessionMetadata;
  findSessionByMintKey(mintKey: string): SessionMetadata | null;
  getSession(sessionId: string): SessionMetadata | null;
  /** Newest-updated first. */
  listSessionsWithMetadata(): SessionMetadata[];
  /**
   * Compare-and-set title write. `false` when refused: either `expectedVersion`
   * has moved (a concurrent write landed first) or the write would let a
   * `generated` title overwrite a `user` one (a later write that happens to
   * carry the current version). Both guards matter — the version alone would
   * still let a delayed auto-title clobber a rename that landed in between.
   */
  setTitle(sessionId: string, title: string, provenance: TitleProvenance, expectedVersion: number): boolean;
}

interface SessionRow {
  session_id: string;
  created_at: number;
  updated_at: number;
  title: string | null;
  title_provenance: string | null;
  version: number;
}

function toMetadata(row: SessionRow): SessionMetadata {
  return {
    sessionId: row.session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    title: row.title,
    titleProvenance: row.title_provenance as TitleProvenance | null,
    version: row.version,
  };
}

// SQLite gives a UNIQUE violation and a TEXT PRIMARY KEY violation DISTINCT
// exact `.code` values — measured on the pinned bun:sqlite (1.3.11):
// `mint_key` (plain UNIQUE) fails as SQLITE_CONSTRAINT_UNIQUE, `session_id`
// (PRIMARY KEY) fails as SQLITE_CONSTRAINT_PRIMARYKEY. `mint_key` is the only
// plain-UNIQUE column on this table, so the exact code alone discriminates a
// `mint_key` collision (idempotent re-mint) from a `session_id` collision (a
// caller bug: colliding id generation) — no message-parsing needed.
const SQLITE_CONSTRAINT_UNIQUE = "SQLITE_CONSTRAINT_UNIQUE";

export function createSessionMetadataOps(db: Database, userId: string): SessionMetadataOps {
  const insertSession = db.query<SessionRow, [string, string, number, number]>(`
    INSERT INTO sessions (session_id, mint_key, created_at, updated_at, title, title_provenance, version)
    VALUES (?, ?, ?, ?, NULL, NULL, 1)
    RETURNING *
  `);
  const selectByMintKey = db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE mint_key = ?");
  const selectBySessionId = db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE session_id = ?");
  const selectAllByUpdatedAt = db.query<SessionRow, []>("SELECT * FROM sessions ORDER BY updated_at DESC");
  // The provenance guard is folded into the WHERE clause, alongside the CAS
  // version check, so both guards are enforced atomically by the same
  // statement rather than as a separate read-then-decide step that could race
  // against a concurrent write.
  const updateTitle = db.query<SessionRow, [string, string, number, string, number, string]>(`
    UPDATE sessions
    SET title = ?, title_provenance = ?, updated_at = ?, version = version + 1
    WHERE session_id = ?
      AND version = ?
      AND (title_provenance IS NOT 'user' OR ? = 'user')
    RETURNING *
  `);

  return {
    createSession(sessionId, mintKey) {
      const now = Date.now();
      try {
        const row = insertSession.get(sessionId, mintKey, now, now);
        if (!row) throw new Error("createSession returned no row");
        log.info("session.metadata.created", { userId, sessionId, mintKey });
        return toMetadata(row);
      } catch (err: unknown) {
        if (err instanceof SQLiteError && err.code === SQLITE_CONSTRAINT_UNIQUE) {
          log.warn("session.metadata.mint-key-conflict", {
            userId,
            sessionId,
            mintKey,
            reason: "mint_key already names an existing session",
          });
          throw new MintKeyConflictError(mintKey);
        }
        throw err;
      }
    },
    findSessionByMintKey(mintKey) {
      const row = selectByMintKey.get(mintKey);
      return row ? toMetadata(row) : null;
    },
    getSession(sessionId) {
      const row = selectBySessionId.get(sessionId);
      return row ? toMetadata(row) : null;
    },
    listSessionsWithMetadata() {
      return selectAllByUpdatedAt.all().map(toMetadata);
    },
    setTitle(sessionId, title, provenance, expectedVersion) {
      const row = updateTitle.get(title, provenance, Date.now(), sessionId, expectedVersion, provenance);
      if (!row) {
        log.warn("session.metadata.title-write-refused", {
          userId,
          sessionId,
          provenance,
          expectedVersion,
          reason: "expectedVersion is stale or a generated title would overwrite a user title",
        });
        return false;
      }
      log.debug("session.metadata.title-set", { userId, sessionId, provenance, version: row.version });
      return true;
    },
  };
}
