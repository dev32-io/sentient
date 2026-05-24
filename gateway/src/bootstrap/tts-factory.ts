import type { SecretsStore } from "../admin/secrets-store-schema.ts";
import type { StartupConfig } from "../config/startup-config.ts";
import { getLog } from "../logging/logger.ts";
import { createFishAudioProvider } from "../providers/tts/fish-audio-provider.ts";
import type { TTSConfig, TTSProvider, TTSProviderFactory } from "../providers/tts/tts-types.ts";

const log = getLog(["sentient", "bootstrap", "tts"]);

export interface TtsService {
  /** Build a fresh, isolated TTSProvider for a single synthesis session.
   *  Resolves the Fish Audio key lazily on each call from the wizard's
   *  SecretsStore — so a key entered AFTER gateway boot (most prod
   *  installs follow this path) is picked up by the next cycle without a
   *  restart. The factory returns null when the key is still missing;
   *  callers fall back to text-only. */
  readonly createTTSProvider: (overrides?: { voiceId?: string }) => TTSProvider | null;
}

export interface CreateTtsServiceDeps {
  cfg: StartupConfig;
  /** Wizard secrets — Fish Audio key lives here once the operator has
   *  walked the Voice step. May be null on minimal deploys without
   *  hermes config; falls back to FISH_AUDIO_API_KEY env in that case. */
  secretsStore: Pick<SecretsStore, "getFishAudioKeySync"> | null;
}

function resolveFishKey(deps: CreateTtsServiceDeps): string | null {
  const fromSecrets = deps.secretsStore?.getFishAudioKeySync();
  if (fromSecrets) return fromSecrets;
  const fromEnv = process.env.FISH_AUDIO_API_KEY;
  return fromEnv && fromEnv.length > 0 ? fromEnv : null;
}

export function createTtsService(deps: CreateTtsServiceDeps): TtsService {
  const bootKey = resolveFishKey(deps);
  log.info("service-wired", {
    haveKeyAtBoot: bootKey !== null,
    voiceIdDefault: deps.cfg.tts.voice_id,
    modelId: deps.cfg.tts.model_id,
  });

  const buildConfig = (apiKey: string, overrides?: { voiceId?: string }): TTSConfig => ({
    apiKey,
    voiceId: overrides?.voiceId ?? deps.cfg.tts.voice_id,
    modelId: deps.cfg.tts.model_id,
    format: deps.cfg.tts.format,
    bitrate: deps.cfg.tts.bitrate,
    sampleRate: deps.cfg.tts.sample_rate,
    latency: deps.cfg.tts.latency,
    chunkLengthMs: deps.cfg.tts.chunk_length_ms,
    connectTimeoutMs: deps.cfg.tts.connect_timeout_ms,
  });

  const createTTSProvider = (overrides?: { voiceId?: string }): TTSProvider | null => {
    const apiKey = resolveFishKey(deps);
    if (!apiKey) {
      log.warn("synth-skipped", { reason: "fish-key-not-set-in-secrets-or-env" });
      return null;
    }
    return createFishAudioProvider(buildConfig(apiKey, overrides));
  };

  return { createTTSProvider };
}

/** Wrap the lazy `null`-returning factory into the strict TTSProviderFactory
 *  shape (non-null) used by callers that cannot tolerate a missing provider.
 *  The wrapper throws if the key still isn't configured at synth time —
 *  surfaces in a real cycle with a clear pointer to the wizard. */
export function asStrictFactory(svc: TtsService, getVoiceId: () => string | null): TTSProviderFactory {
  return () => {
    const voiceId = getVoiceId();
    const provider = voiceId ? svc.createTTSProvider({ voiceId }) : svc.createTTSProvider();
    if (!provider) {
      throw new Error("Fish Audio key not configured. Open the wizard's Voice step or set FISH_AUDIO_API_KEY.");
    }
    return provider;
  };
}
