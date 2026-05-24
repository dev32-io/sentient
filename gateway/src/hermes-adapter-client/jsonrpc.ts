import { z } from "zod";
import { getLog } from "../logging/logger.js";

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelope parser for ACP wire protocol
// ---------------------------------------------------------------------------
// Mirrors upstream `acp/schema.py`:
//   - ClientRequest / AgentRequest    → request envelope (id + method)
//   - AgentResponseMessage             → response with result
//   - AgentErrorMessage                → response with error
//   - ClientNotification / AgentNotification → notification (method, no id)
//
// Discriminator (per JSON-RPC 2.0 §4 / §5):
//   id present + method present  → request
//   id present + (result|error)  → response
//   method present + no id        → notification

const log = getLog(["sentient", "hermes-adapter-client", "acp"]);

/** JSON-RPC 2.0 id type. Numbers (no fractional parts) or strings; null discouraged. */
export const jsonRpcIdSchema = z.union([z.number().int(), z.string()]);
export type JsonRpcId = z.infer<typeof jsonRpcIdSchema>;

/** Error object on a response message. `data` is implementation-defined. */
export const jsonRpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type JsonRpcError = z.infer<typeof jsonRpcErrorSchema>;

const baseEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0").optional(),
  id: jsonRpcIdSchema.optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: jsonRpcErrorSchema.optional(),
});

export interface JsonRpcRequest {
  kind: "request";
  id: JsonRpcId;
  method: string;
  params: unknown;
}

export interface JsonRpcNotification {
  kind: "notification";
  method: string;
  params: unknown;
}

export interface JsonRpcResponse {
  kind: "response";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export type JsonRpcEnvelope = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/**
 * Parse a raw JSON value into a typed JSON-RPC envelope.
 *
 * Throws `Error` on a malformed envelope (none of the request/response/notification
 * shapes match). Caller is responsible for catching at the WS read boundary so a
 * single bad frame does not tear down the bridge.
 */
export function parseJsonRpcEnvelope(raw: unknown): JsonRpcEnvelope {
  const parsed = baseEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    log.warn("jsonrpc envelope shape rejected by zod", {
      issues: parsed.error.issues,
    });
    throw new Error("jsonrpc envelope: shape mismatch");
  }
  const env = parsed.data;
  const hasId = env.id !== undefined;
  const hasMethod = typeof env.method === "string";
  const hasResult = env.result !== undefined;
  const hasError = env.error !== undefined;

  if (hasId && hasMethod) {
    return {
      kind: "request",
      id: env.id as JsonRpcId,
      method: env.method as string,
      params: env.params,
    };
  }
  if (hasMethod && !hasId) {
    return {
      kind: "notification",
      method: env.method as string,
      params: env.params,
    };
  }
  if (hasId && (hasResult || hasError)) {
    const response: JsonRpcResponse = {
      kind: "response",
      id: env.id as JsonRpcId,
    };
    if (hasResult) response.result = env.result;
    if (hasError && env.error) response.error = env.error;
    return response;
  }

  log.warn("jsonrpc envelope: no discriminator matched", {
    hasId,
    hasMethod,
    hasResult,
    hasError,
  });
  throw new Error("jsonrpc envelope: not a request, response, or notification");
}
