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
  const sizeClass = size === "sm" ? "" : ` avatar--${size}`;
  const foundationSize = `snt-avatar--${size}`;
  if (kind === "assistant") {
    return (
      <span class={`avatar avatar--assistant${sizeClass} snt-avatar snt-avatar--sentient ${foundationSize}`}>
        <SentientIdentity size={PIXELS[size]} state={mode} label={name ?? "Sentient"} />
      </span>
    );
  }
  const fallback = initial?.trim().slice(0, 2).toLocaleUpperCase() || "?";
  return (
    <span
      class={`avatar avatar--user avatar--${tint}${sizeClass} snt-avatar snt-avatar--user snt-avatar--${tint} ${foundationSize}${selected ? " snt-avatar--selected" : ""}`}
      aria-label={name ?? `User ${fallback}`}
      aria-disabled={disabled || undefined}
    >
      {fallback}
    </span>
  );
}
