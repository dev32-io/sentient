import { describe, expect, it } from "vitest";
import { loadGatewayConfig, loadGatewayConfigFromString } from "./gateway-config.ts";

describe("loadGatewayConfigFromString", () => {
  const validYaml = `
port: 3000
host: 0.0.0.0
max_sessions: 10
auth_timeout_ms: 5000
session:
  ws_idle_timeout_ms: 255000
  per_user_max_sessions: 40
stt:
  provider: local-stt
  url: ws://stt-service:8766
tts:
  voice_id: my-voice-id
`;

  it("loads and validates config with literal tts.voice_id", () => {
    const config = loadGatewayConfigFromString(validYaml);

    expect(config.port).toBe(3000);
    expect(config.stt.provider).toBe("local-stt");
    expect(config.stt.url).toBe("ws://stt-service:8766");
    expect(config.tts.voice_id).toBe("my-voice-id");
  });

  it("applies default values for optional fields", () => {
    const config = loadGatewayConfigFromString(validYaml);

    expect(config.tts.format).toBe("opus");
  });

  it("applies default stt fields when only provider is specified", () => {
    const minimalYaml = `
port: 3000
host: 0.0.0.0
max_sessions: 10
auth_timeout_ms: 5000
session:
  ws_idle_timeout_ms: 255000
  per_user_max_sessions: 40
stt:
  provider: local-stt
tts: {}
`;
    const config = loadGatewayConfigFromString(minimalYaml);
    expect(config.stt.url).toBe("ws://stt-service:8766");
    expect(config.stt.language).toBe("auto");
    expect(config.stt.connect_timeout_ms).toBe(10000);
  });

  it("defaults tts.voice_id to 'default' when omitted", () => {
    const yamlWithoutVoiceId = `
port: 3000
host: 0.0.0.0
max_sessions: 10
auth_timeout_ms: 5000
session:
  ws_idle_timeout_ms: 255000
  per_user_max_sessions: 40
stt:
  provider: local-stt
tts: {}
`;
    const config = loadGatewayConfigFromString(yamlWithoutVoiceId);
    expect(config.tts.voice_id).toBe("default");
  });

  it("throws on invalid config schema", () => {
    const invalidYaml = `
port: "not-a-number"
stt:
  provider: local-stt
tts: {}
`;
    expect(() => loadGatewayConfigFromString(invalidYaml)).toThrow();
  });

  it("accepts port override", () => {
    const yamlWithPort = `
port: 8080
host: 0.0.0.0
max_sessions: 5
auth_timeout_ms: 3000
session:
  ws_idle_timeout_ms: 255000
  per_user_max_sessions: 40
stt:
  provider: local-stt
tts: {}
`;

    const config = loadGatewayConfigFromString(yamlWithPort);
    expect(config.port).toBe(8080);
    expect(config.max_sessions).toBe(5);
  });

  it("rejects port outside valid range", () => {
    const badPortYaml = `
port: 99999
host: 0.0.0.0
max_sessions: 10
auth_timeout_ms: 5000
session:
  ws_idle_timeout_ms: 255000
  per_user_max_sessions: 40
stt:
  provider: local-stt
tts: {}
`;

    expect(() => loadGatewayConfigFromString(badPortYaml)).toThrow();
  });
});

describe("loadGatewayConfig", () => {
  it("throws when config file does not exist", () => {
    expect(() => loadGatewayConfig("/nonexistent/path/config.yaml")).toThrow();
  });
});
