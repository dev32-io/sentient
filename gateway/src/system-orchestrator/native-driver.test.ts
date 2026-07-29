import { describe, expect, it } from "bun:test";
import { type NativeDriverDeps, createNativeDriver } from "./native-driver.js";
import type { NativeManagedService } from "./types.js";

function nativeService(name: string, exec: [string, ...string[]], python?: string): NativeManagedService {
  return {
    name,
    config: {
      launch: "native",
      exec,
      env: {},
      healthcheck: { noop: true },
      depends_on: [],
      optional: false,
      ...(python === undefined ? {} : { python }),
    },
  };
}

type Spawned = { cmd: string[]; opts: Record<string, unknown> };

function stubDeps(over: Partial<NativeDriverDeps> = {}): NativeDriverDeps {
  return {
    spawn: () => ({ pid: 1, exited: new Promise<number>(() => {}), kill: () => {} }),
    isExecutable: async () => true,
    probeInterpreterVersion: async () => null,
    writePidFile: async () => {},
    readPidFiles: async () => [],
    removePidFile: async () => {},
    killPid: () => {},
    isPidAlive: () => true,
    ...over,
  };
}

describe("native-driver", () => {
  it("INVARIANT: a started service is spawned into its OWN process group", async () => {
    const spawned: Spawned[] = [];
    const driver = createNativeDriver(
      stubDeps({
        spawn: (cmd, opts) => {
          spawned.push({ cmd, opts: opts as unknown as Record<string, unknown> });
          return { pid: 4242, exited: new Promise<number>(() => {}), kill: () => {} };
        },
      }),
    );

    const r = await driver.recreate(nativeService("whisper-stt", ["/bin/echo", "hi"]));

    expect(r.ok).toBe(true);
    expect(spawned).toHaveLength(1);
    // detached: true is what puts the child in its own group, so a later boot
    // can kill(-pgid) the whole tree even after the gateway was SIGKILLed.
    expect(spawned[0]?.opts.detached).toBe(true);
  });

  it("INVARIANT: reapOrphans kills PIDs left by a previous gateway process", async () => {
    const killed: number[] = [];
    const removed: string[] = [];
    const driver = createNativeDriver(
      stubDeps({
        readPidFiles: async () => [{ name: "local-tts", pid: 999 }],
        killPid: (pid) => {
          killed.push(pid);
        },
        removePidFile: async (name) => {
          removed.push(name);
        },
      }),
    );

    await driver.reapOrphans();

    expect(killed).toEqual([999]);
    expect(removed).toEqual(["local-tts"]);
  });

  it("INVARIANT: prepare fails when the pinned interpreter does not match argv[0]", async () => {
    const driver = createNativeDriver(stubDeps({ probeInterpreterVersion: async () => "3.14.0" }));

    const r = await driver.prepare(nativeService("local-tts", ["/opt/local-tts/venv/bin/python"], "3.11"));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("prepare-failed");
    expect(r.error.reason).toContain("3.11");
  });

  it("INVARIANT: recreate never spawns when prepare fails", async () => {
    const spawned: Spawned[] = [];
    const driver = createNativeDriver(
      stubDeps({
        isExecutable: async () => false,
        spawn: (cmd, opts) => {
          spawned.push({ cmd, opts: opts as unknown as Record<string, unknown> });
          return { pid: 1, exited: new Promise<number>(() => {}), kill: () => {} };
        },
      }),
    );

    const r = await driver.recreate(nativeService("whisper-stt", ["/does/not/exist"]));

    expect(r.ok).toBe(false);
    expect(spawned).toHaveLength(0);
  });
});
