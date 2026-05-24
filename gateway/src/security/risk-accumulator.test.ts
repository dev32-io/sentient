import type { RiskConfig } from "@sentient/config";
import { describe, expect, it } from "vitest";
import { createRiskAccumulator } from "./risk-accumulator.js";

const defaultCfg: RiskConfig = {
  enabled: true,
  ttl_seconds: 300,
  threshold_warn: 50,
  threshold_escalate: 80,
  threshold_block: 100,
  weights: {
    injection_pattern: 30,
    repeated_offense: 20,
    role_violation: 60,
    ha_name_prompt_like: 15,
    mutating_sensitive_domain: 10,
    policy_rejection: 25,
  },
};

const now = 1_700_000_000_000;

describe("RiskAccumulator", () => {
  it("starts at score zero", () => {
    const acc = createRiskAccumulator(defaultCfg);
    expect(acc.score(now)).toBe(0);
  });

  it("increases score on record", () => {
    const acc = createRiskAccumulator(defaultCfg);
    const snap = acc.record("injection_pattern", now);
    expect(snap.score).toBe(30);
    expect(snap.level).toBe("none");
  });

  it("reaches warn with two injection patterns", () => {
    const acc = createRiskAccumulator(defaultCfg);
    acc.record("injection_pattern", now);
    const snap = acc.record("injection_pattern", now);
    expect(snap.score).toBe(60);
    expect(snap.level).toBe("warn");
  });

  it("reaches block with enough events", () => {
    const acc = createRiskAccumulator(defaultCfg);
    acc.record("role_violation", now); // 60
    acc.record("injection_pattern", now); // +30 = 90
    const snap = acc.record("policy_rejection", now); // +25 = 115
    expect(snap.level).toBe("block");
  });

  it("reaches escalate with role violation + injection", () => {
    const acc = createRiskAccumulator(defaultCfg);
    acc.record("role_violation", now); // 60
    const snap = acc.record("injection_pattern", now); // +30 = 90
    expect(snap.level).toBe("escalate");
  });

  it("role violation alone reaches warn", () => {
    const acc = createRiskAccumulator(defaultCfg);
    const snap = acc.record("role_violation", now);
    expect(snap.score).toBe(60);
    expect(snap.level).toBe("warn");
  });

  it("decays score over TTL", () => {
    const acc = createRiskAccumulator(defaultCfg);
    acc.record("injection_pattern", now); // 30 at t=0
    // After one half-life (300s), score should be ~15
    const afterHalfLife = acc.score(now + 300_000);
    expect(afterHalfLife).toBeCloseTo(15, 0);
  });

  it("decays to near-zero after multiple half-lives", () => {
    const acc = createRiskAccumulator(defaultCfg);
    acc.record("injection_pattern", now);
    const after5TTL = acc.score(now + 5 * 300_000);
    expect(after5TTL).toBeLessThan(1);
  });

  it("reset clears all events", () => {
    const acc = createRiskAccumulator(defaultCfg);
    acc.record("injection_pattern", now);
    acc.record("role_violation", now);
    acc.reset();
    expect(acc.score(now)).toBe(0);
  });

  it("returns zero score when disabled", () => {
    const cfg: RiskConfig = { ...defaultCfg, enabled: false };
    const acc = createRiskAccumulator(cfg);
    const snap = acc.record("injection_pattern", now);
    expect(snap.score).toBe(0);
    expect(snap.level).toBe("none");
  });

  it("level returns correct thresholds", () => {
    const acc = createRiskAccumulator(defaultCfg);
    expect(acc.level(0)).toBe("none");
    expect(acc.level(49)).toBe("none");
    expect(acc.level(50)).toBe("warn");
    expect(acc.level(79)).toBe("warn");
    expect(acc.level(80)).toBe("escalate");
    expect(acc.level(99)).toBe("escalate");
    expect(acc.level(100)).toBe("block");
  });
});
