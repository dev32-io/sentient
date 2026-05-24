import { z } from "zod";

/** JSON-RPC 2.0 request envelope */
export const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});
export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** MCP tool definition */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

/** MCP tools/call result shape */
export interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** JSON-RPC error codes per spec */
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

/**
 * Parse a single \n-delimited JSON-RPC message line.
 * Returns a request or an object indicating parse failure.
 */
export function parseRpcLine(line: string): { ok: true; req: JsonRpcRequest } | { ok: false; error: JsonRpcResponse } {
  try {
    const raw = JSON.parse(line);
    const p = jsonRpcRequestSchema.safeParse(raw);
    if (!p.success) {
      const id = typeof raw === "object" && raw !== null ? ((raw as { id?: string | number }).id ?? null) : null;
      return {
        ok: false,
        error: {
          jsonrpc: "2.0",
          id: id ?? null,
          error: { code: RPC_INVALID_REQUEST, message: "invalid request shape" },
        },
      };
    }
    return { ok: true, req: p.data };
  } catch {
    return {
      ok: false,
      error: {
        jsonrpc: "2.0",
        id: null,
        error: { code: RPC_PARSE_ERROR, message: "parse error" },
      },
    };
  }
}
