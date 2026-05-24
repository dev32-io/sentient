import { getLog } from "../../logging/logger.ts";
import type { SttPauseRenderLanguage } from "./stt-adapter-types.ts";

const log = getLog(["sentient", "stt", "pause-renderer"]);

const MIN_DISPLAY_MS = 100;
const WHOLE_SECONDS_THRESHOLD_MS = 10_000;

function formatDuration(ms: number, language: SttPauseRenderLanguage): string {
  const clamped = Math.max(ms, MIN_DISPLAY_MS);
  const seconds =
    clamped >= WHOLE_SECONDS_THRESHOLD_MS ? `${Math.round(clamped / 1000)}s` : `${(clamped / 1000).toFixed(1)}s`;
  if (language === "zh") {
    return `[停顿 ${seconds.replace("s", "秒")}]`;
  }
  return `[paused ${seconds}]`;
}

export function renderPauses(text: string, pausesMs: readonly number[], language: SttPauseRenderLanguage): string {
  const placeholderCount = (text.match(/\[pause\.\d+\]/g) ?? []).length;
  if (placeholderCount !== pausesMs.length) {
    log.warn("pause-count-mismatch", {
      placeholders: placeholderCount,
      pauses: pausesMs.length,
    });
  }

  let result = text;
  const limit = Math.min(placeholderCount, pausesMs.length);
  for (let i = 0; i < limit; i++) {
    const ms = pausesMs[i] ?? 0;
    result = result.replace(`[pause.${i}]`, formatDuration(ms, language));
  }
  return result;
}
