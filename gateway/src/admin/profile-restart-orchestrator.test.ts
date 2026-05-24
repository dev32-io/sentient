import type { Result } from "@sentient/protocol";
import { describe, expect, it } from "vitest";
import {
  type ProfileRestartConfig,
  type ProfileRestartState,
  createProfileRestartOrchestrator,
} from "./profile-restart-orchestrator.ts";
import type { SupervisordError } from "./supervisord-control.ts";

const USER = "u_aaaaaaaa";

const cfg: ProfileRestartConfig = { restartTimeoutMs: 5000, pollIntervalMs: 50 };

interface FakeClock {
  now: number;
  tick(ms: number): void;
}

function makeClock(): FakeClock {
  return {
    now: 1000,
    tick(ms: number) {
      this.now += ms;
    },
  };
}

function okSupervisord() {
  return {
    restartProfile: async (_uid: string, _ms: number, _paired: boolean) => ({ ok: true as const, value: undefined }),
  };
}

const resolveSignalPairedFalse = async (_userId: string): Promise<boolean> => false;

describe("profile-restart-orchestrator FSM", () => {
  it("happy path: restarting -> ready", async () => {
    const clock = makeClock();
    const states: ProfileRestartState[] = [];
    const orch = createProfileRestartOrchestrator({
      supervisord: okSupervisord(),
      config: cfg,
      resolveSignalPaired: resolveSignalPairedFalse,
      onState: (s) => states.push(s),
      now: () => clock.now,
    });
    const r = await orch.restart(USER);
    expect(r.ok).toBe(true);
    expect(states).toEqual(["restarting", "ready"]);
  });

  it("supervisord failure -> failed", async () => {
    const states: ProfileRestartState[] = [];
    const orch = createProfileRestartOrchestrator({
      supervisord: {
        restartProfile: async (_uid, _ms, _paired) => ({
          ok: false as const,
          error: { kind: "shell-failed" as const, reason: "boom" } as SupervisordError,
        }),
      },
      config: cfg,
      resolveSignalPaired: resolveSignalPairedFalse,
      onState: (s) => states.push(s),
    });
    const r = await orch.restart(USER);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.kind).toBe("supervisord-failed");
    expect(states).toEqual(["restarting", "failed"]);
  });

  it("supervisord receives the userId verbatim", async () => {
    const supervisorCalls: string[] = [];
    const orch = createProfileRestartOrchestrator({
      supervisord: {
        restartProfile: async (uid: string, _ms: number, _paired: boolean): Promise<Result<void, SupervisordError>> => {
          supervisorCalls.push(uid);
          return { ok: true, value: undefined };
        },
      },
      config: cfg,
      resolveSignalPaired: resolveSignalPairedFalse,
    });
    const r = await orch.restart(USER);
    expect(r.ok).toBe(true);
    expect(supervisorCalls).toEqual([USER]);
  });
});
