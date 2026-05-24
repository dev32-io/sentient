import type { Signal } from "@preact/signals";
import type { ChatMessage } from "@sentient/web-sdk";
import { createChatMessage } from "../types.ts";

// ---------------------------------------------------------------------------
// VoiceMessageStore — local message accumulator for the voice hook.
//
// Manages the chat log: user messages (via transcript), assistant streams
// (delta → done), and barge-in finalization. Pushes snapshots into a Preact
// signal for reactive rendering.
// ---------------------------------------------------------------------------

export interface VoiceMessageStore {
  addUserMessage(text: string): void;
  startAssistantStream(): string;
  appendToStream(id: string, delta: string): void;
  finalizeStream(id: string): void;
}

export function createVoiceMessageStore(messagesSignal: Signal<readonly ChatMessage[]>): VoiceMessageStore {
  let localMessages: ChatMessage[] = [];

  function push(): void {
    messagesSignal.value = [...localMessages];
  }

  function addUserMessage(text: string): void {
    const last = localMessages[localMessages.length - 1];
    if (last && last.role === "user" && !last.isStreaming) {
      localMessages[localMessages.length - 1] = { ...last, text: `${last.text} ${text}` };
    } else {
      localMessages = [...localMessages, createChatMessage("user", text)];
    }
    push();
  }

  function startAssistantStream(): string {
    const msg = createChatMessage("assistant", "", { isStreaming: true });
    localMessages = [...localMessages, msg];
    push();
    return msg.id;
  }

  function appendToStream(id: string, delta: string): void {
    localMessages = localMessages.map((m) => (m.id === id ? { ...m, text: m.text + delta } : m));
    push();
  }

  function finalizeStream(id: string): void {
    localMessages = localMessages.map((m) => (m.id === id ? { ...m, isStreaming: false } : m));
    push();
  }

  return { addUserMessage, startAssistantStream, appendToStream, finalizeStream };
}
