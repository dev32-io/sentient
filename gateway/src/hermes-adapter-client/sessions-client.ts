import type { SessionRow } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import type { AcpPerProfileConnection } from "./per-profile-connection.js";
import { sessionListSessionInfoSchema } from "./schemas.js";

const log = getLog(["sentient", "hermes-adapter-client", "sessions-client"]);

const DEFAULT_TITLE = "New chat";

// ---------------------------------------------------------------------------
// Hermes raw shapes
// ---------------------------------------------------------------------------
// These types describe the JSON shapes the sentient-plugin REST sidecar
// returns (search, get, getMessages, delete). The legacy custom-WS HTTP
// surface that produced the same shapes was retired in the ACP cleanup;
// `plugin-client.ts` is the only producer today. Names retain the
// `Hermes*` prefix because the underlying SessionDB rows haven't changed
// — only the transport that exposes them.
// ---------------------------------------------------------------------------

export interface HermesSessionRow {
  id: string;
  title: string | null;
  source: string;
  started_at: number;
  last_active: number;
  ended_at: number | null;
  message_count: number;
  is_active: boolean;
  parent_session_id: string | null;
}

export interface HermesSearchHit {
  session_id: string;
  snippet: string;
  role: string | null;
  source: string | null;
  model: string | null;
  session_started: number | null;
}

export type HermesRawMessageRole = "user" | "assistant" | "tool" | "tool_call" | "tool_result" | "system";

export interface HermesRawMessage {
  role: HermesRawMessageRole;
  ts: number;
  content?: string;
  tool_name?: string;
  tool_call_id?: string;
  status?: string;
  // Hermes adds extras; passthrough.
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// listSessionsViaAcp — past-sessions list via ACP `session/list`.
//
// Search / delete / getMessages all live on the sentient-plugin REST sidecar
// (see plugin-client.ts). The drawer's list view is the only surface that
// goes through ACP today; mapping decisions for the SDK SessionRow shape:
//   - rootId      = sessionId  (ACP exposes no rootId; sessionId is a stable proxy)
//   - title       = row.title ?? DEFAULT_TITLE
//   - startedAt   = parsed updatedAt or 0  (ACP exposes no startedAt; updatedAt
//                   is the closest signal we have for sort ordering)
//   - lastActiveAt = parsed updatedAt or now  (drives the drawer's recency sort)
//   - messageCount = 0  (ACP doesn't expose; drawer doesn't display directly)
//   - isActive    = false  (caller stamps the current row at render time)
// ---------------------------------------------------------------------------

export interface ListSessionsViaAcpResult {
  readonly sessions: SessionRow[];
  readonly nextCursor: string | null;
}

const parseUpdatedAtMs = (raw: string | null | undefined): number | null => {
  if (raw === null || raw === undefined) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Fetch the past-sessions list via ACP `session/list`. The connection is owned
 * by the caller (ws-session-configure wires it from the bootstrapped ACP
 * per-profile connection).
 */
export async function listSessionsViaAcp(
  conn: AcpPerProfileConnection,
  args: { cursor?: string } = {},
): Promise<ListSessionsViaAcpResult> {
  log.debug("listViaAcp:request", { hasCursor: args.cursor !== undefined });
  const raw = await conn.listSessions(args.cursor !== undefined ? { cursor: args.cursor } : {});

  const sessions: SessionRow[] = [];
  for (const row of raw.sessions) {
    const parsed = sessionListSessionInfoSchema.safeParse(row);
    if (!parsed.success) {
      log.warn("listViaAcp:row-invalid", {
        reason: "schema-validation-failed",
        issues: parsed.error.issues.length,
      });
      continue;
    }
    const info = parsed.data;
    const updatedAtMs = parseUpdatedAtMs(info.updatedAt);
    sessions.push({
      sessionId: info.sessionId,
      rootId: info.sessionId,
      title: info.title ?? DEFAULT_TITLE,
      startedAt: updatedAtMs ?? 0,
      lastActiveAt: updatedAtMs ?? Date.now(),
      messageCount: 0,
      isActive: false,
    });
  }

  log.info("listViaAcp:ok", {
    received: raw.sessions.length,
    accepted: sessions.length,
    hasNext: raw.nextCursor !== null,
  });
  return { sessions, nextCursor: raw.nextCursor };
}
