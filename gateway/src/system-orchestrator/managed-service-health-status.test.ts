import { describe, expect, it } from "bun:test";
import { areRequiredManagedServicesReady, recordManagedServiceHealth } from "./managed-service-health-status.js";
import type { OrchestratorStatus, ServiceStatus } from "./types.js";

function service(name: string, optional: boolean, state: ServiceStatus["state"] = "ready"): ServiceStatus {
  return { name, optional, state, version: null, lastError: null };
}

function status(services: ServiceStatus[]): OrchestratorStatus {
  return { state: "ready", services, startedAt: 1, finishedAt: 2 };
}

describe("managed service health status", () => {
  it("marks a failed required outbound-worker and the stack not ready", () => {
    const next = recordManagedServiceHealth(
      status([service("outbound-worker", false), service("ha-mcp", true)]),
      "outbound-worker",
      false,
    );

    expect(next.state).toBe("failed");
    expect(next.services[0]).toMatchObject({ state: "failed", lastError: "health-probe-failed" });
    expect(areRequiredManagedServicesReady(next)).toBe(false);
  });

  it("does not let optional HA/MA health block unrelated readiness", () => {
    const next = recordManagedServiceHealth(
      status([service("outbound-worker", false), service("ha-mcp", true), service("ma-mcp", true)]),
      "ha-mcp",
      false,
    );

    expect(next.state).toBe("ready");
    expect(next.services[1]).toMatchObject({ state: "degraded", optional: true });
    expect(areRequiredManagedServicesReady(next)).toBe(true);
  });

  it("restores readiness after every required service is observed healthy", () => {
    const failed = status([service("outbound-worker", false, "failed"), service("ha-mcp", true, "degraded")]);
    failed.state = "failed";

    const recovered = recordManagedServiceHealth(failed, "outbound-worker", true);

    expect(recovered.state).toBe("ready");
    expect(recovered.services[0]).toMatchObject({ state: "ready", lastError: null });
    expect(areRequiredManagedServicesReady(recovered)).toBe(true);
  });
});
