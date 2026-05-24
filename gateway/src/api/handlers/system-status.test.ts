import { expect, test } from "bun:test";

import type { OrchestratorStatus } from "../../system-orchestrator/types.js";
import { createSystemStatusHandler } from "./system-status.js";

test("GET returns the current orchestrator status", async () => {
  const fakeStatus: OrchestratorStatus = {
    state: "ready" as const,
    services: [],
    startedAt: 1,
    finishedAt: 2,
  };
  const fakeOrch = { getStatus: () => fakeStatus };

  const h = createSystemStatusHandler({ systemOrchestrator: fakeOrch });
  const res = await h(new Request("http://localhost/api/v1/system/apply-status"));

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.state).toBe("ready");
  expect(body.services).toEqual([]);
  expect(body.startedAt).toBe(1);
  expect(body.finishedAt).toBe(2);
});

test("returns 503 when orchestrator is unavailable (no docker socket / not booted)", async () => {
  const h = createSystemStatusHandler({ systemOrchestrator: null });
  const res = await h(new Request("http://localhost/api/v1/system/apply-status"));
  expect(res.status).toBe(503);
  const body = await res.json();
  expect(body.error).toBe("orchestrator-unavailable");
});

test("returns 405 on non-GET request", async () => {
  const fakeStatus: OrchestratorStatus = {
    state: "ready" as const,
    services: [],
    startedAt: 1,
    finishedAt: 2,
  };
  const fakeOrch = { getStatus: () => fakeStatus };
  const h = createSystemStatusHandler({ systemOrchestrator: fakeOrch });
  const res = await h(new Request("http://localhost/api/v1/system/apply-status", { method: "POST" }));
  expect(res.status).toBe(405);
});
