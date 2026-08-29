import type { ComponentChildren, JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { ActionButton, Field, type FieldProps, Plate } from "./foundation.tsx";
import { BackspaceIcon } from "./icons/backspace.tsx";
import { SearchIcon } from "./icons/search.tsx";

function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export interface PageChromeProps {
  title: string;
  subtitle?: string | undefined;
  action?: JSX.Element | undefined;
  children: ComponentChildren;
  className?: string | undefined;
}

export function PageChrome({ title, subtitle, action, children, className }: PageChromeProps): JSX.Element {
  return (
    <main class={classes("snt-page snt-surface", className)}>
      <header class="snt-page-head">
        <div><h1 class="snt-page-title">{title}</h1>{subtitle && <p class="snt-page-subtitle">{subtitle}</p>}</div>
        {action}
      </header>
      <div class="snt-pane">{children}</div>
    </main>
  );
}

export interface PaneChromeProps {
  title?: string | undefined;
  subtitle?: string | undefined;
  action?: JSX.Element | undefined;
  children: ComponentChildren;
  className?: string | undefined;
}

export function PaneChrome({ title, subtitle, action, children, className }: PaneChromeProps): JSX.Element {
  return (
    <section class={classes("snt-pane", className)}>
      {(title || subtitle || action) && <header class="snt-page-head"><div>{title && <h2 class="snt-page-title">{title}</h2>}{subtitle && <p class="snt-page-subtitle">{subtitle}</p>}</div>{action}</header>}
      {children}
    </section>
  );
}

export interface SettingsCardProps {
  title?: string | undefined;
  subtitle?: string | undefined;
  action?: JSX.Element | undefined;
  children: ComponentChildren;
  padded?: boolean | undefined;
}

export function SettingsCard({ title, subtitle, action, children, padded = true }: SettingsCardProps): JSX.Element {
  return (
    <Plate>
      {(title || subtitle || action) && <header class="snt-plate__head"><div>{title && <h3 class="snt-card-title">{title}</h3>}{subtitle && <p class="snt-card-subtitle">{subtitle}</p>}</div>{action}</header>}
      <div class={padded ? "snt-plate__body" : undefined}>{children}</div>
    </Plate>
  );
}

export interface SettingsRowProps {
  label: string;
  hint?: string | undefined;
  children: ComponentChildren;
  vertical?: boolean | undefined;
  dirty?: boolean | undefined;
}

export function SettingsRow({ label, hint, children, vertical, dirty }: SettingsRowProps): JSX.Element {
  const rowId = useId();
  const labelId = `${rowId}-label`;
  const hintId = hint ? `${rowId}-hint` : undefined;
  return (
    <div
      class={classes("snt-settings-row", vertical && "snt-settings-row--vertical")}
      role="group"
      aria-labelledby={labelId}
      aria-describedby={hintId}
    >
      <div class="snt-settings-row__content">
        <div id={labelId} class="snt-settings-row__label">{label}{dirty && <span class="snt-kicker"> · Changed</span>}</div>
        {hint && <p id={hintId} class="snt-settings-row__hint">{hint}</p>}
      </div>
      <div class="snt-settings-row__control">{children}</div>
    </div>
  );
}

export interface DominantVisualCardProps {
  label: string;
  description?: string | undefined;
  visual: ComponentChildren;
  ariaLabel?: string | undefined;
  className?: string | undefined;
  onActivate: () => void;
}

export function DominantVisualCard({ label, description, visual, ariaLabel, className, onActivate }: DominantVisualCardProps): JSX.Element {
  return (
    <button type="button" class={classes("snt-media-card", className)} aria-label={ariaLabel} onClick={onActivate}>
      <span class="snt-media-card__visual">{visual}</span>
      <span class="snt-media-card__copy">
        <strong class="snt-media-card__label">{label}</strong>
        {description && <small class="snt-media-card__description">{description}</small>}
      </span>
    </button>
  );
}

const PIN_LENGTH = 4;
/** Timing from the reviewed common-composites PIN sequence. */
export const PIN_CHECKING_MIN_MS = 700;
export const PIN_SUCCESS_TRANSITION_MS = 250;
export const PIN_ERROR_FEEDBACK_MS = 250;
const PIN_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "delete"] as const;

export interface PinKeypadProps {
  onSubmit: (pin: string) => void;
  resetSignal?: number | undefined;
  error?: string | undefined;
  success?: string | undefined;
}

export function PinKeypad({ onSubmit, resetSignal, error, success }: PinKeypadProps): JSX.Element {
  const [digits, setDigits] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [dismissedErrorRevision, setDismissedErrorRevision] = useState<number | null>(null);
  const [errorReadyKey, setErrorReadyKey] = useState<string | null>(null);
  const feedbackRevision = resetSignal ?? 0;
  const errorFeedbackKey = `${feedbackRevision}:${error ?? ""}`;
  const showError = Boolean(error) && dismissedErrorRevision !== feedbackRevision;
  const showSuccess = Boolean(success);
  const errorReady = !showError || errorReadyKey === errorFeedbackKey;

  useEffect(() => {
    setDismissedErrorRevision(null);
    if (success) {
      setSubmitted(true);
      return;
    }
    setSubmitted(false);
    if (!error) setDigits("");
  }, [resetSignal, error, success]);

  useEffect(() => {
    if (!showError) {
      setErrorReadyKey(errorFeedbackKey);
      return;
    }
    setErrorReadyKey(null);
    const timer = window.setTimeout(() => setErrorReadyKey(errorFeedbackKey), PIN_ERROR_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [showError, errorFeedbackKey]);

  const handleKey = (key: string): void => {
    if (submitted || showSuccess || (showError && !errorReady)) return;

    let current = digits;
    if (showError) {
      current = "";
      setDigits("");
      setDismissedErrorRevision(feedbackRevision);
    }

    if (key === "delete") {
      setDigits(current.slice(0, -1));
      return;
    }
    if (!/^\d$/.test(key) || current.length >= PIN_LENGTH) return;

    const next = current + key;
    setDigits(next);
    if (next.length === PIN_LENGTH) {
      setSubmitted(true);
      onSubmit(next);
    }
  };

  const state = showSuccess ? "success" : showError ? "error" : submitted ? "checking" : digits.length > 0 ? "active" : "idle";
  const status = showSuccess
    ? success
    : showError
      ? error
      : submitted
        ? "Checking PIN…"
        : digits.length > 0
          ? `${digits.length} of ${PIN_LENGTH} digits entered.`
          : "Enter your four-digit PIN.";

  return (
    <div
      class="snt-pin-keypad"
      data-state={state}
      onKeyDown={(event) => {
        if (/^\d$/.test(event.key)) {
          event.preventDefault();
          handleKey(event.key);
        } else if (event.key === "Backspace" || event.key === "Delete") {
          event.preventDefault();
          handleKey("delete");
        }
      }}
    >
      <div
        key={`pin-feedback-${feedbackRevision}`}
        class="snt-pin-keypad__progress"
        role="status"
        aria-live="polite"
        aria-label={showSuccess ? "PIN accepted" : digits.length > 0 ? `${digits.length} of ${PIN_LENGTH} digits entered` : "No digits entered"}
      >
        {Array.from({ length: PIN_LENGTH }, (_, index) => (
          <span key={index} class="snt-pin-keypad__dot" data-filled={index < digits.length ? "true" : undefined} aria-hidden="true" />
        ))}
      </div>
      <p class="snt-pin-keypad__status" role={showError ? "alert" : undefined} aria-live={showError ? "assertive" : undefined}>{status}</p>
      <div class="snt-pin-keypad__keys" aria-label="PIN keypad">
        {PIN_KEYS.map((key) => {
          if (key === "") return <span key="blank" class="snt-pin-keypad__key snt-pin-keypad__key--blank" aria-hidden="true" />;
          if (key === "delete") {
            return (
              <ActionButton key={key} variant="destructive" className="snt-pin-keypad__key" disabled={submitted || showSuccess || (showError && !errorReady)} onClick={() => handleKey(key)} ariaLabel="Delete last digit" title="Delete last digit">
                <BackspaceIcon size={24} />
              </ActionButton>
            );
          }
          return (
            <ActionButton key={key} className="snt-pin-keypad__key" disabled={submitted || showSuccess || (showError && !errorReady)} onClick={() => handleKey(key)} ariaLabel={`PIN digit ${key}`} title={`PIN digit ${key}`}>
              {key}
            </ActionButton>
          );
        })}
      </div>
    </div>
  );
}

export function ValidatedField(props: FieldProps): JSX.Element {
  return <Field {...props} />;
}

export interface SecretFieldProps extends Omit<FieldProps, "type"> {
  revealLabel?: string | undefined;
}

export function SecretField({ revealLabel = "secret", ...props }: SecretFieldProps): JSX.Element {
  const [revealed, setRevealed] = useState(false);
  return (
    <div class="snt-secret">
      <Field {...props} type={revealed ? "text" : "password"} />
      <button type="button" class="snt-secret__reveal" aria-label={`${revealed ? "Hide" : "Show"} ${revealLabel}`} aria-pressed={revealed} onClick={() => setRevealed((value) => !value)}>{revealed ? "Hide" : "Show"}</button>
    </div>
  );
}

export interface PinEntryProps {
  value: string;
  onChange: (value: string) => void;
  length?: number | undefined;
  label?: string | undefined;
  disabled?: boolean | undefined;
  autoFocus?: boolean | undefined;
  error?: string | undefined;
}

export function PinEntry({ value, onChange, length = 4, label = "PIN", disabled, autoFocus, error }: PinEntryProps): JSX.Element {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const errorId = `${useId()}-error`;
  const update = (index: number, digit: string): void => {
    if (!/^\d?$/.test(digit)) return;
    const next = Array.from({ length }, (_, position) => value[position] ?? "");
    next[index] = digit;
    onChange(next.join("").slice(0, length));
    if (digit) refs.current[Math.min(index + 1, length - 1)]?.focus();
  };
  return (
    <fieldset class="snt-field" aria-describedby={error ? errorId : undefined}>
      <legend class="snt-field__label">{label}</legend>
      <div class="snt-pin">
        {Array.from({ length }, (_, index) => (
          <input
            key={index}
            ref={(element) => { refs.current[index] = element; }}
            class="snt-input"
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={1}
            autoComplete={index === 0 ? "one-time-code" : "off"}
            aria-label={`${label} digit ${index + 1}`}
            aria-invalid={Boolean(error) || undefined}
            disabled={disabled}
            autoFocus={autoFocus && index === 0}
            value={value[index] ?? ""}
            onInput={(event) => update(index, event.currentTarget.value.slice(-1))}
            onKeyDown={(event) => {
              if (event.key === "Backspace" && !value[index] && index > 0) refs.current[index - 1]?.focus();
              if (event.key === "ArrowLeft") refs.current[Math.max(0, index - 1)]?.focus();
              if (event.key === "ArrowRight") refs.current[Math.min(length - 1, index + 1)]?.focus();
            }}
            onPaste={(event) => {
              const digits = event.clipboardData?.getData("text").replace(/\D/g, "").slice(0, length);
              if (!digits) return;
              event.preventDefault();
              onChange(digits);
              refs.current[Math.min(digits.length, length) - 1]?.focus();
            }}
          />
        ))}
      </div>
      {error && <span id={errorId} class="snt-field__error">{error}</span>}
    </fieldset>
  );
}

export interface IdentityPinEntryProps extends PinEntryProps {
  identity: ComponentChildren;
  description?: string | undefined;
}

export function IdentityPinEntry({ identity, description, ...pin }: IdentityPinEntryProps): JSX.Element {
  return <section class="snt-pane"><header>{identity}{description && <p class="snt-card-subtitle">{description}</p>}</header><PinEntry {...pin} /></section>;
}

export interface SearchFilterBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string | undefined;
  label?: string | undefined;
  children?: ComponentChildren | undefined;
}

export function SearchFilterBar({ value, onChange, placeholder = "Search", label = "Search", children }: SearchFilterBarProps): JSX.Element {
  return (
    <div class="snt-filter-bar" role="search">
      <label class="snt-search">
        <span class="snt-search__icon" aria-hidden="true"><SearchIcon size={16} /></span>
        <span class="sr-only">{label}</span>
        <input type="search" class="snt-input" value={value} placeholder={placeholder} onInput={(event) => onChange(event.currentTarget.value)} />
      </label>
      {children}
    </div>
  );
}

export interface WipBadgeProps {
  label?: string | undefined;
  className?: string | undefined;
}

export function WipBadge({ label = "In progress", className }: WipBadgeProps): JSX.Element {
  return <span class={classes("snt-wip-badge", "wip-badge", className)}>{label}</span>;
}

export interface NoticeProps {
  children: ComponentChildren;
  tone?: "info" | "success" | "warning" | "error" | undefined;
  title?: string | undefined;
  action?: JSX.Element | undefined;
}

function NoticeGlyph({ tone }: { tone: NoticeProps["tone"] }): JSX.Element {
  if (tone === "info") {
    return (
      <svg class="snt-notice__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 11v5M12 8v.1" />
      </svg>
    );
  }
  if (tone === "success") {
    return (
      <svg class="snt-notice__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="m5 12 4.5 4.5L19 7" />
      </svg>
    );
  }
  return (
    <svg class="snt-notice__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 4 3.8 19h16.4L12 4Z" />
      <path d="M12 9v4.5M12 16.5v.1" />
    </svg>
  );
}

export function Notice({ children, tone = "info", title, action }: NoticeProps): JSX.Element {
  const urgent = tone === "error";
  return (
    <div class={classes("snt-notice", tone !== "info" && `snt-notice--${tone}`)} role={urgent ? "alert" : "status"}>
      <NoticeGlyph tone={tone} />
      <div class="snt-notice__content">
        {title && <strong class="snt-notice__title">{title}</strong>}
        <div class={classes("snt-notice__message", title && "snt-notice__message--with-title")}>{children}</div>
      </div>
      {action && <div class="snt-notice__action">{action}</div>}
    </div>
  );
}

export interface AsyncStateProps {
  state: "loading" | "empty" | "error";
  title: string;
  message?: string | undefined;
  action?: JSX.Element | undefined;
}

export function AsyncState({ state, title, message, action }: AsyncStateProps): JSX.Element {
  const liveProps = { role: state === "error" ? "alert" : "status", "aria-live": state === "error" ? "assertive" : "polite" } as const;
  if (state === "loading") {
    return (
      <div class="snt-async-state" data-state={state} {...liveProps}>
        <span class="snt-async-state__spinner" aria-hidden="true" />
        <h3 class="snt-card-title">{title}</h3>
        {message && <p class="snt-card-subtitle">{message}</p>}
        {action}
      </div>
    );
  }
  return <div class="snt-async-state" {...liveProps}><div><h3 class="snt-card-title">{title}</h3>{message && <p class="snt-card-subtitle">{message}</p>}</div>{action}</div>;
}

export function ActionRow({ children }: { children: ComponentChildren }): JSX.Element {
  return <div class="snt-action-row">{children}</div>;
}

export { ActionButton };
