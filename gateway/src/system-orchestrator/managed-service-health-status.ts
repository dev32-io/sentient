import type { OrchestratorStatus, ServiceName, ServiceStatus } from "./types.js";

/** Fold a post-boot health observation into the public orchestrator status.
 * Required services fail the stack; optional services only degrade themselves. */
export function recordManagedServiceHealth(
  status: OrchestratorStatus,
  name: ServiceName,
  healthy: boolean,
  reason = "health-probe-failed",
): OrchestratorStatus {
  let found = false;
  const services = status.services.map((service): ServiceStatus => {
    if (service.name !== name) return service;
    found = true;
    return {
      ...service,
      state: healthy ? "ready" : service.optional ? "degraded" : "failed",
      lastError: healthy ? null : reason,
    };
  });
  if (!found) return status;

  const requiredReady = services.filter((service) => !service.optional).every((service) => service.state === "ready");
  return {
    ...status,
    state: requiredReady ? "ready" : "failed",
    services,
    finishedAt: Date.now(),
  };
}

/** Readiness is gated only by required managed services. */
export function areRequiredManagedServicesReady(status: OrchestratorStatus): boolean {
  return (
    status.state === "ready" &&
    status.services.filter((service) => !service.optional).every((service) => service.state === "ready")
  );
}
