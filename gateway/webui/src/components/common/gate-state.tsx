import type { JSX } from "preact";
import { ActionButton, Plate, Surface } from "./foundation.tsx";
import { AsyncState, Notice } from "./composites.tsx";

export interface GateStateProps {
  title: string;
  message?: string | undefined;
  state?: "loading" | "error" | "empty" | undefined;
  actionLabel?: string | undefined;
  onAction?: (() => void) | undefined;
}

/** Shared full-viewport composition for install and authentication gates. */
export function GateState({ title, message, state = "empty", actionLabel, onAction }: GateStateProps): JSX.Element {
  return (
    <Surface className="auth-gate">
      <Plate className="auth-gate__card">
        <AsyncState
          state={state}
          title={title}
          message={message}
          action={actionLabel && onAction ? <ActionButton variant="primary" onClick={onAction}>{actionLabel}</ActionButton> : undefined}
        />
      </Plate>
    </Surface>
  );
}

export function GateError({ children }: { children: string }): JSX.Element {
  return <Notice tone="error">{children}</Notice>;
}
