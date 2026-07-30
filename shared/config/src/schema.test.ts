import { describe, expect, it } from "vitest";
import {
  applyConfigSchema,
  companionsConfigSchema,
  gatewayConfigSchema,
  loggingConfigSchema,
  sessionConfigSchema,
  sttConfigSchema,
  ttsConfigSchema,
} from "./schema.ts";

// Shared session fields required in every gateway config (no code defaults —
// YAML is the source of truth per config rules).
const wsResilienceSession = {
  ws_idle_timeout_ms: 255000,
  per_user_max_sessions: 40,
};

// Shared access/orchestrator fixtures. `access` is required (no `.default()`
// at the root), so every gatewayConfigSchema.parse() fixture below must
// supply it. `orchestrator` is optional (mirrors `hermes`) but every fixture
// still supplies it so the shape-when-present assertions below keep exercising
// a fully-populated orchestrator block.
const minimalAccess = { user_data_root: "/tmp/sentient-test-users" };
const minimalOrchestrator = {
  provider: { base_url: "https://openrouter.ai/api/v1", model: "test-model" },
  loop: {},
  tools: {},
  delegation: {},
};

describe("gatewayConfigSchema", () => {
  const minimalValidConfig = {
    stt: { provider: "local-stt" },
    tts: {},
    session: wsResilienceSession,
    access: minimalAccess,
    orchestrator: minimalOrchestrator,
  };

  it("accepts a minimal config and applies defaults", () => {
    const result = gatewayConfigSchema.parse(minimalValidConfig);

    expect(result.port).toBe(8888);
    expect(result.host).toBe("0.0.0.0");
    expect(result.max_sessions).toBe(100);
    expect(result.auth_timeout_ms).toBe(5000);
  });

  it("accepts a config with no orchestrator block — orchestrator is optional (mirrors hermes)", () => {
    const { orchestrator, ...withoutOrchestrator } = minimalValidConfig;
    const result = gatewayConfigSchema.parse(withoutOrchestrator);

    expect(result.orchestrator).toBeUndefined();
  });

  it("applies TTS defaults", () => {
    const result = gatewayConfigSchema.parse(minimalValidConfig);
    expect(result.tts.url).toBe("ws://host.docker.internal:8770");
    expect(result.tts.voice_id).toBe("default");
    expect(result.tts.format).toBe("opus");
    expect(result.tts.sample_rate).toBe(48000);
    expect(result.tts.connect_timeout_ms).toBe(10000);
  });

  it("honors overrides from YAML", () => {
    const result = gatewayConfigSchema.parse({
      ...minimalValidConfig,
      stt: { provider: "local-stt", language: "zh" },
      tts: {
        url: "ws://localhost:8770",
        voice_id: "custom",
        format: "opus",
        sample_rate: 44100,
      },
      session: wsResilienceSession,
    });
    expect(result.stt.language).toBe("zh");
    expect(result.tts.url).toBe("ws://localhost:8770");
    expect(result.tts.voice_id).toBe("custom");
    expect(result.tts.format).toBe("opus");
    expect(result.tts.sample_rate).toBe(44100);
  });

  it("rejects port out of range", () => {
    const invalid = { ...minimalValidConfig, port: 99999 };
    expect(gatewayConfigSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects invalid TTS format", () => {
    const invalid = { ...minimalValidConfig, tts: { format: "wav" } };
    expect(gatewayConfigSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects tts.format: pcm — gateway live path is opus-only", () => {
    const invalid = { ...minimalValidConfig, tts: { format: "pcm" } };
    expect(gatewayConfigSchema.safeParse(invalid).success).toBe(false);
  });

  it("defaults preview greetings and voice caps", () => {
    const cfg = ttsConfigSchema.parse({});
    expect(cfg.preview_greetings.en?.length).toBeGreaterThan(0);
    expect(cfg.preview_timeout_ms).toBe(8000);
    expect(cfg.voice_description_max_len).toBe(12000);
    expect(cfg.voice_max_tags).toBe(8);
  });

  it("applies TLS defaults (enabled, loopback hostname)", () => {
    const result = gatewayConfigSchema.parse(minimalValidConfig);
    expect(result.tls.enabled).toBe(true);
    expect(result.tls.hostnames).toEqual(["localhost"]);
  });

  it("accepts TLS hostname + disabled overrides", () => {
    const result = gatewayConfigSchema.parse({
      ...minimalValidConfig,
      tls: { enabled: false, hostnames: ["sentient.local", "192.168.0.240"] },
    });
    expect(result.tls.enabled).toBe(false);
    expect(result.tls.hostnames).toEqual(["sentient.local", "192.168.0.240"]);
  });
});

describe("sttConfigSchema", () => {
  it("applies defaults", () => {
    const result = sttConfigSchema.parse({ provider: "local-stt" });
    expect(result.url).toBe("ws://stt-service:8766");
    expect(result.language).toBe("auto");
    expect(result.input_sample_rate).toBe(48000);
    expect(result.silence_idle_gap_ms).toBe(200);
    expect(result.tts_echo_cooldown_ms).toBe(2500);
    expect(result.connect_timeout_ms).toBe(10000);
  });

  it("rejects silence_idle_gap_ms > 10000", () => {
    const result = sttConfigSchema.safeParse({ provider: "local-stt", silence_idle_gap_ms: 10001 });
    expect(result.success).toBe(false);
  });

  it("rejects negative silence_idle_gap_ms", () => {
    const result = sttConfigSchema.safeParse({ provider: "local-stt", silence_idle_gap_ms: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects tts_echo_cooldown_ms > 5000", () => {
    const result = sttConfigSchema.safeParse({ provider: "local-stt", tts_echo_cooldown_ms: 5001 });
    expect(result.success).toBe(false);
  });

  it("rejects negative tts_echo_cooldown_ms", () => {
    const result = sttConfigSchema.safeParse({ provider: "local-stt", tts_echo_cooldown_ms: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects provider: deepgram", () => {
    const result = sttConfigSchema.safeParse({ provider: "deepgram" });
    expect(result.success).toBe(false);
  });

  it("accepts zh language", () => {
    const result = sttConfigSchema.parse({ provider: "local-stt", language: "zh" });
    expect(result.language).toBe("zh");
  });

  it("rejects unknown language", () => {
    const result = sttConfigSchema.safeParse({ provider: "local-stt", language: "fr" });
    expect(result.success).toBe(false);
  });
});

describe("companionsConfigSchema", () => {
  it("defaults tts_health_url to the host-run local-tts health endpoint", () => {
    const result = companionsConfigSchema.parse({});
    expect(result.tts_health_url).toBe("http://host.docker.internal:8771/health");
  });

  it("accepts a tts_health_url override", () => {
    const result = companionsConfigSchema.parse({ tts_health_url: "http://localhost:8771/health" });
    expect(result.tts_health_url).toBe("http://localhost:8771/health");
  });

  it("rejects an invalid tts_health_url", () => {
    const result = companionsConfigSchema.safeParse({ tts_health_url: "not-a-url" });
    expect(result.success).toBe(false);
  });
});

describe("loggingConfigSchema", () => {
  it("defaults level and retention_days when omitted", () => {
    expect(loggingConfigSchema.parse({})).toEqual({ level: "info", retention_days: 7, level_overrides: {} });
  });

  it("accepts a custom retention_days within range", () => {
    expect(loggingConfigSchema.parse({ retention_days: 14 })).toEqual({
      level: "info",
      retention_days: 14,
      level_overrides: {},
    });
  });

  it("accepts retention_days = 0 as the disable sentinel", () => {
    expect(loggingConfigSchema.parse({ retention_days: 0 })).toEqual({
      level: "info",
      retention_days: 0,
      level_overrides: {},
    });
  });

  it("accepts per-category level overrides", () => {
    expect(
      loggingConfigSchema.parse({
        level_overrides: { "sentient:session-router": "debug" },
      }),
    ).toEqual({
      level: "info",
      retention_days: 7,
      level_overrides: { "sentient:session-router": "debug" },
    });
  });

  it("rejects negative retention_days", () => {
    expect(() => loggingConfigSchema.parse({ retention_days: -1 })).toThrow();
  });

  it("rejects retention_days greater than 365", () => {
    expect(() => loggingConfigSchema.parse({ retention_days: 366 })).toThrow();
  });

  it("rejects non-integer retention_days", () => {
    expect(() => loggingConfigSchema.parse({ retention_days: 7.5 })).toThrow();
  });
});

describe("gatewayConfigSchema logging field", () => {
  it("includes a default logging section when omitted", () => {
    const minimal = {
      stt: { provider: "local-stt" },
      tts: {},
      session: wsResilienceSession,
      access: minimalAccess,
      orchestrator: minimalOrchestrator,
    };
    const parsed = gatewayConfigSchema.parse(minimal);
    expect(parsed.logging).toEqual({ level: "info", retention_days: 7, level_overrides: {} });
  });
});

describe("gatewayConfigSchema webui field", () => {
  const minimalValidConfig = {
    stt: { provider: "local-stt" },
    tts: {},
    session: wsResilienceSession,
    access: minimalAccess,
    orchestrator: minimalOrchestrator,
  };

  it("applies webui playback defaults when section is omitted", () => {
    const result = gatewayConfigSchema.parse(minimalValidConfig);
    expect(result.webui.playback.min_eager_end_ms).toBe(3000);
    expect(result.webui.playback.preempt_fadeout_ms).toBe(30);
  });

  it("accepts custom webui playback values", () => {
    const result = gatewayConfigSchema.parse({
      ...minimalValidConfig,
      webui: { playback: { min_eager_end_ms: 5000, preempt_fadeout_ms: 50 } },
    });
    expect(result.webui.playback.min_eager_end_ms).toBe(5000);
    expect(result.webui.playback.preempt_fadeout_ms).toBe(50);
  });

  it("rejects preempt_fadeout_ms above 100", () => {
    const invalid = {
      ...minimalValidConfig,
      webui: { playback: { min_eager_end_ms: 3000, preempt_fadeout_ms: 101 } },
    };
    expect(gatewayConfigSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("gateway config — auth/apply/providers sections", () => {
  const minimal = {
    stt: { provider: "local-stt" },
    tts: {},
    session: wsResilienceSession,
    access: minimalAccess,
    orchestrator: minimalOrchestrator,
  };

  it("defaults auth.token_ttl_seconds to 7 days", () => {
    const cfg = gatewayConfigSchema.parse(minimal);
    expect(cfg.auth.token_ttl_seconds).toBe(604800);
  });

  it("defaults auth.ws_auth_timeout_ms to 5000", () => {
    const cfg = gatewayConfigSchema.parse(minimal);
    expect(cfg.auth.ws_auth_timeout_ms).toBe(5000);
  });

  it("defaults argon2 params to memory=65536 iterations=3 parallelism=1", () => {
    const cfg = gatewayConfigSchema.parse(minimal);
    expect(cfg.auth.argon2_memory_kb).toBe(65536);
    expect(cfg.auth.argon2_iterations).toBe(3);
    expect(cfg.auth.argon2_parallelism).toBe(1);
  });

  it("defaults apply.docker_restart_timeout_ms to 30000", () => {
    const cfg = gatewayConfigSchema.parse(minimal);
    expect(cfg.apply.docker_restart_timeout_ms).toBe(30000);
  });

  it("defaults apply.health_check_timeout_ms to 90000", () => {
    const cfg = gatewayConfigSchema.parse(minimal);
    expect(cfg.apply.health_check_timeout_ms).toBe(90000);
  });

  it("defaults apply.health_poll_interval_ms to 1000", () => {
    const cfg = gatewayConfigSchema.parse(minimal);
    expect(cfg.apply.health_poll_interval_ms).toBe(1000);
  });

  it("defaults providers.ollama_cloud_base_url to https://ollama.com/v1", () => {
    const cfg = gatewayConfigSchema.parse(minimal);
    expect(cfg.providers.ollama_cloud_base_url).toBe("https://ollama.com/v1");
  });

  it("defaults providers.fish_browse_enabled to true", () => {
    const cfg = gatewayConfigSchema.parse(minimal);
    expect(cfg.providers.fish_browse_enabled).toBe(true);
  });

  it("defaults providers.fish_cache_ttl_ms to 600000", () => {
    const cfg = gatewayConfigSchema.parse(minimal);
    expect(cfg.providers.fish_cache_ttl_ms).toBe(600000);
  });
});

describe("applyConfigSchema", () => {
  it("parses an empty object to the simplified default shape", () => {
    expect(applyConfigSchema.parse({})).toEqual({
      docker_restart_timeout_ms: 30000,
      health_check_timeout_ms: 90000,
      health_poll_interval_ms: 1000,
      profile_restart_timeout_ms: 90000,
      profile_restart_poll_interval_ms: 250,
    });
  });

  it("rejects health_poll_interval_ms below 100", () => {
    expect(applyConfigSchema.safeParse({ health_poll_interval_ms: 99 }).success).toBe(false);
  });

  it("rejects docker_restart_timeout_ms below 5000", () => {
    expect(applyConfigSchema.safeParse({ docker_restart_timeout_ms: 4999 }).success).toBe(false);
  });

  it("rejects health_check_timeout_ms below 1000", () => {
    expect(applyConfigSchema.safeParse({ health_check_timeout_ms: 999 }).success).toBe(false);
  });

  it("accepts custom values within bounds", () => {
    const cfg = applyConfigSchema.parse({
      docker_restart_timeout_ms: 45000,
      health_check_timeout_ms: 20000,
      health_poll_interval_ms: 500,
    });
    expect(cfg.docker_restart_timeout_ms).toBe(45000);
    expect(cfg.health_check_timeout_ms).toBe(20000);
    expect(cfg.health_poll_interval_ms).toBe(500);
  });
});

describe("gatewayConfigSchema downloads field", () => {
  const minimalWithDownloads = {
    stt: { provider: "local-stt" },
    tts: {},
    session: wsResilienceSession,
    access: minimalAccess,
    orchestrator: minimalOrchestrator,
    downloads: {
      artifacts_dir: "/app/releases",
      public_base_url: "https://sentient.dev32.io",
    },
  };

  it("parses the downloads section", () => {
    const result = gatewayConfigSchema.parse(minimalWithDownloads);
    expect(result.downloads).toBeDefined();
    expect(result.downloads.artifacts_dir).toBe("/app/releases");
    expect(result.downloads.public_base_url).toBe("https://sentient.dev32.io");
  });

  it("rejects an invalid public_base_url", () => {
    const invalid = {
      ...minimalWithDownloads,
      downloads: { artifacts_dir: "/app/releases", public_base_url: "not-a-url" },
    };
    expect(gatewayConfigSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("sessionConfigSchema", () => {
  const validSession = {
    ws_idle_timeout_ms: 255000,
    per_user_max_sessions: 40,
  };

  it("parses a valid session config", () => {
    const result = sessionConfigSchema.parse(validSession);
    expect(result.ws_idle_timeout_ms).toBe(255000);
  });

  it("rejects ws_idle_timeout_ms above Bun cap (255000 ms)", () => {
    expect(sessionConfigSchema.safeParse({ ...validSession, ws_idle_timeout_ms: 255001 }).success).toBe(false);
  });

  it("rejects ws_idle_timeout_ms below min (1000 ms)", () => {
    expect(sessionConfigSchema.safeParse({ ...validSession, ws_idle_timeout_ms: 500 }).success).toBe(false);
  });
});
