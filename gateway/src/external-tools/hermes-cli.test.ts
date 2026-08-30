import { configure } from "@logtape/logtape";
import { beforeEach, describe, expect, it } from "vitest";

const logCalls: Array<{ message: string; properties: Record<string, unknown> }> = [];

import { type CliSpawnFn, runHermesCli } from "./hermes-cli.js";

const BASE_INPUT = {
  argv: ["hermes", "config", "get", "mcp_servers"],
  timeoutMs: 1000,
  step: "inspect",
  userId: "u_test",
};

describe("runHermesCli logging", () => {
  beforeEach(async () => {
    logCalls.splice(0);
    await configure({
      sinks: {
        test: (record) =>
          logCalls.push({ message: record.message.map(String).join(""), properties: record.properties }),
      },
      loggers: [
        { category: ["sentient", "external-tools", "hermes-cli"], sinks: ["test"], lowestLevel: "debug" },
        { category: "logtape", sinks: [], lowestLevel: "error" },
      ],
      reset: true,
    });
  });

  it("logs only channel sizes for a non-zero exit, never subprocess output", async () => {
    const secret = "PRIVATE_SUBPROCESS_OUTPUT";
    const spawn: CliSpawnFn = () => ({
      exited: Promise.resolve(1),
      stdout: `request failed: ${secret}`,
      stderr: `profile dump: ${secret}`,
      kill() {},
    });

    await runHermesCli({ ...BASE_INPUT, spawn });

    const failure = logCalls.find((call) => call.message === "hermes-cli.non-zero-exit");
    expect(failure?.properties).toEqual(
      expect.objectContaining({
        code: 1,
        stdoutBytes: Buffer.byteLength(`request failed: ${secret}`),
        stderrBytes: Buffer.byteLength(`profile dump: ${secret}`),
      }),
    );
    expect(JSON.stringify(logCalls)).not.toContain(secret);
    expect(failure?.properties).not.toHaveProperty("preview");
    expect(failure?.properties).not.toHaveProperty("stdout");
    expect(failure?.properties).not.toHaveProperty("stderr");
  });

  it("logs a safe error class instead of an arbitrary spawn error body", async () => {
    const secret = "spawn failed with token family-secret";
    const spawn: CliSpawnFn = () => {
      throw new Error(secret);
    };

    const result = await runHermesCli({ ...BASE_INPUT, spawn });

    expect(result).toEqual({ ok: false, error: "spawn-failed" });
    expect(logCalls.find((call) => call.message === "hermes-cli.spawn-failed")?.properties).toEqual(
      expect.objectContaining({ step: "inspect", userId: "u_test", errorClass: "error" }),
    );
    expect(JSON.stringify(logCalls)).not.toContain(secret);
  });
});
