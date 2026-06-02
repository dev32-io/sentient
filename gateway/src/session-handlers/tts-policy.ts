import type { ClientType } from "@sentient/protocol";

/**
 * Reason a cycle's TTS path was skipped at entry, or `null` if it should
 * proceed. Returned to the caller for logging — keeps the decision in one
 * place so future client types and policy levers don't drift across sites.
 */
export type TtsSkipReason = "channel-text" | "tts-disabled";

export interface TtsPolicyInputs {
  readonly clientType: ClientType;
  readonly channel: "voice" | "text";
  readonly ttsEnabled: boolean;
}

/**
 * Decide whether to skip the TTS pipeline entry for a cycle.
 *
 * Policy by client type:
 *   - "webui"   → honour the user's per-session `channel` and `ttsEnabled`
 *                 preferences. Browser tabs have a UI to read text fallbacks.
 *   - "cube"    → headless device. Always speak unless the user explicitly
 *                 routed THIS session to text (channel != voice). The cube
 *                 has no UI to show text replies, so muting TTS would leave
 *                 the user with no response surface. `ttsEnabled` is
 *                 BYPASSED — user prefs are not mutated.
 *   - "mobile"  → v1 fallback: same policy as "webui". Mobile clients have a
 *                 UI to read text, so honour both `channel` and `ttsEnabled`.
 *                 A dedicated policy arm can be added in a later phase.
 *
 * Add new client types as new `case` arms; the exhaustive switch keeps
 * compile-time pressure on the call site when types are added.
 */
export function ttsSkipReason(inputs: TtsPolicyInputs): TtsSkipReason | null {
  switch (inputs.clientType) {
    case "webui":
    // mobile: v1 uses the same policy as webui — honour channel + ttsEnabled.
    case "mobile":
      if (inputs.channel !== "voice") return "channel-text";
      if (!inputs.ttsEnabled) return "tts-disabled";
      return null;
    case "cube":
      if (inputs.channel !== "voice") return "channel-text";
      return null;
  }
}
