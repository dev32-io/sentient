import type { StartupConfig } from "../config/startup-config.ts";
import { getLog } from "../logging/logger.ts";
import { type LocalTtsProviderConfig, createLocalTtsProvider } from "../providers/tts/local-tts-provider.ts";
import type { TTSProvider, TTSProviderFactory } from "../providers/tts/tts-types.ts";

const log = getLog(["sentient", "bootstrap", "tts"]);

export interface TtsService {
  /** Build a fresh, isolated TTSProvider for a single synthesis session.
   *  local-tts needs no API key, so a provider is ALWAYS built — there is no
   *  "disabled" state at this layer. If the local-tts service is down or
   *  unreachable, that surfaces at warmup()/ready() time inside the
   *  provider; the streaming-tts-synthesizer already degrades gracefully
   *  (falls back to text-only) on that failure. */
  readonly createTTSProvider: TTSProviderFactory;
}

export interface CreateTtsServiceDeps {
  cfg: StartupConfig;
}

function buildLocalTtsConfig(deps: CreateTtsServiceDeps, overrides?: { voiceId?: string }): LocalTtsProviderConfig {
  return {
    url: deps.cfg.tts.url,
    format: deps.cfg.tts.format,
    sampleRate: deps.cfg.tts.sample_rate,
    defaultVoice: overrides?.voiceId ?? deps.cfg.tts.voice_id,
    connectTimeoutMs: deps.cfg.tts.connect_timeout_ms,
  };
}

export function createTtsService(deps: CreateTtsServiceDeps): TtsService {
  log.info("service-wired", {
    url: deps.cfg.tts.url,
    voiceIdDefault: deps.cfg.tts.voice_id,
    format: deps.cfg.tts.format,
  });

  const createTTSProvider = (overrides?: { voiceId?: string }): TTSProvider =>
    createLocalTtsProvider(buildLocalTtsConfig(deps, overrides));

  return { createTTSProvider };
}

/** Adapts `TtsService.createTTSProvider` (which already returns the strict
 *  non-null `TTSProviderFactory` shape) to resolve the per-session voiceId
 *  from `getVoiceId` before building. Kept as its own function — callers
 *  (phase-services.ts) close over a per-session `getVoiceId` at session-setup
 *  time, separate from `TtsService` construction at boot time. */
export function asStrictFactory(svc: TtsService, getVoiceId: () => string | null): TTSProviderFactory {
  return () => {
    const voiceId = getVoiceId();
    return voiceId ? svc.createTTSProvider({ voiceId }) : svc.createTTSProvider();
  };
}
