/**
 * JSON-RPC client to the shared signal-cli native HTTP daemon
 * (sentient-signal-cli) on the sentient-internal docker network.
 *
 * signal-cli's `daemon --http` exposes three endpoints (verified against
 * signal-cli's man page and source: see
 *   https://github.com/AsamK/signal-cli/blob/master/man/signal-cli.1.adoc
 * and Hermes' own gateway/platforms/signal.py adapter):
 *
 *   GET  /api/v1/check                   200 OK liveness probe
 *   GET  /api/v1/events?account=<E164>   SSE inbound message stream (used by
 *                                        Hermes' Signal adapter, not by us)
 *   POST /api/v1/rpc                     JSON-RPC 2.0 — every call
 *
 * The daemon runs in multi-account mode (no `-a` flag), so every JSON-RPC
 * call that targets a specific account passes `"account": "+E164"` in the
 * params object. Pre-link calls (`startLink`, `finishLink`) take no account.
 *
 * Why JSON-RPC, not bbernhard's REST wrapper:
 *   Hermes' Signal adapter speaks this exact protocol — it expects the
 *   native daemon's paths AND the same daemon process to be serving its
 *   /api/v1/events SSE stream for inbound messages. Running bbernhard would
 *   require patching Hermes' adapter; running the native daemon means
 *   Hermes works unchanged AND we share one process across linking
 *   + messaging.
 */
import { getLog } from "../../logging/logger.js";

const log = getLog(["sentient", "devices", "signal", "client"]);

const JSON_RPC_VERSION = "2.0" as const;

export interface StartLinkParams {
  deviceName: string;
}

export interface StartLinkResult {
  /** sgnl://linkdevice?... URI returned by the daemon. The caller renders this
   *  to a QR (gateway-side via the qrcode npm pkg, then sent down to the
   *  webui as a data: URL). Pass the same URI back into finishLink() after
   *  the user scans + confirms on their phone. */
  deviceLinkUri: string;
}

export interface FinishLinkParams {
  deviceLinkUri: string;
  /** Defaults to "Sentient" on Signal's Linked Devices view. Override per
   *  user (e.g. "Sentient-u_abc") so multiple Sentient users on one phone
   *  can tell which entry to revoke. */
  deviceName?: string;
  /** Aborts the in-flight HTTP request. finishLink blocks daemon-side until
   *  the phone scans+confirms; this is the only safe cancel handle. */
  signal?: AbortSignal;
}

export interface FinishLinkResult {
  /** E.164 of the newly-linked account. Same string used as the `account`
   *  parameter on every subsequent JSON-RPC call. */
  number: string;
}

interface JsonRpcRequest {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class SignalCliClient {
  private readonly fetchFn: typeof fetch;
  private idCounter = 0;

  constructor(
    private readonly baseUrl: string,
    fetchFn: typeof fetch = fetch,
  ) {
    this.fetchFn = fetchFn;
  }

  /** Liveness probe — daemon answers 200 OK on /api/v1/check as soon as
   *  the HTTP listener binds. Match Hermes' health-probe path exactly. */
  async health(): Promise<boolean> {
    try {
      const r = await this.fetchFn(`${this.baseUrl}/api/v1/check`);
      return r.ok;
    } catch (err) {
      log.debug("health-check-failed", { error: String(err) });
      return false;
    }
  }

  /** Begin device linking. Daemon contacts Signal's provisioning service,
   *  reserves a one-time linking URI, returns it without blocking. The URI
   *  is what the phone scans. Call finishLink() with the same URI once the
   *  scan is confirmed. */
  async startLink(params: StartLinkParams): Promise<StartLinkResult> {
    const result = await this.rpc<{ deviceLinkUri: string }>("startLink", {
      deviceName: params.deviceName,
    });
    return { deviceLinkUri: result.deviceLinkUri };
  }

  /** Complete device linking. Blocks until the phone scans + confirms or
   *  the daemon's internal timeout fires. On success the daemon adds the
   *  account to its multi-account store and returns the bound E.164. */
  async finishLink(params: FinishLinkParams): Promise<FinishLinkResult> {
    const result = await this.rpc<{ number: string }>(
      "finishLink",
      {
        deviceLinkUri: params.deviceLinkUri,
        ...(params.deviceName ? { deviceName: params.deviceName } : {}),
      },
      params.signal,
    );
    return { number: result.number };
  }

  /** Enumerate every E.164 currently registered in the daemon's data dir.
   *  Used by the pairing coordinator to detect drift and by unpair() flows
   *  to confirm an account exists before removeAccount(). */
  async listAccounts(): Promise<string[]> {
    const result = await this.rpc<Array<{ number: string }>>("listAccounts");
    return result.map((a) => a.number);
  }

  /** Drop the linked-device key material for this E.164 on the daemon side.
   *  Does NOT call removeDevice on the user's primary phone — the user can
   *  revoke from Signal app's Linked Devices view separately. */
  async removeAccount(account: string): Promise<void> {
    await this.rpc<unknown>("removeAccount", { account });
  }

  private nextId(): string {
    this.idCounter += 1;
    return `rpc-${this.idCounter}`;
  }

  private async rpc<T>(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const body: JsonRpcRequest = {
      jsonrpc: JSON_RPC_VERSION,
      id: this.nextId(),
      method,
      ...(params !== undefined ? { params } : {}),
    };
    log.debug("rpc-send", { method, id: body.id });
    const r = await this.fetchFn(`${this.baseUrl}/api/v1/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!r.ok) {
      throw new Error(`signal-cli rpc ${method} HTTP ${r.status}: ${await r.text()}`);
    }
    const parsed = (await r.json()) as JsonRpcResponse;
    if (parsed.error) {
      throw new Error(`signal-cli rpc ${method} error ${parsed.error.code}: ${parsed.error.message}`);
    }
    log.debug("rpc-ok", { method, id: parsed.id });
    return parsed.result as T;
  }
}
