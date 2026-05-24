import type { Adapter } from "../adapters/adapter-types.js";
import type { STTAdapterConfig, STTAdapterFactory } from "../adapters/stt/stt-adapter-types.js";
import { createUserAudioInputAdapter } from "../adapters/user-audio-input-adapter.js";
import { createUserTextInputAdapter } from "../adapters/user-text-input-adapter.js";
import type { StartupConfig } from "../config/startup-config.js";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "bootstrap", "adapter-registry"]);

export interface AdapterDeps {
  readonly sttAdapterFactory?: STTAdapterFactory;
  readonly sttAdapterConfig?: STTAdapterConfig;
}

export interface AdapterEntry {
  readonly requiredCapability: string;
  readonly create: (deps: AdapterDeps) => Adapter | null;
}

export function getAvailableAdapters(_cfg: StartupConfig): AdapterEntry[] {
  log.debug("adapter-registry-built");

  return [
    {
      requiredCapability: "audio.input",
      create(deps: AdapterDeps): Adapter | null {
        if (!deps.sttAdapterFactory || !deps.sttAdapterConfig) {
          log.warn("audio-input-adapter-skipped", { reason: "no STT service available" });
          return null;
        }
        return createUserAudioInputAdapter(deps.sttAdapterFactory, deps.sttAdapterConfig);
      },
    },
    {
      requiredCapability: "text.input",
      create(_deps: AdapterDeps): Adapter {
        return createUserTextInputAdapter();
      },
    },
  ];
}
