import type { ConversationMirror } from "../cerebrum/conversation-mirror.js";
import type { ShortTermContext } from "../cerebrum/short-term-context-types.js";

export interface Adapter {
  readonly id: string;
  readonly eventKinds: readonly string[];
  start(ctx: AdapterContext): Promise<void>;
  stop(reason: string): Promise<void>;
}

export interface AdapterContext {
  readonly shortTermContext: ShortTermContext;
  readonly conversationHistory: ConversationMirror;
  readonly abortSignal: AbortSignal;
}
