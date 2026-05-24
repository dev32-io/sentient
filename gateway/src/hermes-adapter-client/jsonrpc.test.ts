import { describe, expect, it } from "vitest";
import { parseJsonRpcEnvelope } from "./jsonrpc.js";

// ACP envelopes are JSON-RPC 2.0 — wire shape per
//   https://www.jsonrpc.org/specification
// confirmed against the upstream Python `acp/schema.py` (ClientRequest /
// AgentRequest / AgentResponseMessage / AgentErrorMessage).

describe("parseJsonRpcEnvelope — discriminator", () => {
  it("classifies a request when id and method are present", () => {
    const result = parseJsonRpcEnvelope({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: { sessionList: true } },
    });
    expect(result.kind).toBe("request");
    if (result.kind === "request") {
      expect(result.id).toBe(1);
      expect(result.method).toBe("initialize");
    }
  });

  it("classifies a response with result when id and result are present", () => {
    const result = parseJsonRpcEnvelope({
      jsonrpc: "2.0",
      id: 2,
      result: { protocolVersion: 1, agentInfo: { name: "hermes-agent", version: "0.11.0" } },
    });
    expect(result.kind).toBe("response");
    if (result.kind === "response") {
      expect(result.id).toBe(2);
      expect(result.error).toBeUndefined();
      expect(result.result).toMatchObject({ protocolVersion: 1 });
    }
  });

  it("classifies a response with error when id and error are present", () => {
    const result = parseJsonRpcEnvelope({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32601, message: "Method not found", data: { method: "session/foo" } },
    });
    expect(result.kind).toBe("response");
    if (result.kind === "response") {
      expect(result.error).toMatchObject({ code: -32601, message: "Method not found" });
      expect(result.result).toBeUndefined();
    }
  });

  it("classifies a notification when method is present without id", () => {
    const result = parseJsonRpcEnvelope({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_1",
        update: { sessionUpdate: "agent_message_chunk", content: "hi" },
      },
    });
    expect(result.kind).toBe("notification");
    if (result.kind === "notification") {
      expect(result.method).toBe("session/update");
    }
  });

  it("rejects malformed envelope (no method, no id) by throwing", () => {
    expect(() => parseJsonRpcEnvelope({ jsonrpc: "2.0", random: "junk" })).toThrow();
  });
});
