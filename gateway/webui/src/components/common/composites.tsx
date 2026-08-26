import type { ComponentChildren, JSX } from "preact";
import { useId, useRef, useState } from "preact/hooks";
import { ActionButton, Field, type FieldProps, Plate, ProgressControl } from "./foundation.tsx";
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
  return (
    <div class={classes("snt-settings-row", vertical && "snt-settings-row--vertical")}>
      <div><div class="snt-settings-row__label">{label}{dirty && <span class="snt-kicker"> · Changed</span>}</div>{hint && <p class="snt-settings-row__hint">{hint}</p>}</div>
      <div>{children}</div>
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
  tone?: "info" | "success" | "error" | undefined;
  title?: string | undefined;
}

export function Notice({ children, tone = "info", title }: NoticeProps): JSX.Element {
  const urgent = tone === "error";
  return <div class={classes("snt-notice", tone !== "info" && `snt-notice--${tone}`)} role={urgent ? "alert" : "status"}>{title && <div class="snt-card-title">{title}</div>}{children}</div>;
}

export interface AsyncStateProps {
  state: "loading" | "empty" | "error";
  title: string;
  message?: string | undefined;
  action?: JSX.Element | undefined;
}

export function AsyncState({ state, title, message, action }: AsyncStateProps): JSX.Element {
  return <div class="snt-async-state" role={state === "error" ? "alert" : "status"} aria-live={state === "error" ? "assertive" : "polite"}>{state === "loading" && <ProgressControl label={title} />}<div><h3 class="snt-card-title">{title}</h3>{message && <p class="snt-card-subtitle">{message}</p>}</div>{action}</div>;
}

export function ActionRow({ children }: { children: ComponentChildren }): JSX.Element {
  return <div class="snt-action-row">{children}</div>;
}

export { ActionButton };
