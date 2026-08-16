import { describe, expect, it } from "vitest";
import { requiredServicesOnline } from "./use-system-readiness.ts";

describe("requiredServicesOnline", () => {
  it("rejects a status with failed outbound-worker", () => {
    expect(
      requiredServicesOnline({
        state: "failed",
        services: [{ state: "failed", optional: false }],
      }),
    ).toBe(false);
  });

  it("allows optional HA/MA degradation", () => {
    expect(
      requiredServicesOnline({
        state: "ready",
        services: [
          { state: "ready", optional: false },
          { state: "degraded", optional: true },
          { state: "degraded", optional: true },
        ],
      }),
    ).toBe(true);
  });
});
