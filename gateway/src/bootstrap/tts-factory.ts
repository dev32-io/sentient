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

/**
 * Adapts `TtsService.createTTSProvider` to resolve the session's voiceId from
 * `getVoiceId` before building. Kept as its own function — callers
 * (phase-services.ts) close over a per-session `getVoiceId` at session-setup
 * time, separate from `TtsService` construction at boot time.
 *
 * ASYNC because the voice pack is read from the user's profile at the moment
 * the upstream session opens (user-audio-policy.ts), not cached at session
 * setup. Opening the session is already an async step
 * (`TTSSessionFactory.createSession`), so awaiting the profile read here adds
 * a step to a path that was already awaited — and removes the window in which
 * a session opened with `voice=default` because a hydration promise had not
 * settled yet.
 */
export function asStrictFactory(svc: TtsService, getVoiceId: () => Promise<string | null>): TTSSessionOpener {
  return async () => {
    const voiceId = await getVoiceId();
    return voiceId ? svc.createTTSProvider({ voiceId }) : svc.createTTSProvider();
  };
}

/** A `TTSProviderFactory` whose voice resolution is awaited — what
 *  `asStrictFactory` returns, and what `TTSSessionFactory.createSession`
 *  consumes. */
export type TTSSessionOpener = (...args: Parameters<TTSProviderFactory>) => Promise<TTSProvider>;
