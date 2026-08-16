import { describe, expect, it } from "bun:test";
import type { OrchestratorStatus, ServiceStatus } from "../../system-orchestrator/types.js";
import { createReadyHandler } from "./ready.js";

function service(name: string, optional: boolean, state: ServiceStatus["state"]): ServiceStatus {
  return { name, optional, state, version: null, lastError: null };
}

function handler(status: OrchestratorStatus | null) {
  return createReadyHandler({
    getActiveConnections: () => 3,
    getOrchestratorStatus: () => status,
  });
}

describe("GET /ready", () => {
  it("returns 503 while required outbound-worker is failed", async () => {
    const response = await handler({
      state: "failed",
      services: [service("outbound-worker", false, "failed")],
      startedAt: 1,
      finishedAt: 2,
    })(new Request("http://localhost/api/v1/ready"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "not-ready", connections: 3 });
  });

  it("stays ready when only optional HA/MA services are degraded", async () => {
    const response = await handler({
      state: "ready",
      services: [
        service("outbound-worker", false, "ready"),
        service("ha-mcp", true, "degraded"),
        service("ma-mcp", true, "degraded"),
      ],
      startedAt: 1,
      finishedAt: 2,
    })(new Request("http://localhost/api/v1/ready"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready", connections: 3 });
  });
});
