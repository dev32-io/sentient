import { getLog } from "../../logging/logger.ts";
import type { TextStage } from "./stage-types.ts";
// FLUSH_SIGNAL is opaque to this stage — gating logic treats it like any
// other chunk: dropped while barged-in, forwarded otherwise.

const log = getLog(["sentient", "tts", "barge-in-gate"]);

export interface BargeInGateControls {
  bargedIn(): boolean;
}

export function createBargeInGate(controls: BargeInGateControls): TextStage {
  return async function* gate(input, signal) {
    let dropped = 0;
    let passed = 0;
    let wasBargedIn = false;

    log.debug("enter", {});
    try {
      for await (const chunk of input) {
        if (signal.aborted) return;
        const b = controls.bargedIn();
        if (b !== wasBargedIn) {
          log.debug("state.transition", { bargedIn: b });
          wasBargedIn = b;
        }
        if (b) {
          dropped++;
          continue;
        }
        passed++;
        yield chunk;
      }
    } finally {
      log.debug("exit", { dropped, passed });
    }
  };
}
