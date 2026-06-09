import { getLog } from "../logging/logger.js";
import type { AcpClient } from "./client.js";
import { initializeResultSchema, sessionListResultSchema, sessionNewResultSchema } from "./schemas.js";
import type { SessionAttachmentLedger } from "./session-attachment-ledger.js";

// ---------------------------------------------------------------------------
// Schema-validated ACP session-CRUD requests (initialize / new / load / list).
//
// Split out of per-profile-connection.ts to keep that file under the size cap.
// These are stateless given their deps: the AcpClient transport, the
// attachment ledger (so a new/loaded session is recorded as attached to the
// current child), and the current socket epoch. The prompt / cancel lifecycle
// stays in per-profile-connection because it owns the in-flight prompt marker
// and the cycle-done fan-out.
// ---------------------------------------------------------------------------

const log = getLog(["sentient", "hermes-adapter-client", "acp", "session-rpc"]);

const ACP_PROTOCOL_VERSION = 1;
const DEFAULT_CWD = "/";

export interface SessionRpcDeps {
  readonly client: AcpClient;
  readonly ledger: SessionAttachmentLedger;
  readonly currentEpoch: () => number;
}

/** Throw a uniform validation error for any ACP response that fails its schema. */
export function failValidation(method: string, issues: ReadonlyArray<unknown>): never {
  const summary = issues.length === 0 ? "no-issues" : `${issues.length} issue(s)`;
  throw new Error(`ACP ${method} response validation failed: ${summary}`);
}

export async function initialize(deps: SessionRpcDeps): Promise<void> {
  log.info("initialize.begin");
  const raw = await deps.client.request("initialize", {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: { sessionList: true },
  });
  const parsed = initializeResultSchema.safeParse(raw);
  if (!parsed.success) failValidation("initialize", parsed.error.issues);
  log.info("initialize.done");
}

export async function newSession(
  deps: SessionRpcDeps,
  args: { mcpServers?: unknown[] },
): Promise<{ sessionId: string }> {
  const params = { cwd: DEFAULT_CWD, mcpServers: args.mcpServers ?? [] };
  log.debug("session.new.send", { mcpServers: params.mcpServers.length });
  const raw = await deps.client.request("session/new", params);
  const parsed = sessionNewResultSchema.safeParse(raw);
  if (!parsed.success) failValidation("session/new", parsed.error.issues);
  // A freshly minted session is, by definition, attached to THIS child.
  deps.ledger.markAttached(parsed.data.sessionId, deps.currentEpoch());
  log.info("session.new.done", { sessionId: parsed.data.sessionId, epoch: deps.currentEpoch() });
  return { sessionId: parsed.data.sessionId };
}

export async function loadSession(
  deps: SessionRpcDeps,
  args: { sessionId: string; mcpServers?: unknown[] },
): Promise<void> {
  const params = { sessionId: args.sessionId, cwd: DEFAULT_CWD, mcpServers: args.mcpServers ?? [] };
  log.debug("session.load.send", { sessionId: args.sessionId });
  await deps.client.request("session/load", params);
  // The session is now re-attached to the current child.
  deps.ledger.markAttached(args.sessionId, deps.currentEpoch());
  log.info("session.load.done", { sessionId: args.sessionId, epoch: deps.currentEpoch() });
}

export async function listSessions(
  deps: SessionRpcDeps,
  args: { cwd?: string; cursor?: string },
): Promise<{ sessions: unknown[]; nextCursor: string | null }> {
  const params: Record<string, unknown> = {};
  if (args.cwd !== undefined) params.cwd = args.cwd;
  if (args.cursor !== undefined) params.cursor = args.cursor;
  log.debug("session.list.send", { hasCursor: args.cursor !== undefined });
  const raw = await deps.client.request("session/list", params);
  const parsed = sessionListResultSchema.safeParse(raw);
  if (!parsed.success) failValidation("session/list", parsed.error.issues);
  const sessions = [...parsed.data.sessions];
  const nextCursor = parsed.data.nextCursor ?? null;
  log.debug("session.list.done", { count: sessions.length, hasNext: nextCursor !== null });
  return { sessions, nextCursor };
}
