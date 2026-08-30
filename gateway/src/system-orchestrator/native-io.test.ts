import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { configure } from "@logtape/logtape";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = {
  spawn: vi.fn(),
  execFile: vi.fn(),
  logs: [] as Array<{ message: string; properties: Record<string, unknown> }>,
};

vi.mock("node:child_process", () => ({
  spawn: harness.spawn,
  execFile: harness.execFile,
}));

import { createNativeIO } from "./native-io.js";

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    unref: vi.fn(),
    kill: vi.fn(),
  });
  harness.spawn.mockReturnValue(child);
  return child;
}

describe("native subprocess logging", () => {
  beforeEach(async () => {
    harness.logs.splice(0);
    harness.spawn.mockReset();
    harness.execFile.mockReset();
    await configure({
      sinks: {
        test: (record) =>
          harness.logs.push({ message: record.message.map(String).join(""), properties: record.properties }),
      },
      loggers: [
        { category: ["sentient", "system-orch", "native-io"], sinks: ["test"], lowestLevel: "debug" },
        { category: "logtape", sinks: [], lowestLevel: "error" },
      ],
      reset: true,
    });
  });

  it("logs stdout/stderr byte and chunk aggregates without output bodies", async () => {
    const secret = "PRIVATE_SUBPROCESS_OUTPUT";
    const child = fakeChild();
    const proc = createNativeIO({ runDir: "/unused" }).spawn(["python", "service.py"], {
      detached: true,
      env: {},
      stdout: "pipe",
      stderr: "pipe",
    });

    child.stdout.write(`ready ${secret}`);
    child.stdout.end();
    child.stderr.write(`trace ${secret}`);
    child.stderr.end();
    child.emit("exit", 7);
    await proc.exited;
    await new Promise((resolve) => setImmediate(resolve));

    expect(harness.logs.filter((entry) => entry.message === "io.child-output-summary")).toEqual(
      expect.arrayContaining([
        {
          message: "io.child-output-summary",
          properties: { bin: "python", channel: "stdout", bytes: Buffer.byteLength(`ready ${secret}`), chunks: 1 },
        },
        {
          message: "io.child-output-summary",
          properties: { bin: "python", channel: "stderr", bytes: Buffer.byteLength(`trace ${secret}`), chunks: 1 },
        },
      ]),
    );
    expect(proc.stderrTail()).toBe(`trace ${secret}`);
    expect(JSON.stringify(harness.logs)).not.toContain(secret);
  });

  it("logs a safe class instead of a child-process error body", async () => {
    const secret = "exec failed with token family-secret";
    const child = fakeChild();
    const proc = createNativeIO({ runDir: "/unused" }).spawn(["python"], {
      detached: true,
      env: {},
      stdout: "pipe",
      stderr: "pipe",
    });

    child.emit("error", new Error(secret));
    await proc.exited;

    expect(harness.logs.find((entry) => entry.message === "io.child-error")?.properties).toEqual({
      bin: "python",
      errorClass: "error",
    });
    expect(JSON.stringify(harness.logs)).not.toContain(secret);
  });

  it("logs a safe class instead of a version-probe error body", async () => {
    const secret = "probe stderr contains family-secret";
    harness.execFile.mockImplementation((_bin, _args, _options, callback) => {
      callback(new Error(secret), "", secret);
    });

    const version = await createNativeIO({ runDir: "/unused" }).probeInterpreterVersion("python");

    expect(version).toBeNull();
    expect(harness.logs.find((entry) => entry.message === "io.version-probe-failed")?.properties).toEqual({
      interpreter: "python",
      errorClass: "error",
    });
    expect(JSON.stringify(harness.logs)).not.toContain(secret);
  });
});
