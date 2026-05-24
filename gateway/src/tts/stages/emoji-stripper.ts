import emojiRegex from "emoji-regex";
import { getLog } from "../../logging/logger.ts";
import { FLUSH_SIGNAL, type TextStage } from "./stage-types.ts";

const log = getLog(["sentient", "tts", "emoji-stripper"]);

export function createEmojiStripper(): TextStage {
  return async function* stripper(input, signal) {
    log.debug("enter", {});
    let strippedCount = 0;
    try {
      for await (const chunk of input) {
        if (signal.aborted) return;
        if (chunk === FLUSH_SIGNAL) {
          // Stateless stage — nothing to drain, just forward the signal.
          yield FLUSH_SIGNAL;
          continue;
        }
        const re = emojiRegex();
        const cleaned = chunk.replace(re, () => {
          strippedCount++;
          return "";
        });
        if (cleaned.length > 0) yield cleaned;
      }
    } finally {
      log.debug("exit", { strippedCount });
    }
  };
}
