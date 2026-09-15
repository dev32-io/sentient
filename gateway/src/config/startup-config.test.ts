import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expandHome, loadStartupConfig } from "./startup-config.ts";

describe("expandHome", () => {
  it("expands a leading ~ to the home directory", () => {
    expect(expandHome("~/.sentient/gateway/users")).toBe(`${homedir()}/.sentient/gateway/users`);
  });
  it("leaves an absolute path unchanged", () => {
    expect(expandHome("/var/lib/sentient")).toBe("/var/lib/sentient");
  });
  it("does not expand a bare ~ inside the path", () => {
    expect(expandHome("/opt/~backup")).toBe("/opt/~backup");
  });
});

// A channel the operator disabled in config.yaml must survive the map into
// StartupConfig — the D19 lying-knob guard: a `security.inbound_scan` section
// that silently did nothing is exactly the shape being prevented here.
const CONFIG_WITH_DISABLED_CHANNEL = `
port: 3000
host: 0.0.0.0
max_sessions: 10
auth_timeout_ms: 5000
session:
  ws_idle_timeout_ms: 255000
  per_user_max_sessions: 40
access:
  user_data_root: /tmp/sentient-test-users
orchestrator:
  provider:
    base_url: https://openrouter.ai/api/v1
    model: test-model
  loop: {}
  tools: {}
  delegation: {}
stt:
  provider: local-stt
tts: {}
security:
  inbound_scan:
    enabled: true
    channels:
      tool_result: false
      background_completion: true
      skill_body: true
      delegation_prompt: true
`;

// The household scope (memory spec §9) roots at `access.shared_data_root`; the
// operator comment in config.yaml uses a leading `~`. A raw `~` reaching the
// AccessManager lands the shared root under `<cwd>/~/` — this guards the
// load-boundary expansion (carried item, T24).
const CONFIG_WITH_TILDE_SHARED_ROOT = `
port: 3000
host: 0.0.0.0
max_sessions: 10
auth_timeout_ms: 5000
session:
  ws_idle_timeout_ms: 255000
  per_user_max_sessions: 40
access:
  user_data_root: ~/.sentient/gateway/users
  shared_data_root: ~/.sentient/gateway/shared
stt:
  provider: local-stt
tts: {}
`;

describe("loadStartupConfig — access root expansion", () => {
  it("expands a leading ~ in access.shared_data_root, same as user_data_root", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentient-startup-shared-"));
    const path = join(dir, "config.yaml");
    writeFileSync(path, CONFIG_WITH_TILDE_SHARED_ROOT);

    const prev = process.env.GATEWAY_CONFIG_PATH;
    process.env.GATEWAY_CONFIG_PATH = path;
    try {
      const cfg = loadStartupConfig();
      expect(cfg.access.user_data_root).toBe(`${homedir()}/.sentient/gateway/users`);
      // The shared root is absolute — no literal `~` left to resolve under cwd.
      expect(cfg.access.shared_data_root).toBe(`${homedir()}/.sentient/gateway/shared`);
      expect(cfg.access.shared_data_root?.startsWith("~")).toBe(false);
    } finally {
      if (prev === undefined) process.env.GATEWAY_CONFIG_PATH = undefined;
      else process.env.GATEWAY_CONFIG_PATH = prev;
    }
  });
});

describe("loadStartupConfig — scheduling/push carry-through", () => {
  it("maps explicit YAML policy without inventing provider credentials", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentient-startup-scheduling-"));
    const path = join(dir, "config.yaml");
    writeFileSync(
      path,
      `${CONFIG_WITH_TILDE_SHARED_ROOT}
scheduling:
  tick_interval_ms: 1000
  missed_grace_ms: 900000
  claim_lease_ms: 60000
  due_claim_limit: 25
  max_relative_delay_ms: 31536000000
  max_message_chars: 12000
  cards_default_page_size: 20
  cards_max_page_size: 100
  inbox_max_entries: 500
  inbox_retention_ms: 2592000000
  outbox_claim_limit: 50
  outbox_lease_ms: 60000
push:
  request_timeout_ms: 5000
  drain_interval_ms: 1000
  drain_claim_limit: 50
  max_attempts: 5
  retry_base_ms: 1000
  retry_max_ms: 60000
  payload_max_bytes: 4096
  content_preview_max_chars: 280
  revocation_ttl_ms: 2592000000
`,
    );
    const previousPath = process.env.GATEWAY_CONFIG_PATH;
    const previousVariant = process.env.SENTIENT_BUILD_VARIANT;
    process.env.GATEWAY_CONFIG_PATH = path;
    process.env.SENTIENT_BUILD_VARIANT = "Debug";
    try {
      const cfg = loadStartupConfig();
      expect(cfg.scheduling?.missedGraceMs).toBe(900000);
      expect(cfg.scheduling).toMatchObject({
        cardsDefaultPageSize: 20,
        cardsMaxPageSize: 100,
        inboxMaxEntries: 500,
        inboxRetentionMs: 2592000000,
      });
      expect(cfg.push?.payloadMaxBytes).toBe(4096);
      expect(cfg.push).toMatchObject({
        providerUrl: "http://127.0.0.1:8088/api/push",
        apnsTopic: "io.dev32.sentient.debug",
        apnsSandbox: true,
      });
      process.env.SENTIENT_BUILD_VARIANT = "Release";
      expect(loadStartupConfig().push).toMatchObject({
        providerUrl: "http://127.0.0.1:8088/api/push",
        apnsTopic: "io.dev32.sentient",
        apnsSandbox: false,
      });
      expect(cfg.push).not.toHaveProperty("apnsKey");
    } finally {
      if (previousPath === undefined) process.env.GATEWAY_CONFIG_PATH = undefined;
      else process.env.GATEWAY_CONFIG_PATH = previousPath;
      if (previousVariant === undefined) process.env.SENTIENT_BUILD_VARIANT = undefined;
      else process.env.SENTIENT_BUILD_VARIANT = previousVariant;
    }
  });
});

describe("loadStartupConfig — security.inbound_scan carry-through", () => {
  it("threads an operator-disabled channel into StartupConfig.inboundScan", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentient-startup-config-"));
    const path = join(dir, "config.yaml");
    writeFileSync(path, CONFIG_WITH_DISABLED_CHANNEL);

    const prev = process.env.GATEWAY_CONFIG_PATH;
    process.env.GATEWAY_CONFIG_PATH = path;
    try {
      const cfg = loadStartupConfig();
      expect(cfg.inboundScan.enabled).toBe(true);
      // The operator's `false` reaches the config the per-session gate is built
      // from — not silently overridden by a code-side default.
      expect(cfg.inboundScan.channels.tool_result).toBe(false);
      expect(cfg.inboundScan.channels.skill_body).toBe(true);
    } finally {
      if (prev === undefined) process.env.GATEWAY_CONFIG_PATH = undefined;
      else process.env.GATEWAY_CONFIG_PATH = prev;
    }
  });
});
