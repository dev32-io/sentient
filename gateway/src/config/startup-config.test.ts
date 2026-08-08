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
