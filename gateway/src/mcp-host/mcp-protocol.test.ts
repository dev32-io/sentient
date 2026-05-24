import { describe, expect, it } from "vitest";
import { RPC_INVALID_REQUEST, RPC_PARSE_ERROR, parseRpcLine } from "./mcp-protocol.js";

describe("parseRpcLine", () => {
  it("parses a valid request", () => {
    const r = parseRpcLine('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
    expect(r.ok).toBe(true);
  });

  it("handles malformed JSON", () => {
    const r = parseRpcLine("{not valid");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.error?.code).toBe(RPC_PARSE_ERROR);
  });

  it("rejects missing method", () => {
    const r = parseRpcLine('{"jsonrpc":"2.0","id":1}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.error?.code).toBe(RPC_INVALID_REQUEST);
  });

  it("accepts notifications (no id)", () => {
    const r = parseRpcLine('{"jsonrpc":"2.0","method":"notify"}');
    expect(r.ok).toBe(true);
  });
});
