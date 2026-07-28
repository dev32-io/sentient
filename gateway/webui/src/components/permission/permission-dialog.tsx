import type { PermissionRequestItem } from "@sentient/web-sdk";
import type { JSX } from "preact";
import { Dialog } from "../common/dialog.tsx";

export interface PermissionDialogProps {
  request: PermissionRequestItem;
  onRespond(approved: boolean): void;
}

/** Longest argument value rendered inline before elision. */
const ARG_VALUE_MAX = 80;

function formatArgValue(value: unknown): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return raw.length > ARG_VALUE_MAX ? `${raw.slice(0, ARG_VALUE_MAX)}…` : raw;
}

function summarizeArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "(no arguments)";
  return entries.map(([key, value]) => `${key}: ${formatArgValue(value)}`).join(", ");
}

/**
 * Blocking L3 `confirm` prompt (spec §7.1). Renders the tool name and the
 * ACTUAL argument values the PDP is mediating — the user approves what will
 * really happen, not a bare tool name.
 */
export function PermissionDialog({ request, onRespond }: PermissionDialogProps): JSX.Element {
  // ESC / backdrop-click / the header close button all route through Dialog's
  // onClose. Per §7.1 the prompt "blocks the turn until answered" — Deny IS an
  // answer, so dismiss routes to Deny instead of adding a suppression mode to
  // the shared Dialog primitive. The dialog never closes without a wire
  // response, and deny-on-ambiguity matches the PDP's fail-closed posture.
  const deny = (): void => onRespond(false);
  return (
    <Dialog
      title="Permission requested"
      description={request.description}
      onClose={deny}
      footer={
        <>
          <button type="button" class="app-dialog__btn app-dialog__btn--ghost" onClick={deny}>
            Deny
          </button>
          <button type="button" class="app-dialog__btn app-dialog__btn--danger" onClick={() => onRespond(true)}>
            Allow
          </button>
        </>
      }
    >
      <div class="permission-dialog__tool">
        <span class="permission-dialog__tool-label">Tool</span>
        <span class="permission-dialog__tool-name">{request.toolName}</span>
      </div>
      <div class="permission-dialog__args">{summarizeArgs(request.args)}</div>
    </Dialog>
  );
}
