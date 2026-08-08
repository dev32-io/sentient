import { expect, test } from "bun:test";
import type { OrchestratorStatus } from "../system-orchestrator/types.js";
import { type RouterDeps, runApplyRouted, splitApplyDiff } from "./router.js";

const sysSnapshot: OrchestratorStatus = { state: "ready", services: [], startedAt: 0, finishedAt: 1 };

const baseDeps: RouterDeps = {
  roleOf: async () => "admin",
  diffSecrets: async () => ["home_assistant.mcp_server_token"],
  perUserApply: async () => ({ ok: true, value: { state: "ready", elapsedMs: 1 } }),
  systemOrchestrator: { applySubset: async () => ({ ...sysSnapshot, state: "ready" }) },
  registry: new Map(),
};

test("splitApplyDiff partitions blob into user-level + system-level keys", () => {
  const r = splitApplyDiff({
    profile: { model: { provider: "openrouter", id: "x" } },
    secrets: { home_assistant: { mcp_server_token: "tok" } },
  });
  expect(r.userLevel).not.toBe(null);
  expect(r.systemLevel).not.toBe(null);
});

test("runApplyRouted returns 403 when non-admin submits system-level changes", async () => {
  const r = await runApplyRouted(
    { profile: null, secrets: { home_assistant: { mcp_server_token: "tok" } } },
    { ...baseDeps, roleOf: async () => "adult" },
    "u_1",
  );
  expect(r.status).toBe(403);
});

test("runApplyRouted runs both orchestrators when admin submits both", async () => {
  let perUserCalled = false;
  let sysCalled = false;
  const r = await runApplyRouted(
    {
      profile: { model: { provider: "openrouter", id: "x" } },
      secrets: { home_assistant: { mcp_server_token: "tok" } },
    },
    {
      ...baseDeps,
      perUserApply: async () => {
        perUserCalled = true;
        return { ok: true, value: { state: "ready", elapsedMs: 1 } };
      },
      systemOrchestrator: {
        applySubset: async () => {
          sysCalled = true;
          return sysSnapshot;
        },
      },
    },
    "u_1",
  );
  expect(perUserCalled).toBe(true);
  expect(sysCalled).toBe(true);
  expect(r.status).toBe(200);
});

test("runApplyRouted is a no-op (200) when blob is empty", async () => {
  const r = await runApplyRouted({ profile: null, secrets: null }, baseDeps, "u_1");
  expect(r.status).toBe(200);
});
