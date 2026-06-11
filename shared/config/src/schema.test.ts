import { describe, expect, it } from "vitest";
import {
  applyConfigSchema,
  gatewayConfigSchema,
  loggingConfigSchema,
  sessionConfigSchema,
  sessionsConfigSchema,
  sttConfigSchema,
} from "./schema.ts";

// Shared WS-resilience session fields required in every gateway config
// (no code defaults — YAML is the source of truth per config rules).
const wsResilienceSession = {
  ws_idle_timeout_ms: 255000,
  retention_ttl_ms: 1800000,
  replay_buffer_max_bytes: 16777216,
};

describe("gatewayConfigSchema", () => {
  const minimalValidConfig = {
    stt: { provider: "local-stt" },
    llm: {},
    tts: { provider: "fish-audio" },
    session: wsResilienceSession,
  };

  it("accepts a minimal config and applies defaults", () => {
    const result = gatewayConfigSchema.parse(minimalValidConfig);

    expect(result.port).toBe(8888);
    expect(result.host).toBe("0.0.0.0");
    expect(result.max_sessions).toBe(100);
    expect(result.auth_timeout_ms).toBe(5000);
    expect(result.session_persist_ms).toBe(120000);
  });

  it("applies session defaults", () => {
    const result = gatewayConfigSchema.parse(minimalValidConfig);
    expect(result.session.inactivity_timeout_ms).toBe(300_000);
    expect(result.session.inactivity_check_interval_ms).toBe(30_000);
    expect(result.session.tts_drain_grace_ms).toBe(2000);
    expect(result.session.barge_in.no_interrupt_ms).toBe(500);
    expect(result.session.barge_in.min_speech_duration_ms).toBe(50);
  });

  it("accepts custom tts_drain_grace_ms", () => {
    const result = gatewayConfigSchema.parse({
      ...minimalValidConfig,
      session: { ...wsResilienceSession, tts_drain_grace_ms: 500 },
    });
    expect(result.session.tts_drain_grace_ms).toBe(500);
  });

  it("rejects tts_drain_grace_ms above max", () => {
    const invalid = { ...minimalValidConfig, session: { ...wsResilienceSession, tts_drain_grace_ms: 6000 } };
    expect(gatewayConfigSchema.safeParse(invalid).success).toBe(false);
  });

  it("applies LLM defaults", () => {
    const result = gatewayConfigSchema.parse(minimalValidConfig);
    expect(result.llm.provider).toBe("openrouter");
    expect(result.llm.chat_model).toBe("google/gemini-2.5-flash");
    expect(result.llm.max_tokens).toBe(1024);
    expect(result.llm.timeout_ms).toBe(30000);
  });

  it("applies TTS defaults including utterance_aggregator and emotion_tags", () => {
    const result = gatewayConfigSchema.parse(minimalValidConfig);
    expect(result.tts.voice_id).toBe("default");
    expect(result.tts.model_id).toBe("speech-1.6");
    expect(result.tts.format).toBe("pcm");
    expect(result.tts.bitrate).toBe(48000);
    expect(result.tts.sample_rate).toBe(44100);
    expect(result.tts.latency).toBe("balanced");
    expect(result.tts.chunk_length_ms).toBe(200);
    expect(result.tts.connect_timeout_ms).toBe(10000);
    expect(result.tts.stop_timeout_ms).toBe(10000);
    expect(result.tts.idle_timeout_ms).toBe(10000);
    expect(result.tts.utterance_aggregator.max_block_chars).toBe(600);
    expect(result.tts.emotion_tags.enabled).toBe(true);
    expect(result.tts.emotion_tags.model).toBe("google/gemini-2.5-flash");
    expect(result.tts.emotion_tags.timeout_ms).toBe(2000);
  });

  it("honors overrides from YAML", () => {
    const result = gatewayConfigSchema.parse({
      ...minimalValidConfig,
      stt: { provider: "local-stt", language: "zh" },
      tts: { provider: "fish-audio", voice_id: "custom", format: "pcm", sample_rate: 44100 },
      session: { ...wsResilienceSession, barge_in: { no_interrupt_ms: 300 } },
    });
    expect(result.stt.language).toBe("zh");
    expect(result.tts.voice_id).toBe("custom");
    expect(result.tts.format).toBe("pcm");
    expect(result.tts.sample_rate).toBe(44100);
    expect(result.session.barge_in.no_interrupt_ms).toBe(300);
  });

  it("rejects port out of range", () => {
    const invalid = { ...minimalValidConfig, port: 99999 };
    expect(gatewayConfigSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects invalid TTS format", () => {
    const invalid = { ...minimalValidConfig, tts: { provider: "fish-audio", format: "wav" } };
    expect(gatewayConfigSchema.safeParse(invalid).success).toBe(false);
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
    expect(result.language).toBe("en");
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
        level_overrides: { "sentient:cerebrum:hermes-event-translator": "debug" },
      }),
    ).toEqual({
      level: "info",
      retention_days: 7,
      level_overrides: { "sentient:cerebrum:hermes-event-translator": "debug" },
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

describe("sessionsConfigSchema rate-limit fields", () => {
  it("applies the default for the session.new min-interval", () => {
    const result = sessionsConfigSchema.parse({});
    expect(result.min_new_interval_ms).toBe(500);
  });

  it("accepts a custom min-interval within bounds", () => {
    const result = sessionsConfigSchema.parse({ min_new_interval_ms: 1000 });
    expect(result.min_new_interval_ms).toBe(1000);
  });

  it("rejects min_new_interval_ms below 0", () => {
    expect(sessionsConfigSchema.safeParse({ min_new_interval_ms: -1 }).success).toBe(false);
  });

  it("rejects min_new_interval_ms above 60000", () => {
    expect(sessionsConfigSchema.safeParse({ min_new_interval_ms: 60001 }).success).toBe(false);
  });
});

describe("gatewayConfigSchema logging field", () => {
  it("includes a default logging section when omitted", () => {
    const minimal = {
      stt: { provider: "local-stt" },
      llm: { provider: "openrouter" },
      tts: { provider: "fish-audio" },
      session: wsResilienceSession,
    };
    const parsed = gatewayConfigSchema.parse(minimal);
    expect(parsed.logging).toEqual({ level: "info", retention_days: 7, level_overrides: {} });
  });
});

describe("gatewayConfigSchema webui field", () => {
  const minimalValidConfig = {
    stt: { provider: "local-stt" },
    llm: {},
    tts: { provider: "fish-audio" },
    session: wsResilienceSession,
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
    llm: { provider: "openrouter" },
    tts: { provider: "fish-audio" },
    session: wsResilienceSession,
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

  it("defaults providers.fish_cache_ttl_ms to 600000 (10min)", () => {
    const cfg = gatewayConfigSchema.parse(minimal);
    expect(cfg.providers.fish_cache_ttl_ms).toBe(600000);
  });
});

describe("applyConfigSchema", () => {
  it("parses an empty object to the simplified default shape", () => {
    expect(applyConfigSchema.parse({})).toEqual({
      dispatch_ping_timeout_ms: 8000,
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

// ---------------------------------------------------------------------------
// sessionConfigSchema — WS-resilience knobs (Slice 3, Task 3.1)
// ---------------------------------------------------------------------------

describe("sessionConfigSchema — WS-resilience fields", () => {
  const validSession = {
    ws_idle_timeout_ms: 255000,
    retention_ttl_ms: 1800000,
    replay_buffer_max_bytes: 16777216,
  };

  it("parses a valid session config with WS-resilience fields", () => {
    const result = sessionConfigSchema.parse(validSession);
    expect(result.ws_idle_timeout_ms).toBe(255000);
    expect(result.retention_ttl_ms).toBe(1800000);
    expect(result.replay_buffer_max_bytes).toBe(16777216);
  });

  it("fails loudly when retention_ttl_ms is missing", () => {
    const { retention_ttl_ms: _omitted, ...withoutRetention } = validSession;
    expect(sessionConfigSchema.safeParse(withoutRetention).success).toBe(false);
  });

  it("rejects ws_idle_timeout_ms above Bun cap (255000 ms)", () => {
    expect(sessionConfigSchema.safeParse({ ...validSession, ws_idle_timeout_ms: 255001 }).success).toBe(false);
  });

  it("rejects retention_ttl_ms below minimum (60000 ms)", () => {
    expect(sessionConfigSchema.safeParse({ ...validSession, retention_ttl_ms: 59999 }).success).toBe(false);
  });

  it("rejects ws_idle_timeout_ms below min (1000 ms)", () => {
    expect(sessionConfigSchema.safeParse({ ...validSession, ws_idle_timeout_ms: 500 }).success).toBe(false);
  });

  it("rejects replay_buffer_max_bytes above max (268435456 bytes)", () => {
    expect(sessionConfigSchema.safeParse({ ...validSession, replay_buffer_max_bytes: 300000000 }).success).toBe(false);
  });

  it("rejects replay_buffer_max_bytes below min (65536 bytes)", () => {
    expect(sessionConfigSchema.safeParse({ ...validSession, replay_buffer_max_bytes: 1024 }).success).toBe(false);
  });
});
