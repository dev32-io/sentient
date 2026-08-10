import { describe, expect, it } from "vitest";
import { resolveMcpSocketPath } from "../mcp-host/socket-path.js";
import type { CliProcess, CliSpawnFn } from "./hermes-cli.js";
import { createHermesExternalTool } from "./hermes-external-tool.js";

const USER = "u_deadbeef";
const TIMEOUT_MS = 1000;
const SOCKET = resolveMcpSocketPath(USER);
/** `orchestrator.delegation.hermes_delegation_profile` — the profile a
 *  delegation RUNS under, which is where the entry has to land. Deliberately
 *  not the userId: registering on a profile nothing spawns is the same silent
 *  tool-less delegation D11 was about, from the other end. */
const PROFILE = "default";

/** Fake `hermes` CLI. Records every argv and the stdin it was fed, and replays
 *  a canned stdout per call, so the unit test never spawns a real subprocess. */
function fakeCli(replies: ReadonlyArray<{ code?: number; stdout?: string }>): {
  spawn: CliSpawnFn;
  argvs: string[][];
  stdins: Array<string | undefined>;
} {
  const argvs: string[][] = [];
  const stdins: Array<string | undefined> = [];
  const spawn: CliSpawnFn = (argv, options) => {
    const reply = replies[argvs.length] ?? {};
    argvs.push([...argv]);
    stdins.push(options.stdin === undefined ? undefined : new TextDecoder().decode(options.stdin));
    const proc: CliProcess = {
      exited: Promise.resolve(reply.code ?? 0),
      stdout: reply.stdout ?? "",
      stderr: "",
      kill() {},
    };
    return proc;
  };
  return { spawn, argvs, stdins };
}

const NOT_SET = "Config key not set: mcp_servers";

/** A user's own MCP servers. Present in every fixture on purpose: this handler
 *  runs on the hot path of a delegation and must never touch them. */
const USER_OWN = {
  "their-notes": { command: "npx", args: ["@someone/notes-mcp"], enabled: true },
  "their-http": { url: "https://mcp.example.test/mcp", enabled: true },
};

function serversJson(gateway: Record<string, unknown> | null): string {
  return JSON.stringify(gateway === null ? USER_OWN : { ...USER_OWN, gateway });
}

const HEALTHY = { command: "nc", args: ["-U", SOCKET], enabled: true };
const DRIFTED_SOCKET = { command: "nc", args: ["-U", "/tmp/stale-mcp.sock"], enabled: true };

describe("createHermesExternalTool", () => {
  // WIRE CONTRACT at a process boundary: the exact argv handed to the hermes
  // CLI. The socket argument must come from the same resolver the MCP host
  // listens on — a second spelling of that path is defect D8 wearing a new hat
  // and fails silently (hermes connects to nothing and reports no tools).
  it("registers on the profile the delegation runs under, with the caller's own socket", async () => {
    const { spawn, argvs } = fakeCli([{ stdout: NOT_SET }, {}, { stdout: serversJson(HEALTHY) }]);
    const tool = createHermesExternalTool({
      profile: PROFILE,
      hostedDelegatedTools: ["pause_audio"],
      timeoutMs: TIMEOUT_MS,
      spawn,
    });

    const result = await tool.provide(USER);

    expect(result.ok).toBe(true);
    expect(argvs[1]).toEqual([
      "hermes",
      "-p",
      PROFILE,
      "mcp",
      "add",
      "gateway",
      "--command",
      "nc",
      "--args",
      "-U",
      SOCKET,
    ]);
  });

  // This now runs before EVERY delegation, not once per boot. Re-adding a
  // healthy entry would re-probe the socket and rewrite a working config on the
  // hot path of a user-visible action.
  it("does not re-add an entry that already matches", async () => {
    const { spawn, argvs } = fakeCli([{ stdout: serversJson(HEALTHY) }]);
    const tool = createHermesExternalTool({
      profile: PROFILE,
      hostedDelegatedTools: ["pause_audio"],
      timeoutMs: TIMEOUT_MS,
      spawn,
    });

    const result = await tool.provide(USER);

    expect(result.ok).toBe(true);
    expect(argvs).toHaveLength(1);
  });

  // INVARIANT — the hole task 9d left. Returning early on the NAME alone means
  // an entry whose args point at a socket nothing serves is reported healthy,
  // and the delegated agent silently runs with no gateway tools for as long as
  // the drift lasts. Verification compares CONTENT.
  it("repairs an entry whose args point at a stale socket", async () => {
    const { spawn, argvs, stdins } = fakeCli([
      { stdout: serversJson(DRIFTED_SOCKET) },
      {},
      { stdout: serversJson(HEALTHY) },
    ]);
    const tool = createHermesExternalTool({
      profile: PROFILE,
      hostedDelegatedTools: ["pause_audio"],
      timeoutMs: TIMEOUT_MS,
      spawn,
    });

    const result = await tool.provide(USER);

    expect(result.ok).toBe(true);
    expect(argvs[1]).toContain("add");
    expect(argvs[1]).toContain(SOCKET);
    // `hermes mcp add` on an existing name asks "already exists. Overwrite?
    // [y/N]" BEFORE "Enable all N tools? [Y/n/select]". One `y` answers only
    // the first and leaves the second at EOF, which cancels the save — with
    // exit code 0.
    expect(stdins[1]).toBe("y\ny\n");
  });

  // INVARIANT: a disabled entry is drift too — hermes skips it entirely, so the
  // delegated agent gets nothing while the name is still present.
  it("repairs an entry a user or an older build left disabled", async () => {
    const { spawn, argvs } = fakeCli([
      { stdout: serversJson({ ...HEALTHY, enabled: false }) },
      {},
      { stdout: serversJson(HEALTHY) },
    ]);
    const tool = createHermesExternalTool({
      profile: PROFILE,
      hostedDelegatedTools: ["pause_audio"],
      timeoutMs: TIMEOUT_MS,
      spawn,
    });

    expect((await tool.provide(USER)).ok).toBe(true);
    expect(argvs[1]).toContain("add");
  });

  // SECURITY / ADDITIVE BOUNDARY. The user's own MCP setup is theirs — they and
  // hermes edit it by hand and through an LLM. This handler owns exactly one
  // entry. A declarative reconcile that pruned or rewrote the rest on every
  // dispatch would be discovered by the user, not by a test — so assert it here.
  it("never names any server but its own, even when the user has others", async () => {
    const { spawn, argvs } = fakeCli([{ stdout: serversJson(DRIFTED_SOCKET) }, {}, { stdout: serversJson(HEALTHY) }]);
    const tool = createHermesExternalTool({
      profile: PROFILE,
      hostedDelegatedTools: ["pause_audio"],
      timeoutMs: TIMEOUT_MS,
      spawn,
    });

    await tool.provide(USER);

    const named = argvs.flat().filter((arg) => Object.keys(USER_OWN).includes(arg));
    expect(named).toEqual([]);
    expect(argvs.every((argv) => !argv.includes("remove") && !argv.includes("rm"))).toBe(true);
  });

  // NM-T9c's lesson: `hermes` exiting 0 coexisted with the profile having zero
  // tools — and every cancel path inside `mcp add` `return`s with exit 0.
  // Registration is only done when the entry is READ BACK and still matches.
  it("fails when the entry is still absent after a zero-exit add", async () => {
    const { spawn } = fakeCli([{ stdout: NOT_SET }, { code: 0 }, { stdout: NOT_SET }]);
    const tool = createHermesExternalTool({
      profile: PROFILE,
      hostedDelegatedTools: ["pause_audio"],
      timeoutMs: TIMEOUT_MS,
      spawn,
    });

    const result = await tool.provide(USER);

    expect(result).toEqual({ ok: false, error: "not-registered" });
  });

  it("fails when the read-back still shows the drifted entry", async () => {
    const { spawn } = fakeCli([
      { stdout: serversJson(DRIFTED_SOCKET) },
      { code: 0 },
      { stdout: serversJson(DRIFTED_SOCKET) },
    ]);
    const tool = createHermesExternalTool({
      profile: PROFILE,
      hostedDelegatedTools: ["pause_audio"],
      timeoutMs: TIMEOUT_MS,
      spawn,
    });

    const result = await tool.provide(USER);

    expect(result).toEqual({ ok: false, error: "not-registered" });
  });

  // SECURITY BOUNDARY: `hermes mcp add` grants a server's WHOLE advertised
  // surface (its CLI has no non-interactive per-tool filter), so a surface with
  // no allow-tier tool must not be registered at all.
  it("registers nothing when no hosted tool survives the allow tier", async () => {
    const { spawn, argvs } = fakeCli([]);
    const tool = createHermesExternalTool({ profile: PROFILE, hostedDelegatedTools: [], timeoutMs: TIMEOUT_MS, spawn });

    const result = await tool.provide(USER);

    expect(result).toEqual({ ok: false, error: "no-allow-tier-tools" });
    expect(argvs).toHaveLength(0);
  });
});
