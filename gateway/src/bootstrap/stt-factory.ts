import { createLocalSttAdapter } from "../adapters/stt/local-stt-adapter.ts";
import type { STTAdapterConfig, STTAdapterFactory } from "../adapters/stt/stt-adapter-types.ts";
import type { StartupConfig } from "../config/startup-config.ts";
import { getLog } from "../logging/logger.ts";

const log = getLog(["sentient", "bootstrap", "stt"]);

export interface SttService {
  readonly adapterFactory: STTAdapterFactory;
  readonly adapterConfig: STTAdapterConfig;
}

export function createSttService(cfg: StartupConfig): SttService {
  if (!cfg.stt) {
    throw new Error("createSttService called without stt config");
  }
  // The gateway's `stt.language` config value seeds TWO independent
  // knobs: (1) the initial STT decode language sent to local-stt, and
  // (2) the fallback pause-render language used when decode is `auto`.
  // PreferenceManager can later flip (1) per session; (2) stays as the
  // house default until someone plumbs preferences deeper.
  //
  // audioFormat defaults to "opus" — webui mic now encodes int16 PCM
  // captured via AudioWorklet into raw opus packets (WebCodecs
  // AudioEncoder, Phase 5.5 W1–W2) before shipping them on the binary WS
  // channel. The STT server-side decoder reads `?audioFormat=` from the
  // connect URL and decodes accordingly. Future per-session sources
  // (Phase 6 cube-sdk over cube-transport) will negotiate their own
  // format and override this default via the per-session adapter
  // factory wiring. See STT CONTRACT.md §1.2.
  const adapterConfig: STTAdapterConfig = {
    url: cfg.stt.url,
    language: cfg.language,
    pauseRenderLanguage: cfg.language,
    inputSampleRate: cfg.stt.input_sample_rate,
    ttsEchoCooldownMs: cfg.stt.tts_echo_cooldown_ms,
    connectTimeoutMs: cfg.stt.connect_timeout_ms,
    audioFormat: "opus",
  };
  log.info("service-enabled", {
    url: adapterConfig.url,
    language: adapterConfig.language,
    pauseRenderLanguage: adapterConfig.pauseRenderLanguage,
    audioFormat: adapterConfig.audioFormat,
  });
  return { adapterFactory: createLocalSttAdapter, adapterConfig };
}
