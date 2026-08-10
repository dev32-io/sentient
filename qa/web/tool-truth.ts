#!/usr/bin/env bun
/**
 * tool-truth — independent ground truth for the tool-surface E2E rows.
 *
 * WHY THIS EXISTS. The tool-surface rows must assert the RESULT of a tool
 * call, not merely that one was dispatched. `native-tool-call`'s own recorded
 * evidence reads `isError=true` and it PASSED, because its oracle was "a tool
 * was dispatched". But the gateway log deliberately never records tool result
 * CONTENT (`tool-broker.dispatch.foreground.done` carries `isError` and
 * `contentLength` only — chat content must not reach the log). So an oracle
 * built from the gateway's own logs can only ever re-assert what the gateway
 * already believes.
 *
 * This dials the catalog MCP server DIRECTLY — same server, completely
 * different path, not through the gateway's ReAct loop, ToolBroker or PDP — so
 * the value it prints is independent of the thing under test. The row then
 * compares the model's on-screen reply against this. That is what makes the
 * content oracle non-circular.
 *
 * The streamable-HTTP handshake is hand-rolled on `fetch` rather than taken
 * from `@modelcontextprotocol/sdk`. Two reasons, in order: the SDK is a
 * `gateway/` workspace dependency and `qa/` is not in the workspace, so it does
 * not resolve here; and sharing the client library with the code under test
 * would let one SDK-level bug produce the same wrong answer on both sides,
 * which is exactly the circularity this file exists to avoid.
 *
 * SAFETY, and it is not negotiable: this stack runs against the owner's real
 * home. READ_ONLY_TOOLS below is a hard allowlist and the only tools this
 * prober will ever invoke. It is deliberately NOT derived from the catalog's
 * `read` tier — that tier contains `ma_playback`,
 * `ma_play_media` and `ma_volume`, which are prompt-free by design and would
 * start audio in someone's house. A QA prober needs a stricter list than the
 * product does.
 *
 * Usage:
 *   bun qa/web/tool-truth.ts <server> <tool> '<json-args>'
 *   bun qa/web/tool-truth.ts home_assistant ha_get_state '{"entity_id":"sun.sun"}'
 *   bun qa/web/tool-truth.ts --list                    # servers + allowed tools
 *   bun qa/web/tool-truth.ts ... --full                # do not truncate content
 *
 * Exit 0 only when the call returned `isError=false` with non-empty content.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// ── Tunables ───────────────────────────────────────────────────────────────
/** Budget for connect + one tool call (ms). Loopback MCP containers answer in
 *  tens of ms; searxng fan-out and `fetch` cross the egress proxy and are the
 *  slow ones. Range 5000-120000 — a hang guard, not a latency budget. */
const CALL_TIMEOUT_MS = 45_000;
/** Chars of result content echoed to stdout unless --full. Range 200-8000. */
const PREVIEW_MAX = 1200;

const CLIENT_NAME = "sentient-qa-tool-truth";
const CLIENT_VERSION = "1.0.0";
/** Protocol strings, not tunables — these are the MCP wire contract. */
const PROTOCOL_VERSION = "2024-11-05";
const ACCEPT = "application/json, text/event-stream";
const SESSION_HEADER = "mcp-session-id";

/**
 * The ONLY tools this prober may invoke. Every entry reads and nothing else:
 * no device state changes, no playback, no writes, no spend.
 *
 * Adding a tool here is a safety decision, not a convenience one. If a tool
 * can change anything an occupant of the house would notice, it does not
 * belong in this list no matter what tier `config.yaml#mcp_catalog` gives it.
 */
const READ_ONLY_TOOLS: Readonly<Record<string, readonly string[]>> = {
  home_assistant: [
    "ha_get_overview",
    "ha_get_state",
    "ha_search",
    "ha_get_history",
    "ha_eval_template",
    "ha_list_floors_areas",
    "ha_get_zone",
    "ha_get_todo",
    "ha_config_get_calendar_events",
  ],
  music_assistant: ["ma_search", "ma_browse", "ma_list_players"],
  searxng: ["search_web"],
  fetch: ["fetch"],
};

interface CatalogEntry {
  readonly name: string;
  readonly url: string;
}

function repoRootFrom(scriptPath: string): string {
  // qa/web/tool-truth.ts → repo root is two levels up.
  return resolve(dirname(scriptPath), "..", "..");
}

function readCatalog(configPath: string): CatalogEntry[] {
  const doc = Bun.YAML.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const block = doc.mcp_catalog;
  if (block === undefined || block === null || typeof block !== "object") {
    throw new Error(`config has no mcp_catalog block: ${configPath}`);
  }
  const entries: CatalogEntry[] = [];
  for (const [name, cfg] of Object.entries(block as Record<string, Record<string, unknown>>)) {
    // stdio entries (the gateway-hosted MCP) are not dialable over HTTP.
    if (cfg.transport !== "http" || typeof cfg.url !== "string") continue;
    entries.push({ name, url: cfg.url });
  }
  return entries;
}

/** The refusal that keeps a QA prober from touching the owner's house. */
function assertReadOnly(server: string, tool: string): void {
  const allowed = READ_ONLY_TOOLS[server];
  if (!allowed) {
    throw new Error(
      `refusing: server "${server}" has no read-only allowlist in tool-truth.ts. ` +
        `Known: ${Object.keys(READ_ONLY_TOOLS).join(", ")}`,
    );
  }
  if (!allowed.includes(tool)) {
    throw new Error(
      `refusing: "${tool}" is not in the read-only allowlist for ${server}. Allowed: ${allowed.join(", ")}. This prober never invokes a tool that can change what someone in the house sees or hears.`,
    );
  }
}

interface CallOutcome {
  readonly isError: boolean;
  readonly content: string;
}

interface JsonRpcResponse {
  readonly result?: Record<string, unknown>;
  readonly error?: { code: number; message: string };
}

/**
 * A streamable-HTTP MCP response is either a plain JSON body or an SSE stream
 * carrying the same JSON-RPC envelope in `data:` lines. Servers choose freely
 * per request, so both shapes must be understood.
 */
function parseRpcBody(contentType: string, body: string): JsonRpcResponse {
  if (!contentType.includes("text/event-stream")) {
    return JSON.parse(body) as JsonRpcResponse;
  }
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (payload.length === 0) continue;
    const frame = JSON.parse(payload) as JsonRpcResponse & { id?: unknown };
    // Skip server-initiated notifications; the response is the framed reply.
    if (frame.result !== undefined || frame.error !== undefined) return frame;
  }
  throw new Error("SSE stream carried no JSON-RPC result");
}

async function rpc(
  url: string,
  sessionId: string | null,
  message: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ response: JsonRpcResponse | null; sessionId: string | null }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: ACCEPT,
    "mcp-protocol-version": PROTOCOL_VERSION,
  };
  if (sessionId) headers[SESSION_HEADER] = sessionId;

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(message), signal });
  const nextSession = res.headers.get(SESSION_HEADER) ?? sessionId;
  // 202 Accepted is the correct answer to a notification — no body to parse.
  if (res.status === 202) return { response: null, sessionId: nextSession };
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}: ${preview(text)}`);
  }
  const parsed = parseRpcBody(res.headers.get("content-type") ?? "", text);
  if (parsed.error) {
    throw new Error(`JSON-RPC error ${parsed.error.code}: ${parsed.error.message}`);
  }
  return { response: parsed, sessionId: nextSession };
}

function preview(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= 200 ? flat : `${flat.slice(0, 200)}…`;
}

async function callDirect(entry: CatalogEntry, tool: string, args: unknown): Promise<CallOutcome> {
  const signal = AbortSignal.timeout(CALL_TIMEOUT_MS);

  const init = await rpc(
    entry.url,
    null,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      },
    },
    signal,
  );

  await rpc(entry.url, init.sessionId, { jsonrpc: "2.0", method: "notifications/initialized" }, signal);

  const called = await rpc(
    entry.url,
    init.sessionId,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } },
    signal,
  );

  const result = (called.response?.result ?? {}) as {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
  };
  const text = (result.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
  return { isError: result.isError === true, content: text };
}

/** Single stdout seam — `process.stdout.write`, matching stack-integrity.ts. */
function emit(line: string): void {
  process.stdout.write(`${line}\n`);
}

function printList(catalog: readonly CatalogEntry[]): void {
  emit("[tool-truth] dialable catalog servers and their read-only allowlist:\n");
  for (const entry of catalog) {
    const allowed = READ_ONLY_TOOLS[entry.name] ?? [];
    const shown = allowed.length > 0 ? allowed.join(", ") : "(none — prober refuses this server)";
    emit(`  ${entry.name.padEnd(16)} ${entry.url}`);
    emit(`  ${" ".repeat(16)} ${shown}\n`);
  }
}

async function main(): Promise<number> {
  const argv = Bun.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positional = argv.filter((a) => !a.startsWith("--"));

  const repoRoot = repoRootFrom(import.meta.path);
  const configPath = join(repoRoot, "gateway", "config.yaml");
  const catalog = readCatalog(configPath);

  if (flags.has("--list")) {
    printList(catalog);
    return 0;
  }

  const [server, tool, rawArgs] = positional;
  if (!server || !tool) {
    emit("usage: bun qa/web/tool-truth.ts <server> <tool> '<json-args>' [--full]");
    emit("       bun qa/web/tool-truth.ts --list");
    return 2;
  }

  assertReadOnly(server, tool);

  const entry = catalog.find((c) => c.name === server);
  if (!entry) {
    throw new Error(
      `server "${server}" is not an http entry in ${configPath}#mcp_catalog. ` +
        `Dialable: ${catalog.map((c) => c.name).join(", ")}`,
    );
  }

  let args: unknown = {};
  if (rawArgs) {
    try {
      args = JSON.parse(rawArgs);
    } catch (err) {
      throw new Error(`args must be JSON: ${String(err)}`);
    }
  }

  const startedAt = Date.now();
  emit(`[tool-truth] ${server}.${tool} → ${entry.url}  args=${JSON.stringify(args)}`);
  const outcome = await callDirect(entry, tool, args);
  const elapsedMs = Date.now() - startedAt;

  const body =
    flags.has("--full") || outcome.content.length <= PREVIEW_MAX
      ? outcome.content
      : `${outcome.content.slice(0, PREVIEW_MAX)}\n…[truncated, ${outcome.content.length} chars total; --full for all]`;

  emit(`[tool-truth] isError=${outcome.isError} contentLength=${outcome.content.length} elapsedMs=${elapsedMs}`);
  emit("─".repeat(72));
  emit(body);
  emit("─".repeat(72));

  if (outcome.isError) {
    emit("[tool-truth] RESULT FAIL — server returned isError=true");
    return 1;
  }
  if (outcome.content.length === 0) {
    emit("[tool-truth] RESULT FAIL — empty content is not ground truth");
    return 1;
  }
  emit("[tool-truth] RESULT OK");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    emit(`[tool-truth] RESULT FAIL — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
