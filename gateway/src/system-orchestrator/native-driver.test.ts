import { describe, expect, it } from "bun:test";
import { type NativeDriverDeps, createNativeDriver } from "./native-driver.js";
import type { HealthCheck, NativeManagedService } from "./types.js";

function nativeService(
  name: string,
  exec: [string, ...string[]],
  python?: string,
  healthcheck: HealthCheck = { noop: true },
): NativeManagedService {
  return {
    name,
    config: {
      launch: "native",
      exec,
      env: {},
      healthcheck,
      depends_on: [],
      optional: false,
      ...(python === undefined ? {} : { python }),
    },
  };
}

/** A service whose declared probe names a port, so identity can be checked. */
function portedService(name: string, port: number): NativeManagedService {
  return nativeService(name, ["/bin/true"], undefined, { tcp: `127.0.0.1:${port}`, timeout_ms: 1000 });
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
    listeningPidFor: async () => null,
    describePid: async () => null,
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

  it("INVARIANT: a spawn that yields no usable pid fails instead of recording a phantom process", async () => {
    const written: number[] = [];
    const driver = createNativeDriver(
      stubDeps({
        // The seam is typed `pid: number`, but a backend cannot always produce
        // a real one: node leaves `child.pid` undefined when exec fails
        // (missing binary, EACCES, bad shebang) and reports it asynchronously.
        spawn: () => ({ pid: 0, exited: new Promise<number>(() => {}), kill: () => {} }),
        writePidFile: async (_name, pid) => {
          written.push(pid);
        },
      }),
    );

    const r = await driver.recreate(nativeService("whisper-stt", ["/bin/echo"]));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("spawn-failed");
    expect(written).toEqual([]);
  });

  it("INVARIANT: no lifecycle path signals pid 0 — that is the gateway's OWN process group", async () => {
    const killed: number[] = [];
    const driver = createNativeDriver(
      stubDeps({
        spawn: () => ({ pid: 0, exited: new Promise<number>(() => {}), kill: () => {} }),
        readPidFiles: async () => [{ name: "local-tts", pid: 0 }],
        killPid: (pid) => {
          killed.push(pid);
        },
      }),
    );

    await driver.recreate(nativeService("local-tts", ["/bin/echo"]));
    await driver.stop("local-tts");
    await driver.remove("local-tts");
    await driver.reapOrphans();

    // kill(2): pid 0 addresses the CALLER's process group, so a single leaked
    // killPid(0) would SIGTERM the gateway while restarting one service.
    expect(killed).toEqual([]);
  });

  it("SECURITY: a port answered by a process we did not start is UNHEALTHY, not adopted", async () => {
    const svc = portedService("local-tts", 8770);
    const driver = createNativeDriver(
      stubDeps({
        spawn: () => ({ pid: 4242, exited: new Promise<number>(() => {}), kill: () => {} }),
        // Someone else owns the socket: an orphan, a stray launchd agent, or
        // an impostor sitting between the gateway and the family's audio.
        listeningPidFor: async () => 9999,
        describePid: async () => "/usr/bin/python -m local_tts",
      }),
    );
    await driver.recreate(svc);

    const r = await driver.verifyIdentity(svc);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("identity-failed");
    expect(r.error.reason).toContain("foreign");
    // The holder is NAMED — a refusal an operator cannot act on is a wedge.
    expect(r.error.reason).toContain("9999");
  });

  it("SECURITY: a port answered by the child we started IS healthy", async () => {
    const svc = portedService("local-tts", 8770);
    const driver = createNativeDriver(
      stubDeps({
        spawn: () => ({ pid: 4242, exited: new Promise<number>(() => {}), kill: () => {} }),
        listeningPidFor: async () => 4242,
      }),
    );
    await driver.recreate(svc);

    expect((await driver.verifyIdentity(svc)).ok).toBe(true);
  });

  it("SECURITY: a listener on the port of a service we never started is foreign, not adopted", async () => {
    // The exact false green: the boot spawn failed, so nothing was recorded,
    // and a day-old orphan answered the probe. Absence of a record is not
    // ownership.
    const driver = createNativeDriver(stubDeps({ listeningPidFor: async () => 9999 }));

    const r = await driver.verifyIdentity(portedService("whisper-stt", 8768));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("identity-failed");
  });

  it("INVARIANT: a service whose probe names no port falls back to our own pid record, never to a pass", async () => {
    // `noop` / `exec` healthchecks give the driver no socket to attribute, so
    // the strongest honest claim left is "the child we recorded is alive". It
    // must NOT default to healthy — the whole defect was a check that answered
    // "fine" when it had not actually checked anything.
    const driver = createNativeDriver(stubDeps({ isPidAlive: () => false }));

    const r = await driver.verifyIdentity(nativeService("portless", ["/bin/true"]));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("identity-failed");
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
