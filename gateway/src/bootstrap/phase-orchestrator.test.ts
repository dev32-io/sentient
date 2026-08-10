import { describe, expect, it } from "bun:test";
import { findUnlaunchableNativeServices, findUnresolvedPlaceholders } from "./phase-orchestrator.ts";

// ---------------------------------------------------------------------------
// Boot-time substitution gate.
//
// `hostEnv` was built with `process.env.X ?? ""`. Unset, the placeholder
// SURVIVES substitution (template-loader leaves an unresolved `${VAR}` literal
// on purpose) and rides into a container's bind-mount source, where it surfaces
// as a Docker 400 five retry attempts later, naming neither the variable nor
// the service. The project's config rule says fail loudly when a required value
// is missing — so it has to fail at startup, and it has to say which variable
// and which service.
// ---------------------------------------------------------------------------

const EGRESS_TEMPLATE = `
image: kalaksi/tinyproxy:latest
volumes:
  - \${HOST_CONFIG_DIR}/egress-proxy/tinyproxy.conf:/etc/tinyproxy/tinyproxy.conf:ro
`;

const HA_TEMPLATE = `
image: ghcr.io/homeassistant-ai/ha-mcp:stable
environment:
  HOMEASSISTANT_URL: \${HOMEASSISTANT_URL}
  HOMEASSISTANT_TOKEN: \${HOMEASSISTANT_TOKEN}
extra_hosts:
  - \${HA_LOCAL_HOST}:\${HA_LOCAL_IP}
`;

describe("boot gate — an unresolved template placeholder fails at startup, not at apply time", () => {
  it("names the variable AND the service when a host-env placeholder cannot be resolved", () => {
    const defects = findUnresolvedPlaceholders(
      { "egress-proxy": { template: "egress-proxy.yaml" } },
      new Map([["egress-proxy.yaml", EGRESS_TEMPLATE]]),
      { HOST_CONFIG_DIR: "" },
    );

    expect(defects).toEqual([{ service: "egress-proxy", envVar: "HOST_CONFIG_DIR", template: "egress-proxy.yaml" }]);
  });

  it("passes once the variable resolves to a real value", () => {
    const defects = findUnresolvedPlaceholders(
      { "egress-proxy": { template: "egress-proxy.yaml" } },
      new Map([["egress-proxy.yaml", EGRESS_TEMPLATE]]),
      { HOST_CONFIG_DIR: "/Users/op/.sentient/gateway/config" },
    );

    expect(defects).toEqual([]);
  });

  it("checks EVERY substitution variable, not just the one that bit us", () => {
    const defects = findUnresolvedPlaceholders(
      {
        "egress-proxy": { template: "egress-proxy.yaml" },
        "ha-mcp": {
          template: "ha-mcp.yaml",
          secrets: {
            HOMEASSISTANT_URL: "home_assistant.url",
            HOMEASSISTANT_TOKEN: "home_assistant.mcp_server_token",
            HA_LOCAL_HOST: "home_assistant.url:host",
          },
        },
      },
      new Map([
        ["egress-proxy.yaml", EGRESS_TEMPLATE],
        ["ha-mcp.yaml", HA_TEMPLATE],
      ]),
      { HOST_CONFIG_DIR: "" },
    );

    // HA_LOCAL_IP is the one the secret bindings DON'T cover — it must be
    // reported alongside HOST_CONFIG_DIR, or "check the one we know about"
    // becomes the whole gate.
    expect(defects).toEqual([
      { service: "egress-proxy", envVar: "HOST_CONFIG_DIR", template: "egress-proxy.yaml" },
      { service: "ha-mcp", envVar: "HA_LOCAL_IP", template: "ha-mcp.yaml" },
    ]);
  });

  it("never reports a secret-bound variable — those are the registry's business, and optional services skip", () => {
    const defects = findUnresolvedPlaceholders(
      {
        "ha-mcp": {
          template: "ha-mcp.yaml",
          secrets: {
            HOMEASSISTANT_URL: "home_assistant.url",
            HOMEASSISTANT_TOKEN: "home_assistant.mcp_server_token",
            HA_LOCAL_HOST: "home_assistant.url:host",
            HA_LOCAL_IP: "home_assistant.local_ip",
          },
        },
      },
      new Map([["ha-mcp.yaml", HA_TEMPLATE]]),
      {},
    );

    expect(defects).toEqual([]);
  });

  it("ignores native services — their placeholders never survive to a template", () => {
    const defects = findUnresolvedPlaceholders(
      { "whisper-stt": { launch: "native", exec: ["${SENTIENT_CODE}/whisper-stt/venv/bin/python"] } },
      new Map(),
      {},
    );

    expect(defects).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The native half of the same fault, which the template gate structurally
// cannot see. `config.yaml`'s own `${VAR}`s are resolved by the CONFIG LOADER
// at read time and an unset one becomes the EMPTY STRING — it never reaches a
// template as a literal. So an unset SENTIENT_CODE yields the interpreter path
// `/whisper-stt/venv/bin/python`, which today is only discovered inside
// prepare(), twelve seconds into the apply.
// ---------------------------------------------------------------------------

describe("boot gate — a native service whose interpreter was empty-substituted", () => {
  it("reports the service and the truncated path — the fact, never a guessed cause", () => {
    const defects = findUnlaunchableNativeServices(
      { "whisper-stt": { launch: "native", exec: ["/whisper-stt/venv/bin/python", "-m", "whisper_stt"] } },
      () => false,
    );

    expect(defects).toEqual([{ service: "whisper-stt", interpreter: "/whisper-stt/venv/bin/python" }]);
  });

  it("stays quiet when the interpreter exists", () => {
    const defects = findUnlaunchableNativeServices(
      { "whisper-stt": { launch: "native", exec: ["/opt/sentient/current/whisper-stt/venv/bin/python"] } },
      () => true,
    );

    expect(defects).toEqual([]);
  });

  it("ignores docker services — they have no interpreter to launch", () => {
    const defects = findUnlaunchableNativeServices({ "ha-mcp": { template: "ha-mcp.yaml" } }, () => false);

    expect(defects).toEqual([]);
  });
});
