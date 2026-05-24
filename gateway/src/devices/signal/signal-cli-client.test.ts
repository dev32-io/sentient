import { describe, expect, test } from "vitest";
import { SignalCliClient } from "./signal-cli-client";

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}

function makeFetchStub(
  responses: Array<{
    ok?: boolean;
    status?: number;
    _body?: unknown;
    /** Hold the response promise until release() is called — used to test
     *  AbortSignal cancellation of in-flight requests. */
    hold?: { release: () => void };
  }>,
): { fetch: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  let i = 0;
  const stubFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    const initHeaders = init?.headers;
    if (initHeaders && typeof initHeaders === "object" && !Array.isArray(initHeaders)) {
      for (const [k, v] of Object.entries(initHeaders as Record<string, string>)) headers[k.toLowerCase()] = v;
    }
    const bodyText = typeof init?.body === "string" ? init.body : undefined;
    const captured: CapturedCall = {
      url,
      method,
      headers,
      body: bodyText ? JSON.parse(bodyText) : undefined,
    };
    if (init?.signal) captured.signal = init.signal;
    calls.push(captured);
    const resp = responses[i++] ?? {};
    const hold = resp.hold;
    if (hold) {
      await new Promise<void>((resolve, reject) => {
        hold.release = resolve;
        init?.signal?.addEventListener("abort", () => reject(new Error("AbortError")));
      });
    }
    return {
      ok: resp.ok ?? true,
      status: resp.status ?? 200,
      json: async () => resp._body,
      text: async () => (typeof resp._body === "string" ? resp._body : JSON.stringify(resp._body ?? "")),
    } as Response;
  }) as typeof fetch;
  return { fetch: stubFetch, calls };
}

describe("SignalCliClient", () => {
  test("health() returns true when /api/v1/check responds 200", async () => {
    const { fetch, calls } = makeFetchStub([{ ok: true, status: 200 }]);
    const client = new SignalCliClient("http://sentient-signal-cli:8080", fetch);
    expect(await client.health()).toBe(true);
    expect(calls[0]?.url).toBe("http://sentient-signal-cli:8080/api/v1/check");
    expect(calls[0]?.method).toBe("GET");
  });

  test("health() returns false on non-200", async () => {
    const { fetch } = makeFetchStub([{ ok: false, status: 503 }]);
    const client = new SignalCliClient("http://sentient-signal-cli:8080", fetch);
    expect(await client.health()).toBe(false);
  });

  test("startLink wraps JSON-RPC startLink with deviceName param and returns deviceLinkUri", async () => {
    const { fetch, calls } = makeFetchStub([
      {
        _body: {
          jsonrpc: "2.0",
          id: "rpc-1",
          result: { deviceLinkUri: "sgnl://linkdevice?uuid=abc&pub_key=xyz" },
        },
      },
    ]);
    const client = new SignalCliClient("http://sentient-signal-cli:8080", fetch);
    const result = await client.startLink({ deviceName: "Sentient-u_abc" });
    const call = calls[0];
    if (!call) throw new Error("expected one captured fetch call");
    expect(call.url).toBe("http://sentient-signal-cli:8080/api/v1/rpc");
    expect(call.method).toBe("POST");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.body).toEqual({
      jsonrpc: "2.0",
      id: "rpc-1",
      method: "startLink",
      params: { deviceName: "Sentient-u_abc" },
    });
    expect(result.deviceLinkUri).toBe("sgnl://linkdevice?uuid=abc&pub_key=xyz");
  });

  test("finishLink wraps JSON-RPC finishLink and returns the bound E.164", async () => {
    const { fetch, calls } = makeFetchStub([
      {
        _body: {
          jsonrpc: "2.0",
          id: "rpc-1",
          result: { number: "+15551234567" },
        },
      },
    ]);
    const client = new SignalCliClient("http://sentient-signal-cli:8080", fetch);
    const result = await client.finishLink({
      deviceLinkUri: "sgnl://linkdevice?uuid=abc",
      deviceName: "Sentient-u_abc",
    });
    expect(calls[0]?.body).toEqual({
      jsonrpc: "2.0",
      id: "rpc-1",
      method: "finishLink",
      params: { deviceLinkUri: "sgnl://linkdevice?uuid=abc", deviceName: "Sentient-u_abc" },
    });
    expect(result.number).toBe("+15551234567");
  });

  test("finishLink propagates AbortSignal so the daemon-side blocking call can be cancelled", async () => {
    const hold = { release: () => {} };
    const { fetch, calls } = makeFetchStub([{ hold }]);
    const client = new SignalCliClient("http://sentient-signal-cli:8080", fetch);
    const ac = new AbortController();
    const promise = client.finishLink({ deviceLinkUri: "sgnl://x", signal: ac.signal });
    // give the fetch stub a tick to register
    await Promise.resolve();
    ac.abort();
    await expect(promise).rejects.toThrow(/Abort/);
    expect(calls[0]?.signal).toBe(ac.signal);
  });

  test("rpc throws when JSON-RPC envelope carries an error", async () => {
    const { fetch } = makeFetchStub([
      {
        _body: { jsonrpc: "2.0", id: "rpc-1", error: { code: -32601, message: "Method not found" } },
      },
    ]);
    const client = new SignalCliClient("http://sentient-signal-cli:8080", fetch);
    await expect(client.startLink({ deviceName: "x" })).rejects.toThrow(/error -32601.*Method not found/);
  });

  test("rpc throws on non-2xx HTTP status", async () => {
    const { fetch } = makeFetchStub([{ ok: false, status: 500, _body: "boom" }]);
    const client = new SignalCliClient("http://sentient-signal-cli:8080", fetch);
    await expect(client.startLink({ deviceName: "x" })).rejects.toThrow(/HTTP 500/);
  });

  test("listAccounts unwraps the JSON-RPC array-of-objects response into E.164 strings", async () => {
    const { fetch } = makeFetchStub([
      {
        _body: {
          jsonrpc: "2.0",
          id: "rpc-1",
          result: [{ number: "+15551234567" }, { number: "+19998887777" }],
        },
      },
    ]);
    const client = new SignalCliClient("http://sentient-signal-cli:8080", fetch);
    expect(await client.listAccounts()).toEqual(["+15551234567", "+19998887777"]);
  });

  test("removeAccount passes the account E.164 in JSON-RPC params", async () => {
    const { fetch, calls } = makeFetchStub([{ _body: { jsonrpc: "2.0", id: "rpc-1", result: null } }]);
    const client = new SignalCliClient("http://sentient-signal-cli:8080", fetch);
    await client.removeAccount("+15551234567");
    expect(calls[0]?.body).toEqual({
      jsonrpc: "2.0",
      id: "rpc-1",
      method: "removeAccount",
      params: { account: "+15551234567" },
    });
  });
});
