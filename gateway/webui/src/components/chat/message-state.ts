import type { ChatMessage } from "../../types.ts";
import type { SentientIdentityState } from "../common/sentient-identity.tsx";

export type MessageVisualState = "thinking" | "responding" | "completed" | "interrupted";

export function messageStateFor(message: ChatMessage, identityState: SentientIdentityState): MessageVisualState {
  if (message.cutoff) return "interrupted";
  if (identityState === "thinking") return "thinking";
  if (identityState === "responding") return "responding";
  return "completed";
}
