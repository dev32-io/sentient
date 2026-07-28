import type { PermissionOutcome } from "@sentient/protocol";
import type { PermissionRequestItem } from "@sentient/web-sdk";

export type PermissionPromptEvent =
  | { readonly type: "request"; readonly request: PermissionRequestItem }
  | { readonly type: "resolved"; readonly requestId: string; readonly outcome: PermissionOutcome };

/**
 * Pure reducer for the permission-prompt dialog's visibility.
 *
 * Fail-closed invariant (spec §7.1 / §5.3): a "resolved" event only ever
 * clears the CURRENTLY shown request (matched by requestId) — a resolved
 * frame for a different or already-cleared requestId is ignored rather
 * than treated as an implicit dismissal. This is what lets the server
 * close the dialog on its own (2-minute timeout auto-deny) through the
 * exact same path a user's Allow/Deny click uses, with no separate
 * "server dismiss" branch to keep in sync.
 *
 * Pure by design (same shape as `cycle-helpers.ts` / `voice-status.ts`): it
 * takes no logger, because the transition it decides is logged at its single
 * call site in `use-voice-client.ts`, where the wire frame is in scope.
 */
export function reducePermissionPrompt(
  current: PermissionRequestItem | null,
  event: PermissionPromptEvent,
): PermissionRequestItem | null {
  if (event.type === "request") return event.request;
  if (!current || current.requestId !== event.requestId) return current;
  return null;
}
