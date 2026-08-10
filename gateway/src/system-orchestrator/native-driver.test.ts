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
      infra: false,
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
    spawn: () => ({ pid: 1, exited: new Promise<number>(() => {}), kill: () => {}, stderrTail: () => "" }),
    isExecutable: async () => true,
    probeInterpreterVersion: async () => null,
    writePidFile: async () => {},
    readPidFiles: async () => [],
    removePidFile: async () => {},
    killPid: () => {},
    isPidAlive: () => true,
    listeningPidFor: async () => null,
    describePid: async () => null,
    sleep: async () => {},
    ...over,
  };
}

/** Settle knobs small enough that the port-wait loop costs nothing in a unit
 *  test; `sleep` is stubbed out above, so these only bound the iteration count. */
const FAST_SETTLE = { portSettleTimeoutMs: 40, portSettlePollMs: 10 };

describe("native-driver", () => {
  it("INVARIANT: a started service is spawned into its OWN process group", async () => {
    const spawned: Spawned[] = [];
    const driver = createNativeDriver(
      stubDeps({
        spawn: (cmd, opts) => {
          spawned.push({ cmd, opts: opts as unknown as Record<string, unknown> });
          return { pid: 4242, exited: new Promise<number>(() => {}), kill: () => {}, stderrTail: () => "" };
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
        isPidAlive: () => false, // the SIGTERM took: the record may go
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

  it("INVARIANT: reapOrphans keeps the pid file of a process that outlived its SIGTERM", async () => {
    // SIGTERM is asynchronous. Deleting the record while the process it names is
    // still alive is how the ownership evidence gets lost: if the gateway then
    // dies before the child does, its successor has no way left to prove that
    // survivor is its own, and refuses its own port forever.
    const removed: string[] = [];
    const driver = createNativeDriver(
      stubDeps({
        readPidFiles: async () => [{ name: "local-tts", pid: 999 }],
        isPidAlive: () => true, // still winding down
        removePidFile: async (name) => {
          removed.push(name);
        },
      }),
    );

    await driver.reapOrphans();

    expect(removed).toEqual([]);
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
        spawn: () => ({ pid: 0, exited: new Promise<number>(() => {}), kill: () => {}, stderrTail: () => "" }),
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
        spawn: () => ({ pid: 0, exited: new Promise<number>(() => {}), kill: () => {}, stderrTail: () => "" }),
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
        spawn: () => ({ pid: 4242, exited: new Promise<number>(() => {}), kill: () => {}, stderrTail: () => "" }),
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
    let holder: number | null = null; // free before the launch, bound by our child after
    const driver = createNativeDriver(
      stubDeps({
        spawn: () => {
          holder = 4242;
          return { pid: 4242, exited: new Promise<number>(() => {}), kill: () => {}, stderrTail: () => "" };
        },
        listeningPidFor: async () => holder,
      }),
      FAST_SETTLE,
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

  it("SECURITY: a foreign holder of a service's port is NAMED and refused, never killed", async () => {
    // The judgement call, pinned. A process the gateway did not start is not
    // ours to signal: on this very box the holder was the operator's own
    // `io.dev32.sentient.whisper-stt` LaunchAgent with KeepAlive=true, whose
    // argv is IDENTICAL to ours. Killing "whatever is on my port" would have
    // started an unbounded kill/respawn storm against launchd.
    const killed: number[] = [];
    const driver = createNativeDriver(
      stubDeps({
        listeningPidFor: async () => 9999, // never ours: we recorded nothing
        describePid: async () => "/usr/bin/python -m whisper_stt",
        killPid: (pid) => {
          killed.push(pid);
        },
      }),
      FAST_SETTLE,
    );

    const r = await driver.recreate(portedService("whisper-stt", 8768));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("port-held");
    expect(r.error.reason).toContain("9999");
    expect(r.error.reason).toContain("whisper_stt");
    expect(killed).toEqual([]);
  });

  it("INVARIANT: a leftover WE recorded is killed and waited out, then the port is reused", async () => {
    // The other half of the same call: our own detached child from a previous
    // gateway process IS identifiably ours — the pid file is the record — so it
    // is reaped rather than reported, and the spawn waits for the socket to
    // actually clear instead of racing it.
    const killed: number[] = [];
    let holder: number | null = 4242;
    const driver = createNativeDriver(
      stubDeps({
        readPidFiles: async () => [{ name: "whisper-stt", pid: 4242 }],
        listeningPidFor: async () => holder,
        killPid: (pid) => {
          killed.push(pid);
          holder = null; // the group died; the socket is released
        },
        spawn: () => ({ pid: 5555, exited: new Promise<number>(() => {}), kill: () => {}, stderrTail: () => "" }),
      }),
      FAST_SETTLE,
    );

    await driver.reapOrphans();
    const r = await driver.recreate(portedService("whisper-stt", 8768));

    expect(killed).toContain(4242);
    expect(r.ok).toBe(true);
  });

  it("INVARIANT: our own leftover that ignores SIGTERM is escalated to SIGKILL, never a foreign one", async () => {
    const signals: Array<{ pid: number; signal: string | undefined }> = [];
    const driver = createNativeDriver(
      stubDeps({
        readPidFiles: async () => [{ name: "whisper-stt", pid: 4242 }],
        listeningPidFor: async () => 4242, // clings to the socket throughout
        killPid: (pid, signal) => {
          signals.push({ pid, signal });
        },
      }),
      FAST_SETTLE,
    );

    await driver.reapOrphans();
    const r = await driver.recreate(portedService("whisper-stt", 8768));

    expect(signals.some((s) => s.signal === "SIGKILL" && s.pid === 4242)).toBe(true);
    // Still refused: escalation is bounded, and a port we cannot free is not a
    // port we may launch onto.
    expect(r.ok).toBe(false);
  });

  it("INVARIANT: a survivor named by its pid file is OURS even though THIS process never spawned it", async () => {
    // The restart case, found by driving it. Children are detached on purpose,
    // so they outlive a killed gateway; the pid file under ~/.sentient/run is
    // the only thing that still says they are ours. Without consulting it, the
    // replacement gateway classified its own predecessor's children as foreign
    // and refused forever — a permanent wedge, worse than the crash loop.
    const killed: number[] = [];
    let holder: number | null = 4242;
    const driver = createNativeDriver(
      stubDeps({
        readPidFiles: async () => [{ name: "whisper-stt", pid: 4242 }],
        listeningPidFor: async () => holder,
        killPid: (pid) => {
          killed.push(pid);
          holder = null;
        },
        spawn: () => ({ pid: 5555, exited: new Promise<number>(() => {}), kill: () => {}, stderrTail: () => "" }),
      }),
      FAST_SETTLE,
    );

    // NO reapOrphans() first — this is the path where the boot reconcile has
    // not run, or already cleared the file, and only the record remains.
    const r = await driver.recreate(portedService("whisper-stt", 8768));

    expect(killed).toContain(4242);
    expect(r.ok).toBe(true);
  });

  it("SECURITY: a pid owned by ONE service never authorises signalling another service's port holder", async () => {
    // Ownership is (service, pid), never a bare pid. The driver manages four
    // native ports; a record proving pid 4242 is our whisper-stt child says
    // nothing whatever about who is holding local-tts's 8770 — the pid may have
    // been reused, or the match may be pure coincidence. Anything but this
    // service's own record must be NAMED and refused, not signalled.
    const killed: number[] = [];
    const driver = createNativeDriver(
      stubDeps({
        readPidFiles: async () => [{ name: "whisper-stt", pid: 4242 }], // local-tts has no record
        listeningPidFor: async () => 4242, // …yet 4242 is what holds local-tts's port
        describePid: async () => "/usr/bin/python -m local_tts",
        killPid: (pid) => {
          killed.push(pid);
        },
      }),
      FAST_SETTLE,
    );

    await driver.reapOrphans(); // claims 4242 for whisper-stt, and SIGTERMs it once
    const r = await driver.recreate(portedService("local-tts", 8770));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("port-held");
    expect(r.error.reason).toContain("NOT signalled");
    // Exactly the reap's own SIGTERM — the local-tts launch added nothing.
    expect(killed).toEqual([4242]);
  });

  it("SECURITY: ownership ends when our child exits, so a REUSED pid is refused, not killed", async () => {
    // A record that outlives the process it names is an authorisation to kill a
    // stranger. Pids are reused within hours on an always-on box, and the driver
    // shells out to lsof/ps for four services on every 15 s watch tick, so it
    // sees plenty of pid churn. Once our child is gone, its pid is gone with it.
    const killed: number[] = [];
    let endChild: (code: number) => void = () => {};
    let holder: number | null = null;
    const svc = portedService("whisper-stt", 8768);
    const driver = createNativeDriver(
      stubDeps({
        spawn: () => ({
          pid: 4242,
          exited: new Promise<number>((resolve) => {
            endChild = resolve;
          }),
          kill: () => {},
          stderrTail: () => "",
        }),
        listeningPidFor: async () => holder,
        describePid: async () => "/usr/local/bin/unrelated-daemon",
        killPid: (pid) => {
          killed.push(pid);
        },
      }),
      FAST_SETTLE,
    );

    await driver.recreate(svc); // 4242 is ours…
    endChild(1); // …until it dies
    await new Promise<void>((resolve) => setTimeout(resolve, 0)); // let the exit watcher run
    holder = 4242; // the OS hands 4242 to a stranger, which binds our port

    const r = await driver.recreate(svc);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("port-held");
    expect(r.error.reason).toContain("NOT signalled");
    expect(killed).toEqual([]);
  });

  it("INVARIANT: a refused launch does not delete the pid file recording a live child", async () => {
    // stopIfRunning used to remove the pid file unconditionally, so one failed
    // attempt on a fresh process destroyed the ownership record of a child that
    // was still running — and every attempt after that saw a foreign holder.
    const removed: string[] = [];
    const driver = createNativeDriver(
      stubDeps({
        listeningPidFor: async () => 9999, // foreign: refuses
        removePidFile: async (name) => {
          removed.push(name);
        },
      }),
      FAST_SETTLE,
    );

    const r = await driver.recreate(portedService("whisper-stt", 8768));

    expect(r.ok).toBe(false);
    expect(removed).toEqual([]);
  });

  it("INVARIANT: a dead child's stderr becomes the failure reason, not a bare exit code", async () => {
    // The bind error that cost this branch a week was visible only when the
    // service was run by hand: the driver piped the child's stderr to DEBUG,
    // the gateway runs at INFO, and `native.exited` said "child process ended".
    // A supervisor that cannot say WHY its child died is not a supervisor.
    const svc = portedService("whisper-stt", 8768);
    let killChild: (code: number) => void = () => {};
    const driver = createNativeDriver(
      stubDeps({
        spawn: () => ({
          pid: 4242,
          exited: new Promise<number>((resolve) => {
            killChild = resolve;
          }),
          kill: () => {},
          stderrTail: () => "OSError: [Errno 48] error while attempting to bind on address ('127.0.0.1', 8768)",
        }),
      }),
    );
    await driver.recreate(svc);

    killChild(1);
    await Promise.resolve(); // let the exit watcher record it

    const r = await driver.verifyIdentity(svc);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toContain("Errno 48");
    expect(r.error.reason).toContain("4242");
  });

  it("INVARIANT: recreate never spawns when prepare fails", async () => {
    const spawned: Spawned[] = [];
    const driver = createNativeDriver(
      stubDeps({
        isExecutable: async () => false,
        spawn: (cmd, opts) => {
          spawned.push({ cmd, opts: opts as unknown as Record<string, unknown> });
          return { pid: 1, exited: new Promise<number>(() => {}), kill: () => {}, stderrTail: () => "" };
        },
      }),
    );

    const r = await driver.recreate(nativeService("whisper-stt", ["/does/not/exist"]));

    expect(r.ok).toBe(false);
    expect(spawned).toHaveLength(0);
  });
});
