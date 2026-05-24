import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import type { HealthCheck } from "./types.js";

const log = getLog(["sentient", "system-orch", "health"]);

export type HealthError = { kind: "timeout"; lastError: string | null };

export interface HealthIO {
  fetch(url: string, timeoutMs: number): Promise<{ ok: boolean }>;
  tcpProbe(target: string, timeoutMs: number): Promise<boolean>;
  execProbe(cmd: string[], timeoutMs: number): Promise<number>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface PollHealthyInput {
  healthcheck: HealthCheck;
  pollIntervalMs: number;
  io: HealthIO;
}

export async function pollHealthy(input: PollHealthyInput): Promise<Result<undefined, HealthError>> {
  const { healthcheck, pollIntervalMs, io } = input;
  // Noop probe — recreate-success implies ready; no liveness check.
  if ("noop" in healthcheck) return { ok: true, value: undefined };
  const deadline = io.now() + healthcheck.timeout_ms;
  let lastError: string | null = null;

  while (io.now() < deadline) {
    try {
      const ok = await runProbe(healthcheck, io);
      if (ok) return { ok: true, value: undefined };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log.debug("health.probe-error", { lastError });
    }
    await io.sleep(pollIntervalMs);
  }
  return { ok: false, error: { kind: "timeout", lastError } };
}

async function runProbe(hc: HealthCheck, io: HealthIO): Promise<boolean> {
  if ("noop" in hc) return true;
  if ("url" in hc) {
    const r = await io.fetch(hc.url, Math.min(hc.timeout_ms, 3000));
    return r.ok;
  }
  if ("tcp" in hc) {
    return io.tcpProbe(hc.tcp, Math.min(hc.timeout_ms, 3000));
  }
  const exit = await io.execProbe(hc.exec, Math.min(hc.timeout_ms, 3000));
  return exit === 0;
}
