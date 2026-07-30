import { describe, expect, it } from "vitest";
import { resolveMcpSocketPath } from "../mcp-host/socket-path.js";
import type { CliProcess, CliSpawnFn } from "./hermes-cli.js";
import { createHermesExternalTool } from "./hermes-external-tool.js";

const USER = "u_deadbeef";
const TIMEOUT_MS = 1000;

/** Fake `hermes` CLI. Records every argv and replays a canned stdout per call,
 *  so the unit test never spawns a real subprocess. */
function fakeCli(replies: ReadonlyArray<{ code?: number; stdout?: string }>): {
  spawn: CliSpawnFn;
  argvs: string[][];
} {
  const argvs: string[][] = [];
  const spawn: CliSpawnFn = (argv) => {
    const reply = replies[argvs.length] ?? {};
    argvs.push([...argv]);
    const proc: CliProcess = {
      exited: Promise.resolve(reply.code ?? 0),
      stdout: reply.stdout ?? "",
      stderr: "",
      kill() {},
    };
    return proc;
  };
  return { spawn, argvs };
}

const NOT_SET = "Config key not set: mcp_servers";
const REGISTERED = JSON.stringify({
  gateway: { command: "nc", args: ["-U", resolveMcpSocketPath(USER)], enabled: true },
});

describe("createHermesExternalTool", () => {
  // WIRE CONTRACT at a process boundary: the exact argv handed to the hermes
  // CLI. The socket argument must come from the same resolver the MCP host
  // listens on — a second spelling of that path is defect D8 wearing a new hat
  // and fails silently (hermes connects to nothing and reports no tools).
  it("registers the gateway MCP with the socket the mcp-host listens on", async () => {
    const { spawn, argvs } = fakeCli([{ stdout: NOT_SET }, {}, { stdout: REGISTERED }]);
    const tool = createHermesExternalTool({ delegatedTools: ["pause_audio"], timeoutMs: TIMEOUT_MS, spawn });

    const result = await tool.configure(USER);

    expect(result.ok).toBe(true);
    expect(argvs[1]).toEqual([
      "hermes",
      "-p",
      USER,
      "mcp",
      "add",
      "gateway",
      "--command",
      "nc",
      "--args",
      "-U",
      resolveMcpSocketPath(USER),
    ]);
  });

  // The boot step re-runs for every user on every boot. Re-adding would
  // re-prompt the CLI and rewrite a working entry.
  it("does not re-add a server that is already registered", async () => {
    const { spawn, argvs } = fakeCli([{ stdout: REGISTERED }]);
    const tool = createHermesExternalTool({ delegatedTools: ["pause_audio"], timeoutMs: TIMEOUT_MS, spawn });

    const result = await tool.configure(USER);

    expect(result.ok).toBe(true);
    expect(argvs).toHaveLength(1);
  });

  // NM-T9c's lesson: `hermes` exiting 0 coexisted with the profile having zero
  // tools. Registration is only done when the server is READ BACK.
  it("fails when the server is still absent after a zero-exit add", async () => {
    const { spawn } = fakeCli([{ stdout: NOT_SET }, { code: 0 }, { stdout: NOT_SET }]);
    const tool = createHermesExternalTool({ delegatedTools: ["pause_audio"], timeoutMs: TIMEOUT_MS, spawn });

    const result = await tool.configure(USER);

    expect(result).toEqual({ ok: false, error: "not-registered" });
  });

  // SECURITY BOUNDARY: `hermes mcp add` grants a server's WHOLE advertised
  // surface (its CLI has no non-interactive per-tool filter), so a surface with
  // no allow-tier tool must not be registered at all.
  it("registers nothing when no tool survives the allow tier", async () => {
    const { spawn, argvs } = fakeCli([]);
    const tool = createHermesExternalTool({ delegatedTools: [], timeoutMs: TIMEOUT_MS, spawn });

    const result = await tool.configure(USER);

    expect(result).toEqual({ ok: false, error: "no-allow-tier-tools" });
    expect(argvs).toHaveLength(0);
  });
});
