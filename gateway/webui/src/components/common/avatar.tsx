import type { JSX } from "preact";
import { SentientIdentity, type SentientIdentityState } from "./sentient-identity.tsx";

export type AvatarTint = "sage" | "terra" | "amber" | "clay";
export type AvatarSize = "sm" | "lg" | "xl";

export interface AvatarProps {
  kind: "user" | "assistant";
  initial?: string;
  name?: string;
  tint?: AvatarTint;
  size?: AvatarSize;
  mode?: SentientIdentityState;
  selected?: boolean;
  disabled?: boolean;
}

const PIXELS: Record<AvatarSize, number> = { sm: 28, lg: 44, xl: 56 };

export function Avatar({ kind, initial, name, tint = "terra", size = "sm", mode = "idle", selected, disabled }: AvatarProps): JSX.Element {
  const foundationSize = `snt-avatar--${size}`;
  if (kind === "assistant") {
    return (
      <span class={`snt-avatar snt-avatar--sentient ${foundationSize}`}>
        <SentientIdentity size={PIXELS[size]} state={mode} label={name ?? "Sentient"} />
      </span>
    );
  }
  const trimmedInitial = initial?.trim();
  const isFallback = !trimmedInitial;
  const displayedInitial = trimmedInitial?.slice(0, 2).toLocaleUpperCase() || "?";
  const accessibleName = name ?? `User ${displayedInitial}`;
  return (
    <span
      role="img"
      class={`snt-avatar snt-avatar--user snt-avatar--${isFallback ? "fallback" : tint} ${foundationSize}${selected ? " snt-avatar--selected" : ""}`}
      aria-label={selected ? `${accessibleName}, selected` : accessibleName}
      aria-disabled={disabled || undefined}
    >
      <span aria-hidden="true">{displayedInitial}</span>
    </span>
  );
}
