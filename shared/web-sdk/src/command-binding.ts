// This tab's ATTACHMENT to a session (gateway spec §3.7) — the `{sessionId,
// generation}` pair the gateway sends on `session.attached`, and the stamp every
// outbound command carries.
//
// WHY THE CLIENT HAS TO CARRY IT. `text.input`, `interrupt`, the permission
// answer and the audio control frames used to name nothing: the gateway applied
// each to whatever session the socket was on when the bytes landed. With
// session switching that races — a message typed into one conversation and a
// `conversation.activate` onto another are two frames in flight, and the loser
// lands in the wrong place. The stamp is what lets the gateway tell them apart
// and refuse the stale one rather than apply it.
//
// STAMPED AT ONE SEAM, not at each call site. `SentientSDK.sendRaw` is the only
// way a frame leaves this SDK, so stamping there is the client mirror of the
// gateway's own single choke point — a connector cannot forget.
//
// FORGETTING IS AS LOAD-BEARING AS REMEMBERING. An attachment does not survive
// a socket, and a DRAFT has none at all. A stamp that outlived either would be
// refused as stale on the very frame that mints the next session, which is the
// one frame that must always get through.

import { sdkLog } from "./debug.ts";

/** Frames that carry the §3.7 binding. Exactly the gateway's own set — see
 *  `command-mediator.ts`. `session.configure`, `session.new` and
 *  `conversation.activate` are absent on purpose: they are how a connection
 *  LEAVES a session, so binding them to the one being left would make switching
 *  impossible. `ping`, `auth` and `user.preferences.patch` act on no session. */
const COMMAND_TYPES: ReadonlySet<string> = new Set([
  "text.input",
  "interrupt",
  "permission.response",
  "audio.start",
  "audio.end",
]);

export interface CommandBinding {
  readonly sessionId: string;
  readonly generation: number;
}

export interface CommandBindingState {
  /** Record the pair the gateway just announced. */
  attached(binding: CommandBinding): void;
  /** Forget it — a draft, a new socket, or a disconnect. */
  clear(reason: string): void;
  /** [message] with the binding merged in, when it is a command AND this tab
   *  holds one. Anything else passes through untouched, which is what keeps a
   *  draft's first `text.input` sendable. */
  stamp(message: unknown): unknown;
}

export function createCommandBindingState(): CommandBindingState {
  let binding: CommandBinding | null = null;

  return {
    attached(next) {
      binding = next;
      sdkLog.debug("command-binding.attached", { sessionId: next.sessionId, generation: next.generation });
    },

    clear(reason) {
      if (binding === null) return;
      sdkLog.debug("command-binding.cleared", { sessionId: binding.sessionId, reason });
      binding = null;
    },

    stamp(message) {
      if (binding === null) return message;
      const type = (message as { type?: unknown }).type;
      if (typeof type !== "string" || !COMMAND_TYPES.has(type)) return message;
      return { ...(message as object), sessionId: binding.sessionId, attachmentGeneration: binding.generation };
    },
  };
}
