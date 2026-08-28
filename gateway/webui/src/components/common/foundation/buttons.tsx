import type { ComponentChildren, JSX } from "preact";
import { classes } from "./utils.ts";

export interface ActionButtonProps {
  children: ComponentChildren;
  variant?: "default" | "primary" | "quiet" | "destructive" | undefined;
  type?: "button" | "submit" | "reset" | undefined;
  disabled?: boolean | undefined;
  loading?: boolean | undefined;
  className?: string | undefined;
  title?: string | undefined;
  role?: JSX.HTMLAttributes<HTMLButtonElement>["role"] | undefined;
  ariaLabel?: string | undefined;
  buttonRef?: { current: HTMLButtonElement | null } | undefined;
  expanded?: boolean | undefined;
  hasPopup?: "menu" | "dialog" | boolean | undefined;
  "aria-expanded"?: boolean | undefined;
  "aria-controls"?: string | undefined;
  "aria-pressed"?: boolean | undefined;
  onClick?: (event: MouseEvent) => void | undefined;
}

export function ActionButton({ children, variant = "default", type = "button", disabled, loading, className, title, role, ariaLabel, buttonRef, expanded, hasPopup, "aria-expanded": ariaExpanded, "aria-controls": ariaControls, "aria-pressed": ariaPressed, onClick }: ActionButtonProps): JSX.Element {
  return (
    <button
      {...(buttonRef ? { ref: buttonRef } : {})}
      type={type}
      class={classes("snt-button", variant !== "default" && `snt-button--${variant}`, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      title={title}
      role={role}
      aria-label={ariaLabel}
      aria-expanded={ariaExpanded ?? expanded}
      aria-controls={ariaControls}
      aria-pressed={ariaPressed}
      aria-haspopup={hasPopup}
      onClick={onClick}
    >
      {loading && <span class="snt-button__spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

export interface FoundationIconButtonProps extends Omit<ActionButtonProps, "children" | "variant" | "loading" | "ariaLabel"> {
  label: string;
  children: ComponentChildren;
  variant?: "default" | "quiet" | "destructive" | undefined;
  pressed?: boolean | undefined;
}

export function FoundationIconButton({ label, children, variant = "default", pressed, className, buttonRef, expanded, hasPopup, ...props }: FoundationIconButtonProps): JSX.Element {
  return (
    <button
      {...props}
      {...(buttonRef ? { ref: buttonRef } : {})}
      type="button"
      class={classes("snt-icon-button", variant !== "default" && `snt-button--${variant}`, className)}
      aria-label={label}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-haspopup={hasPopup}
      title={props.title ?? label}
    >
      {children}
    </button>
  );
}
