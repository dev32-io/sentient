import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "infrastructure", "health-poller"]);

export type HealthPollError = { kind: "timeout"; afterMs: number };

export interface HealthPoller {
  /** Poll GET ${url} until status 200 or timeout. Returns ok on first 200. */
  pollUntilHealthy(
    url: string,
    headers: Record<string, string>,
    timeoutMs: number,
    intervalMs: number,
  ): Promise<Result<void, HealthPollError>>;
}

async function pollOnce(
  url: string,
  headers: Record<string, string>,
  intervalMs: number,
  attempts: number,
): Promise<{ healthy: boolean }> {
  try {
    const resp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(intervalMs),
    });
    // Any HTTP response < 500 means the server is bound to the port and
    // serving requests. The hermes worker doesn't expose a dedicated
    // /health route — `/health` 404s on a fully-healthy worker, and `/ws`
    // 401s without protocol upgrade headers. Both states are "ready". A
    // 5xx, by contrast, is a real upstream failure worth retrying.
    if (resp.status < 500) return { healthy: true };
    log.debug("pollUntilHealthy.serverError", { url, status: resp.status, attempts });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.debug("pollUntilHealthy.fetchError", { url, reason, attempts });
  }
  return { healthy: false };
}

export function createHealthPoller(): HealthPoller {
  return {
    async pollUntilHealthy(url, headers, timeoutMs, intervalMs) {
      log.info("pollUntilHealthy.begin", { url, timeoutMs, intervalMs });
      const startedAt = Date.now();
      let attempts = 0;

      while (Date.now() - startedAt < timeoutMs) {
        attempts += 1;
        const { healthy } = await pollOnce(url, headers, intervalMs, attempts);
        if (healthy) {
          const elapsedMs = Date.now() - startedAt;
          log.info("pollUntilHealthy.healthy", { url, attempts, elapsedMs });
          return { ok: true, value: undefined };
        }
        const remaining = timeoutMs - (Date.now() - startedAt);
        if (remaining <= 0) break;
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
      }

      log.warn("pollUntilHealthy.timeout", { url, attempts, afterMs: timeoutMs });
      return { ok: false, error: { kind: "timeout", afterMs: timeoutMs } };
    },
  };
}
