import type { JSX } from "preact";
import { SentientMark, type SentientMarkMode } from "./sentient-mark.tsx";

export type AvatarTint = "sage" | "terra" | "amber" | "clay";
export type AvatarSize = "sm" | "lg";

export interface AvatarProps {
  kind: "user" | "assistant";
  initial?: string;
  tint?: AvatarTint;
  size?: AvatarSize;
  mode?: SentientMarkMode;
}

export function Avatar({
  kind,
  initial,
  tint = "terra",
  size = "sm",
  mode = "idle",
}: AvatarProps): JSX.Element {
  const sizeClass = size === "lg" ? " avatar--lg" : "";
  if (kind === "assistant") {
    const px = size === "lg" ? 44 : 28;
    // The active ripple lives on THIS avatar wrapper (.avatar--active) so it
    // appears only at the chat avatar — the top bar / brand mark stays static.
    const activeClass = mode !== "idle" ? " avatar--active" : "";
    return (
      <span class={`avatar avatar--assistant${sizeClass}${activeClass}`} aria-hidden="true">
        <SentientMark size={px} />
      </span>
    );
  }
  return (
    <span class={`avatar avatar--user avatar--${tint}${sizeClass}`} aria-hidden="true">
      {initial ?? ""}
    </span>
  );
}
