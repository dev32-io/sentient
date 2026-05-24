import { getLog } from "../logging/logger.js";
import type { Adapter, AdapterContext } from "./adapter-types.js";

const log = getLog(["sentient", "adapters", "user-text-input"]);

const ADAPTER_ID = "user-text-input-v1";
const MAX_LOG_TEXT_LEN = 80;

export interface UserTextInputAdapter extends Adapter {
  handleTextInput(text: string): void;
}

export function createUserTextInputAdapter(): UserTextInputAdapter {
  let ctx: AdapterContext | null = null;

  return {
    id: ADAPTER_ID,
    eventKinds: [],

    async start(adapterCtx: AdapterContext): Promise<void> {
      ctx = adapterCtx;
      log.info("adapter-start", { id: ADAPTER_ID });
    },

    async stop(_reason: string): Promise<void> {
      log.info("adapter-stop", { id: ADAPTER_ID });
      ctx = null;
    },

    handleTextInput(text: string): void {
      if (!ctx) return;
      const truncated = text.length > MAX_LOG_TEXT_LEN ? `${text.slice(0, MAX_LOG_TEXT_LEN)}…` : text;
      log.debug("text-input", { text: truncated });
      ctx.conversationHistory.append({ kind: "user", ts: Date.now(), channel: "text", content: text });
    },
  };
}
