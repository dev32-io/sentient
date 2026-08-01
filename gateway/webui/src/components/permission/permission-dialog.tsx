import type { PermissionRequestItem } from "@sentient/web-sdk";
import type { JSX } from "preact";
import { Dialog } from "../common/dialog.tsx";

export interface PermissionDialogProps {
  request: PermissionRequestItem;
  onRespond(approved: boolean): void;
}

function formatArgValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Blocking L3 `confirm` prompt (spec §7.1). Renders the tool name and the
 * ACTUAL argument values the PDP is mediating — the user approves what will
 * really happen, not a bare tool name.
 *
 * Values are rendered IN FULL, one per row. They used to be folded onto a
 * single line and cut at 80 characters, which was fine for `ha_call_service`
 * and wrong for the one tool where the argument IS the authority: approving a
 * `delegateTask` means approving its `taskPrompt`, and a background agent then
 * acts on that text unsupervised with its own tool surface. Eliding it hides
 * exactly the tail that matters. Overflow is the panel's job (it scrolls) —
 * never a character budget here.
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
      {Object.entries(request.args).length === 0 ? (
        <p class="permission-dialog__args permission-dialog__args--empty">(no arguments)</p>
      ) : (
        <dl class="permission-dialog__args">
          {Object.entries(request.args).map(([key, value]) => (
            <div class="permission-dialog__arg" key={key}>
              <dt class="permission-dialog__arg-key">{key}</dt>
              <dd class="permission-dialog__arg-value">{formatArgValue(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </Dialog>
  );
}
