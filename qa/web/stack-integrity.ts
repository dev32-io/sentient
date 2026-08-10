#!/usr/bin/env bun
/**
 * stack-integrity — the row the E2E matrix never had.
 *
 * Nothing anywhere asserted that the services `config.yaml` DECLARES are the
 * services that are actually running. `egress-proxy` once gave up with
 * `max-attempts-exhausted` and every other case still reported green, because
 * every other case only ever looked at the webui.
 *
 * The oracle is deliberately stricter than "something answers the port". That
 * weaker oracle is what hid a whole branch's worth of broken native
 * supervision: two stray LaunchAgents held 8768/8769/8770, every gateway child
 * died on EADDRINUSE, and the TCP probe was answered by launchd's agent — so
 * `apply.complete state="ready"` was true and meaningless. So:
 *
 *   declared    the service list is READ FROM config.yaml, never hardcoded, or
 *               this goes stale the day someone adds a service.
 *   running     docker  → a container labelled sentient.service=<name> is up.
 *               native  → the pid in ~/.sentient/run/<name>.pid is alive.
 *   identity    docker  → THAT container publishes the probed port on loopback.
 *               native  → the pid holding the LISTEN socket is EXACTLY the pid
 *                         the orchestrator recorded. Not "a pid". That one.
 *   healthy     the declared healthcheck actually connects.
 *   quiet       no `reapply.gave-up` since the current boot, and that boot's
 *               `apply.complete` reports failed=0 blocked=0.
 *
 * Usage:
 *   bun qa/web/stack-integrity.ts                     # live stack
 *   bun qa/web/stack-integrity.ts --config <path>     # negative control
 *   bun qa/web/stack-integrity.ts --run-dir <path>    # fake pid files (control)
 *   bun qa/web/stack-integrity.ts --json              # machine-readable
 *
 * Exit 0 only when every declared service passes every gate above.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// ── Tunables ───────────────────────────────────────────────────────────────
/** TCP connect budget per health probe (ms). Loopback — a healthy service
 *  answers in single-digit ms; this is a hang guard, not a latency budget. */
const PROBE_TIMEOUT_MS = 3000;
/** Budget for one `docker`/`lsof` invocation (ms). */
const CMD_TIMEOUT_MS = 15_000;
/** Max chars of any external output echoed into a finding. */
const PREVIEW_MAX = 120;
/** Container name prefix the docker driver builds (`sentient-<service>`) —
 *  a protocol string shared with docker-driver.ts, not a tunable. */
const LABEL_MANAGED = "sentient.managed";
const LABEL_SERVICE = "sentient.service";
/** One `config-loaded` line is emitted per gateway boot; the current boot's
 *  log window starts at the last one. */
const BOOT_MARKER = "config-loaded";
/** Every one of these must appear on the boot's last `apply.complete` line.
 *  `ready=<n>` is deliberately NOT here — the per-service gates below prove
 *  readiness far better than a count the orchestrator prints about itself. */
const APPLY_CLEAN_MARKERS = ['state="ready"', "failed=0", "blocked=0"] as const;

type Verdict = "PASS" | "FAIL" | "SKIP-OPTIONAL";

interface DeclaredService {
  readonly name: string;
  readonly launch: "docker" | "native";
  readonly optional: boolean;
  /** null when the service declares `healthcheck: { noop: true }`. */
  readonly probe: { host: string; port: number } | null;
}

interface ServiceFinding {
  readonly name: string;
  readonly launch: string;
  readonly verdict: Verdict;
  readonly running: string;
  readonly identity: string;
  readonly health: string;
  readonly notes: readonly string[];
}

function preview(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= PREVIEW_MAX ? flat : `${flat.slice(0, PREVIEW_MAX)}…`;
}

function run(cmd: string, args: readonly string[]): { ok: boolean; out: string } {
  const res = spawnSync(cmd, [...args], { encoding: "utf8", timeout: CMD_TIMEOUT_MS });
  if (res.error) return { ok: false, out: preview(String(res.error)) };
  if (res.status !== 0) return { ok: false, out: preview(`${res.stderr ?? ""}${res.stdout ?? ""}`) };
  return { ok: true, out: res.stdout ?? "" };
}

// ── Declared list — read from config, never hardcoded ───────────────────────

function readDeclaredServices(configPath: string): DeclaredService[] {
  const raw = readFileSync(configPath, "utf8");
  const doc = Bun.YAML.parse(raw) as Record<string, unknown>;
  const block = doc.managed_services;
  if (block === undefined || block === null || typeof block !== "object") {
    throw new Error(`config has no managed_services block: ${configPath}`);
  }
  return Object.entries(block as Record<string, Record<string, unknown>>).map(([name, cfg]) => {
    const launch = cfg.launch === "native" ? "native" : "docker";
    const hc = (cfg.healthcheck ?? {}) as Record<string, unknown>;
    const tcp = typeof hc.tcp === "string" ? hc.tcp : null;
    let probe: DeclaredService["probe"] = null;
    if (tcp) {
      const [host, port] = tcp.split(":");
      probe = { host: host ?? "127.0.0.1", port: Number(port) };
    }
    return { name, launch, optional: cfg.optional === true, probe };
  });
}

// ── Reality ────────────────────────────────────────────────────────────────

interface ContainerUnit {
  readonly containerName: string;
  readonly state: string;
}

/** Every container the ORCHESTRATOR claims, keyed by its declared service
 *  name. Read off the labels the driver writes, so a hand-started lookalike
 *  with the right name but no label does not count as the service. */
function readManagedContainers(): Map<string, ContainerUnit> {
  const out = new Map<string, ContainerUnit>();
  const res = run("docker", [
    "ps",
    "-a",
    "--filter",
    `label=${LABEL_MANAGED}=true`,
    "--format",
    `{{.Label "${LABEL_SERVICE}"}}|{{.Names}}|{{.State}}`,
  ]);
  if (!res.ok) return out;
  for (const line of res.out.split("\n")) {
    const [service, containerName, state] = line.split("|");
    if (!service || !containerName) continue;
    out.set(service, { containerName, state: state ?? "unknown" });
  }
  return out;
}

/** Ports published by one container, as `host:port` strings. */
function publishedPorts(containerName: string): string[] {
  const res = run("docker", ["port", containerName]);
  if (!res.ok) return [];
  return res.out
    .split("\n")
    .map((l) => l.split("->")[1]?.trim())
    .filter((v): v is string => Boolean(v));
}

function listeningPids(port: number): number[] {
  const res = run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  if (!res.ok) return [];
  return res.out
    .split("\n")
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function probeTcp(host: string, port: number): Promise<boolean> {
  return new Promise((res) => {
    const sock = connect({ host, port });
    const done = (ok: boolean): void => {
      sock.destroy();
      res(ok);
    };
    sock.setTimeout(PROBE_TIMEOUT_MS);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

// ── Per-service gates ──────────────────────────────────────────────────────

async function checkDocker(svc: DeclaredService, containers: Map<string, ContainerUnit>): Promise<ServiceFinding> {
  const notes: string[] = [];
  const unit = containers.get(svc.name);
  if (!unit) {
    return {
      name: svc.name,
      launch: "docker",
      verdict: svc.optional ? "SKIP-OPTIONAL" : "FAIL",
      running: "absent",
      identity: "n/a",
      health: "n/a",
      notes: [
        svc.optional
          ? "declared optional and no labelled container exists — operator has not configured it"
          : "declared REQUIRED but no container carries sentient.service=<name>",
      ],
    };
  }
  const running = unit.state === "running";
  notes.push(`container=${unit.containerName} state=${unit.state}`);
  if (!svc.probe) {
    return {
      name: svc.name,
      launch: "docker",
      verdict: running ? "PASS" : "FAIL",
      running: unit.state,
      identity: "container-labelled",
      health: "noop (no host-reachable port declared)",
      notes,
    };
  }
  const want = `${svc.probe.host}:${svc.probe.port}`;
  const published = publishedPorts(unit.containerName);
  const ownsPort = published.includes(want);
  notes.push(`published=[${published.join(",")}] declared=${want}`);
  const healthy = await probeTcp(svc.probe.host, svc.probe.port);
  return {
    name: svc.name,
    launch: "docker",
    verdict: running && ownsPort && healthy ? "PASS" : "FAIL",
    running: unit.state,
    identity: ownsPort ? `publishes ${want}` : `does NOT publish ${want} — something else answers it`,
    health: healthy ? `tcp ${want} ok` : `tcp ${want} UNREACHABLE`,
    notes,
  };
}

async function checkNative(svc: DeclaredService, runDir: string): Promise<ServiceFinding> {
  const notes: string[] = [];
  const pidPath = join(runDir, `${svc.name}.pid`);
  if (!existsSync(pidPath)) {
    return {
      name: svc.name,
      launch: "native",
      verdict: svc.optional ? "SKIP-OPTIONAL" : "FAIL",
      running: "no pid file",
      identity: "n/a",
      health: "n/a",
      notes: [`expected ${pidPath} — the orchestrator writes one per native service it starts`],
    };
  }
  const recorded = Number(readFileSync(pidPath, "utf8").trim());
  const alive = Number.isInteger(recorded) && recorded > 0 && isAlive(recorded);
  notes.push(`recordedPid=${recorded} alive=${alive}`);
  if (!svc.probe) {
    return {
      name: svc.name,
      launch: "native",
      verdict: alive ? "PASS" : "FAIL",
      running: alive ? `pid ${recorded}` : `pid ${recorded} is gone`,
      identity: "no port declared — liveness only",
      health: "noop",
      notes,
    };
  }
  // THE gate. "A port answers" is the oracle that hid broken supervision for a
  // whole branch: the answer came from a launchd agent, not from our child.
  const holders = listeningPids(svc.probe.port);
  const identityOk = holders.length === 1 && holders[0] === recorded;
  notes.push(`listeningPids=[${holders.join(",")}] on :${svc.probe.port}`);
  const healthy = await probeTcp(svc.probe.host, svc.probe.port);
  const identity = identityOk
    ? `listening pid == recorded pid (${recorded})`
    : `IMPOSTOR OR ORPHAN: :${svc.probe.port} held by [${holders.join(",")}], orchestrator recorded ${recorded}`;
  return {
    name: svc.name,
    launch: "native",
    verdict: alive && identityOk && healthy ? "PASS" : "FAIL",
    running: alive ? `pid ${recorded}` : `pid ${recorded} is gone`,
    identity,
    health: healthy ? `tcp ${svc.probe.host}:${svc.probe.port} ok` : "tcp UNREACHABLE",
    notes,
  };
}

// ── Log window for the current boot ────────────────────────────────────────

interface LogVerdict {
  readonly ok: boolean;
  readonly lines: readonly string[];
  readonly bootLineNo: number;
}

function checkLog(logPath: string): LogVerdict {
  if (!existsSync(logPath)) {
    return { ok: false, lines: [`log not found: ${logPath}`], bootLineNo: -1 };
  }
  const all = readFileSync(logPath, "utf8").split("\n");
  let bootIdx = -1;
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (all[i]?.includes(BOOT_MARKER)) {
      bootIdx = i;
      break;
    }
  }
  if (bootIdx < 0) {
    return { ok: false, lines: [`no "${BOOT_MARKER}" line — cannot bound the current boot`], bootLineNo: -1 };
  }
  const bootWindow = all.slice(bootIdx);
  const gaveUp = bootWindow.filter((l) => l.includes("reapply.gave-up"));
  const applies = bootWindow.filter((l) => l.includes("apply.complete"));
  const lastApply = applies.at(-1) ?? "";
  const findings: string[] = [];
  if (gaveUp.length > 0) findings.push(`reapply.gave-up ×${gaveUp.length}: ${preview(gaveUp[0] ?? "")}`);
  if (lastApply.length === 0) findings.push("no apply.complete in this boot window");
  const applyClean = lastApply.length > 0 && APPLY_CLEAN_MARKERS.every((marker) => lastApply.includes(marker));
  if (lastApply.length > 0 && !applyClean) findings.push(`apply not clean: ${preview(lastApply)}`);
  return {
    ok: gaveUp.length === 0 && applyClean,
    lines: findings.length > 0 ? findings : [preview(lastApply)],
    bootLineNo: bootIdx + 1,
  };
}

// ── Entry ──────────────────────────────────────────────────────────────────

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? (process.argv[i + 1] ?? null) : null;
}

async function main(): Promise<number> {
  const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
  const configPath = argValue("--config") ?? join(repoRoot, "gateway", "config.yaml");
  const hostHome = process.env.HOST_HOME && process.env.HOST_HOME.length > 0 ? process.env.HOST_HOME : homedir();
  const runDir = argValue("--run-dir") ?? join(hostHome, ".sentient", "run");
  const today = new Date();
  const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const logPath = argValue("--log") ?? join(hostHome, ".sentient", "gateway", "logs", `${stamp}.log`);
  const asJson = process.argv.includes("--json");

  const declared = readDeclaredServices(configPath);
  const containers = readManagedContainers();
  const findings: ServiceFinding[] = [];
  for (const svc of declared) {
    findings.push(svc.launch === "native" ? await checkNative(svc, runDir) : await checkDocker(svc, containers));
  }
  const logVerdict = checkLog(logPath);

  const failed = findings.filter((f) => f.verdict === "FAIL");
  const skipped = findings.filter((f) => f.verdict === "SKIP-OPTIONAL");
  const passed = findings.filter((f) => f.verdict === "PASS");
  const exitCode = failed.length > 0 || !logVerdict.ok ? 1 : 0;

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify({ configPath, logPath, runDir, findings, log: logVerdict, exitCode }, null, 2)}\n`,
    );
    return exitCode;
  }

  const w = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  w(`[stack-integrity] config=${configPath}`);
  w(`[stack-integrity] runDir=${runDir}`);
  w(`[stack-integrity] log=${logPath} (boot window starts line ${logVerdict.bootLineNo})`);
  w(`[stack-integrity] declared=${declared.length} services`);
  w("");
  for (const f of findings) {
    w(`  ${f.verdict.padEnd(14)} ${f.name} (${f.launch})`);
    w(`      running  ${f.running}`);
    w(`      identity ${f.identity}`);
    w(`      health   ${f.health}`);
    for (const n of f.notes) w(`      note     ${n}`);
    w("");
  }
  w(`[stack-integrity] log-window: ${logVerdict.ok ? "clean" : "DIRTY"}`);
  for (const l of logVerdict.lines) w(`  ${l}`);
  w("");
  w(
    `[stack-integrity] RESULT ${exitCode === 0 ? "PASS" : "FAIL"} — pass=${passed.length} fail=${failed.length} skip-optional=${skipped.length} of ${declared.length} declared`,
  );
  return exitCode;
}

process.exit(await main());
