import { describe, expect, it } from "vitest";
import {
  type Shell,
  type ShellResult,
  createSupervisordControl,
  renderEnvFragment,
  renderProgram,
} from "./supervisord-control.ts";

// Test template — exercises both program sections plus dashboardPort
// substitution so the renderer's contract stays pinned (two programs per
// profile, dashboardPort = port + DASHBOARD_PORT_OFFSET).
const TEMPLATE = `[program:hermes-{{userId}}-acp]
command=acp_ws_server.py --profile {{userId}} --port {{port}}
environment=
  HERMES_HOME="{{hermesHome}}",
  SENTIENT_HERMES_BEARER="{{token}}",
  SENTIENT_GATEWAY_PORT="{{port}}",
  {{env_block}}
  TZ="{{timezone}}"

[program:hermes-{{userId}}-dashboard]
command=hermes -p {{userId}} dashboard --port {{dashboardPort}} --host 0.0.0.0 --no-open --insecure
environment=
  HERMES_HOME="{{hermesHome}}",
  SENTIENT_HERMES_BEARER="{{token}}",
  TZ="{{timezone}}"
`;

const ENV_FRAGMENTS = {
  openrouter: 'OPENROUTER_API_KEY="{{api_key}}",\n  OPENROUTER_BASE_URL="{{base_url}}"',
  "ollama-cloud": 'OLLAMA_API_KEY="{{api_key}}",\n  OLLAMA_BASE_URL="{{base_url}}"',
  custom: 'CUSTOM_API_KEY="{{api_key}}",\n  CUSTOM_BASE_URL="{{base_url}}"',
};

function makeSecretsStore(apiKey = "", baseUrl = "") {
  return {
    getProviderSecrets: async () => ({
      ok: true as const,
      value: { provider: "openrouter" as const, apiKey, baseUrl },
    }),
  };
}

interface FakeShellState {
  calls: string[][];
  responses: Map<string, ShellResult>;
}

function fakeShell(state: FakeShellState): Shell {
  return async (argv) => {
    state.calls.push([...argv]);
    const key = argv.join(" ");
    return state.responses.get(key) ?? { ok: true, value: "" };
  };
}

function newState(): FakeShellState {
  return { calls: [], responses: new Map() };
}

const SOCKET = "/tmp/test.sock";

describe("renderEnvFragment", () => {
  it("substitutes api_key and base_url in the openrouter fragment", () => {
    const frag = renderEnvFragment(ENV_FRAGMENTS.openrouter, "sk-abc", "https://openrouter.ai/api/v1");
    expect(frag).toContain('OPENROUTER_API_KEY="sk-abc"');
    expect(frag).toContain('OPENROUTER_BASE_URL="https://openrouter.ai/api/v1"');
  });

  it("substitutes api_key and base_url in the custom fragment", () => {
    const frag = renderEnvFragment(ENV_FRAGMENTS.custom, "my-key", "https://example.com/v1");
    expect(frag).toContain('CUSTOM_API_KEY="my-key"');
    expect(frag).toContain('CUSTOM_BASE_URL="https://example.com/v1"');
  });
});

describe("renderProgram", () => {
  it("emits both program sections and substitutes dashboardPort = port + 1000", () => {
    const envBlock = renderEnvFragment(ENV_FRAGMENTS.openrouter, "sk-abc", "https://openrouter.ai/api/v1");
    const out = renderProgram(
      TEMPLATE,
      {
        userId: "u_aaaaaaaa",
        port: 8651,
        token: "tok",
        timezone: "UTC",
        provider: "openrouter",
        hermesHome: "/host/data/u_aaaaaaaa",
      },
      envBlock,
    );
    // Wire-protocol contract: two distinct program names per profile.
    expect(out).toContain("[program:hermes-u_aaaaaaaa-acp]");
    expect(out).toContain("[program:hermes-u_aaaaaaaa-dashboard]");
    // dashboardPort is derived (no field on UpsertInput); 8651 + 1000 = 9651.
    expect(out).toContain("--port 9651");
    expect(out).not.toContain("{{dashboardPort}}");
    // Both programs share the bearer (plugin auth gate reads from env).
    const bearerMatches = out.match(/SENTIENT_HERMES_BEARER="tok"/g);
    expect(bearerMatches?.length).toBeGreaterThanOrEqual(2);
    expect(out).toContain('SENTIENT_GATEWAY_PORT="8651"');
    expect(out).toContain('TZ="UTC"');
    expect(out).toContain('HERMES_HOME="/host/data/u_aaaaaaaa"');
    expect(out).toContain('OPENROUTER_API_KEY="sk-abc"');
    expect(out).not.toContain("{{env_block}}");
  });
});

describe("supervisord-control: upsertProgram", () => {
  it("writes program file then runs reread + update", async () => {
    const state = newState();
    let writtenPath = "";
    let writtenContent = "";
    const ctrl = createSupervisordControl({
      programsDir: "/tmp/progs",
      template: TEMPLATE,
      envFragments: ENV_FRAGMENTS,
      secretsStore: makeSecretsStore("sk-or", "https://openrouter.ai/api/v1"),
      shell: fakeShell(state),
      writeFile: async (path, content) => {
        writtenPath = path;
        writtenContent = content;
      },
      mkdirRecursive: async () => undefined,
      socketPath: SOCKET,
    });

    const r = await ctrl.upsertProgram({
      userId: "u_aaaaaaaa",
      port: 8651,
      token: "tok",
      timezone: "UTC",
      provider: "openrouter",
      hermesHome: "/host/data/u_aaaaaaaa",
    });

    expect(r.ok).toBe(true);
    expect(writtenPath).toBe("/tmp/progs/u_aaaaaaaa.conf");
    expect(writtenContent).toContain("[program:hermes-u_aaaaaaaa-acp]");
    expect(writtenContent).toContain("[program:hermes-u_aaaaaaaa-dashboard]");
    expect(writtenContent).toContain('OPENROUTER_API_KEY="sk-or"');
    // Wire-protocol contract: argv must include -s unix://<socket>, then reread, then update.
    expect(state.calls).toEqual([
      ["supervisorctl", "-s", `unix://${SOCKET}`, "reread"],
      ["supervisorctl", "-s", `unix://${SOCKET}`, "update"],
    ]);
  });

  it("returns io-failed when writeFile throws — reread/update skipped", async () => {
    const state = newState();
    const ctrl = createSupervisordControl({
      programsDir: "/tmp/progs",
      template: TEMPLATE,
      envFragments: ENV_FRAGMENTS,
      secretsStore: makeSecretsStore(),
      shell: fakeShell(state),
      writeFile: async () => {
        throw new Error("EACCES");
      },
      socketPath: SOCKET,
    });

    const r = await ctrl.upsertProgram({
      userId: "u_aaaaaaaa",
      port: 8651,
      token: "tok",
      timezone: "UTC",
      provider: "openrouter",
      hermesHome: "/host/data/u_aaaaaaaa",
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("io-failed");
    expect(state.calls).toEqual([]);
  });

  it("returns io-failed when secrets-store fails", async () => {
    const state = newState();
    const ctrl = createSupervisordControl({
      programsDir: "/tmp/progs",
      template: TEMPLATE,
      envFragments: ENV_FRAGMENTS,
      secretsStore: {
        getProviderSecrets: async () => ({
          ok: false as const,
          error: { kind: "io-error" as const, reason: "disk failure" },
        }),
      },
      shell: fakeShell(state),
      writeFile: async () => {},
      mkdirRecursive: async () => undefined,
      socketPath: SOCKET,
    });

    const r = await ctrl.upsertProgram({
      userId: "u_aaaaaaaa",
      port: 8651,
      token: "tok",
      timezone: "UTC",
      provider: "openrouter",
      hermesHome: "/host/data/u_aaaaaaaa",
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("io-failed");
    expect(state.calls).toEqual([]);
  });

  it("returns shell-failed when reread fails", async () => {
    const state = newState();
    state.responses.set(`supervisorctl -s unix://${SOCKET} reread`, {
      ok: false,
      error: { kind: "exit-non-zero", reason: "boom" },
    });
    const ctrl = createSupervisordControl({
      programsDir: "/tmp/progs",
      template: TEMPLATE,
      envFragments: ENV_FRAGMENTS,
      secretsStore: makeSecretsStore(),
      shell: fakeShell(state),
      writeFile: async () => {},
      mkdirRecursive: async () => undefined,
      socketPath: SOCKET,
    });

    const r = await ctrl.upsertProgram({
      userId: "u_aaaaaaaa",
      port: 8651,
      token: "tok",
      timezone: "UTC",
      provider: "openrouter",
      hermesHome: "/host/data/u_aaaaaaaa",
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("shell-failed");
      expect(r.error.reason).toBe("boom");
    }
  });
});

describe("supervisord-control: removeProgram", () => {
  it("issues stop, unlinks file, then reread + update", async () => {
    const state = newState();
    let unlinkedPath = "";
    const ctrl = createSupervisordControl({
      programsDir: "/tmp/progs",
      template: TEMPLATE,
      envFragments: ENV_FRAGMENTS,
      secretsStore: makeSecretsStore(),
      shell: fakeShell(state),
      writeFile: async () => {},
      unlinkFile: async (path) => {
        unlinkedPath = path;
      },
      socketPath: SOCKET,
    });

    const r = await ctrl.removeProgram("u_aaaaaaaa", false);

    expect(r.ok).toBe(true);
    expect(unlinkedPath).toBe("/tmp/progs/u_aaaaaaaa.conf");
    // Both program names appear in one stop call (supervisorctl accepts a list).
    expect(state.calls).toEqual([
      ["supervisorctl", "-s", `unix://${SOCKET}`, "stop", "hermes-u_aaaaaaaa-acp", "hermes-u_aaaaaaaa-dashboard"],
      ["supervisorctl", "-s", `unix://${SOCKET}`, "reread"],
      ["supervisorctl", "-s", `unix://${SOCKET}`, "update"],
    ]);
  });

  it("succeeds when stop returns non-zero (already stopped)", async () => {
    const state = newState();
    state.responses.set(`supervisorctl -s unix://${SOCKET} stop hermes-u_aaaaaaaa-acp hermes-u_aaaaaaaa-dashboard`, {
      ok: false,
      error: { kind: "exit-non-zero", reason: "no such process" },
    });
    const ctrl = createSupervisordControl({
      programsDir: "/tmp/progs",
      template: TEMPLATE,
      envFragments: ENV_FRAGMENTS,
      secretsStore: makeSecretsStore(),
      shell: fakeShell(state),
      writeFile: async () => {},
      unlinkFile: async () => {},
      socketPath: SOCKET,
    });

    const r = await ctrl.removeProgram("u_aaaaaaaa", false);

    expect(r.ok).toBe(true);
  });

  it("treats ENOENT on unlink as a no-op", async () => {
    const state = newState();
    const ctrl = createSupervisordControl({
      programsDir: "/tmp/progs",
      template: TEMPLATE,
      envFragments: ENV_FRAGMENTS,
      secretsStore: makeSecretsStore(),
      shell: fakeShell(state),
      writeFile: async () => {},
      unlinkFile: async () => {
        throw new Error("ENOENT: no such file");
      },
      socketPath: SOCKET,
    });

    const r = await ctrl.removeProgram("u_aaaaaaaa", false);

    expect(r.ok).toBe(true);
  });

  it("stops 3 programs when signal-paired (no per-user signal-cli)", async () => {
    const state = newState();
    const ctrl = createSupervisordControl({
      programsDir: "/tmp/progs",
      template: TEMPLATE,
      envFragments: ENV_FRAGMENTS,
      secretsStore: makeSecretsStore(),
      shell: fakeShell(state),
      writeFile: async () => {},
      unlinkFile: async () => {},
      socketPath: SOCKET,
    });

    const r = await ctrl.removeProgram("u_aaaaaaaa", true);

    expect(r.ok).toBe(true);
    expect(state.calls[0]).toEqual([
      "supervisorctl",
      "-s",
      `unix://${SOCKET}`,
      "stop",
      "hermes-u_aaaaaaaa-acp",
      "hermes-u_aaaaaaaa-dashboard",
      "hermes-u_aaaaaaaa-gateway",
    ]);
  });
});

describe("supervisord-control: restartProfile", () => {
  it("issues supervisorctl restart 2 programs when unpaired", async () => {
    const state = newState();
    const ctrl = createSupervisordControl({
      programsDir: "/tmp/progs",
      template: TEMPLATE,
      envFragments: ENV_FRAGMENTS,
      secretsStore: makeSecretsStore(),
      shell: fakeShell(state),
      writeFile: async () => {},
      mkdirRecursive: async () => undefined,
      socketPath: SOCKET,
    });

    const r = await ctrl.restartProfile("u_aaaaaaaa", 30_000, false);

    expect(r.ok).toBe(true);
    expect(state.calls).toEqual([
      ["supervisorctl", "-s", `unix://${SOCKET}`, "restart", "hermes-u_aaaaaaaa-acp", "hermes-u_aaaaaaaa-dashboard"],
    ]);
  });

  it("issues supervisorctl restart 3 programs when signal-paired (no per-user signal-cli)", async () => {
    const state = newState();
    const ctrl = createSupervisordControl({
      programsDir: "/tmp/progs",
      template: TEMPLATE,
      envFragments: ENV_FRAGMENTS,
      secretsStore: makeSecretsStore(),
      shell: fakeShell(state),
      writeFile: async () => {},
      mkdirRecursive: async () => undefined,
      socketPath: SOCKET,
    });

    const r = await ctrl.restartProfile("u_aaaaaaaa", 30_000, true);

    expect(r.ok).toBe(true);
    expect(state.calls).toEqual([
      [
        "supervisorctl",
        "-s",
        `unix://${SOCKET}`,
        "restart",
        "hermes-u_aaaaaaaa-acp",
        "hermes-u_aaaaaaaa-dashboard",
        "hermes-u_aaaaaaaa-gateway",
      ],
    ]);
  });

  it("returns shell-failed when restart fails", async () => {
    const state = newState();
    state.responses.set(`supervisorctl -s unix://${SOCKET} restart hermes-u_aaaaaaaa-acp hermes-u_aaaaaaaa-dashboard`, {
      ok: false,
      error: { kind: "exit-non-zero", reason: "no such program" },
    });
    const ctrl = createSupervisordControl({
      programsDir: "/tmp/progs",
      template: TEMPLATE,
      envFragments: ENV_FRAGMENTS,
      secretsStore: makeSecretsStore(),
      shell: fakeShell(state),
      writeFile: async () => {},
      mkdirRecursive: async () => undefined,
      socketPath: SOCKET,
    });

    const r = await ctrl.restartProfile("u_aaaaaaaa", 30_000, false);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("shell-failed");
      expect(r.error.reason).toBe("no such program");
    }
  });
});

describe("supervisord-control: restartPrograms", () => {
  it("issues supervisorctl restart for the given programs", async () => {
    const state = newState();
    const ctrl = createSupervisordControl({
      programsDir: "/tmp/progs",
      template: TEMPLATE,
      envFragments: ENV_FRAGMENTS,
      secretsStore: makeSecretsStore(),
      shell: fakeShell(state),
      writeFile: async () => {},
      mkdirRecursive: async () => undefined,
      socketPath: SOCKET,
    });

    const r = await ctrl.restartPrograms(["hermes-u_aaaaaaaa-gateway"]);

    expect(r.ok).toBe(true);
    expect(state.calls).toEqual([["supervisorctl", "-s", `unix://${SOCKET}`, "restart", "hermes-u_aaaaaaaa-gateway"]]);
  });

  it("returns ok immediately when programs list is empty", async () => {
    const state = newState();
    const ctrl = createSupervisordControl({
      programsDir: "/tmp/progs",
      template: TEMPLATE,
      envFragments: ENV_FRAGMENTS,
      secretsStore: makeSecretsStore(),
      shell: fakeShell(state),
      writeFile: async () => {},
      socketPath: SOCKET,
    });

    const r = await ctrl.restartPrograms([]);

    expect(r.ok).toBe(true);
    expect(state.calls).toEqual([]);
  });

  it("returns shell-failed when restart fails", async () => {
    const state = newState();
    state.responses.set(`supervisorctl -s unix://${SOCKET} restart hermes-u_aaaaaaaa-gateway`, {
      ok: false,
      error: { kind: "exit-non-zero", reason: "no such process" },
    });
    const ctrl = createSupervisordControl({
      programsDir: "/tmp/progs",
      template: TEMPLATE,
      envFragments: ENV_FRAGMENTS,
      secretsStore: makeSecretsStore(),
      shell: fakeShell(state),
      writeFile: async () => {},
      mkdirRecursive: async () => undefined,
      socketPath: SOCKET,
    });

    const r = await ctrl.restartPrograms(["hermes-u_aaaaaaaa-gateway"]);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("shell-failed");
      expect(r.error.reason).toBe("no such process");
    }
  });
});

describe("supervisord-control: stopRemovePrograms", () => {
  it("issues stop then reread + update for the given programs", async () => {
    const state = newState();
    const ctrl = createSupervisordControl({
      programsDir: "/tmp/progs",
      template: TEMPLATE,
      envFragments: ENV_FRAGMENTS,
      secretsStore: makeSecretsStore(),
      shell: fakeShell(state),
      writeFile: async () => {},
      unlinkFile: async () => {},
      socketPath: SOCKET,
    });

    const r = await ctrl.stopRemovePrograms(["hermes-u_aaaaaaaa-gateway"]);

    expect(r.ok).toBe(true);
    expect(state.calls).toEqual([
      ["supervisorctl", "-s", `unix://${SOCKET}`, "stop", "hermes-u_aaaaaaaa-gateway"],
      ["supervisorctl", "-s", `unix://${SOCKET}`, "reread"],
      ["supervisorctl", "-s", `unix://${SOCKET}`, "update"],
    ]);
  });

  it("proceeds past non-zero stop exit (programs already stopped)", async () => {
    const state = newState();
    state.responses.set(`supervisorctl -s unix://${SOCKET} stop hermes-u_aaaaaaaa-gateway`, {
      ok: false,
      error: { kind: "exit-non-zero", reason: "not running" },
    });
    const ctrl = createSupervisordControl({
      programsDir: "/tmp/progs",
      template: TEMPLATE,
      envFragments: ENV_FRAGMENTS,
      secretsStore: makeSecretsStore(),
      shell: fakeShell(state),
      writeFile: async () => {},
      unlinkFile: async () => {},
      socketPath: SOCKET,
    });

    const r = await ctrl.stopRemovePrograms(["hermes-u_aaaaaaaa-gateway"]);

    expect(r.ok).toBe(true);
  });

  it("returns ok immediately when programs list is empty", async () => {
    const state = newState();
    const ctrl = createSupervisordControl({
      programsDir: "/tmp/progs",
      template: TEMPLATE,
      envFragments: ENV_FRAGMENTS,
      secretsStore: makeSecretsStore(),
      shell: fakeShell(state),
      writeFile: async () => {},
      socketPath: SOCKET,
    });

    const r = await ctrl.stopRemovePrograms([]);

    expect(r.ok).toBe(true);
    expect(state.calls).toEqual([]);
  });
});

describe("supervisord-control: status", () => {
  it("parses RUNNING pid <n> from stdout", async () => {
    const state = newState();
    state.responses.set(`supervisorctl -s unix://${SOCKET} status hermes-u_aaaaaaaa-acp`, {
      ok: true,
      value: "hermes-u_aaaaaaaa-acp                   RUNNING   pid 12345, uptime 0:01:23",
    });
    const ctrl = createSupervisordControl({
      programsDir: "/tmp/progs",
      template: TEMPLATE,
      envFragments: ENV_FRAGMENTS,
      secretsStore: makeSecretsStore(),
      shell: fakeShell(state),
      writeFile: async () => {},
      mkdirRecursive: async () => undefined,
      socketPath: SOCKET,
    });

    const r = await ctrl.status("u_aaaaaaaa");

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ running: true, pid: 12345 });
  });

  it("returns running=false when not RUNNING", async () => {
    const state = newState();
    state.responses.set(`supervisorctl -s unix://${SOCKET} status hermes-u_aaaaaaaa-acp`, {
      ok: true,
      value: "hermes-u_aaaaaaaa-acp                   STOPPED   Not started",
    });
    const ctrl = createSupervisordControl({
      programsDir: "/tmp/progs",
      template: TEMPLATE,
      envFragments: ENV_FRAGMENTS,
      secretsStore: makeSecretsStore(),
      shell: fakeShell(state),
      writeFile: async () => {},
      mkdirRecursive: async () => undefined,
      socketPath: SOCKET,
    });

    const r = await ctrl.status("u_aaaaaaaa");

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ running: false, pid: null });
  });
});

// Template that exercises the {{signal_block}} placeholder — matches the shape
// of the real program.conf.tmpl (acp + dashboard + conditional signal block).
const TEMPLATE_WITH_SIGNAL_BLOCK = `[program:hermes-{{userId}}-acp]
command=acp_ws_server.py --profile {{userId}} --port {{port}}
environment=
  HERMES_HOME="{{hermesHome}}",
  {{env_block}}
  TZ="{{timezone}}"

[program:hermes-{{userId}}-dashboard]
command=hermes -p {{userId}} dashboard --port {{dashboardPort}} --host 0.0.0.0 --no-open --insecure
environment=
  HERMES_HOME="{{hermesHome}}",
  TZ="{{timezone}}"

{{signal_block}}`;

describe("renderProgram — signal_block conditional", () => {
  const BASE_INPUT = {
    userId: "u_abc",
    port: 8651,
    token: "tok",
    timezone: "UTC",
    provider: "openrouter" as const,
    hermesHome: "/host/data/u_abc",
  };
  const envBlock = renderEnvFragment(ENV_FRAGMENTS.openrouter, "sk-abc", "https://openrouter.ai/api/v1");

  it("renders only acp + dashboard programs for unpaired user", () => {
    const out = renderProgram(TEMPLATE_WITH_SIGNAL_BLOCK, { ...BASE_INPUT, signalPaired: false }, envBlock);
    expect(out).toContain("[program:hermes-u_abc-acp]");
    expect(out).toContain("[program:hermes-u_abc-dashboard]");
    expect(out).not.toContain("[program:hermes-u_abc-signal-cli]");
    expect(out).not.toContain("[program:hermes-u_abc-gateway]");
    // No leftover placeholder in the output.
    expect(out).not.toContain("{{signal_block}}");
  });

  it("renders 3 programs for paired user (acp + dashboard + gateway, no per-user signal-cli)", () => {
    const out = renderProgram(TEMPLATE_WITH_SIGNAL_BLOCK, { ...BASE_INPUT, signalPaired: true }, envBlock);
    expect(out).toContain("[program:hermes-u_abc-acp]");
    expect(out).toContain("[program:hermes-u_abc-dashboard]");
    // Signal-cli sidecar is shared — no per-user signal-cli program rendered.
    expect(out).not.toContain("[program:hermes-u_abc-signal-cli]");
    expect(out).toContain("[program:hermes-u_abc-gateway]");
    expect(out).not.toContain("{{signal_block}}");
  });

  it("gateway program block inherits the LLM env block (OPENROUTER_API_KEY etc.) so the agent loop can construct", () => {
    const out = renderProgram(TEMPLATE_WITH_SIGNAL_BLOCK, { ...BASE_INPUT, signalPaired: true }, envBlock);
    // Slice out the gateway block so we know the api key appears under it,
    // not just under the ACP/dashboard blocks above.
    const gatewayIdx = out.indexOf("[program:hermes-u_abc-gateway]");
    expect(gatewayIdx).toBeGreaterThan(0);
    const gatewayBlock = out.slice(gatewayIdx);
    expect(gatewayBlock).toContain("OPENROUTER_API_KEY=");
    // Token interpolation in the gateway block (SENTIENT_HERMES_BEARER) must
    // also resolve — same auth model as the ACP bridge.
    expect(gatewayBlock).toContain('SENTIENT_HERMES_BEARER="tok"');
    expect(out).not.toContain("{{env_block}}");
    expect(out).not.toContain("{{token}}");
  });
});
