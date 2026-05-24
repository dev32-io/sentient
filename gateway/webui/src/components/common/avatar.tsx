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

function avatarRingClass(mode: SentientMarkMode): string {
  if (mode === "listening") return " avatar--listening";
  if (mode === "thinking" || mode === "speaking") return " avatar--running";
  return "";
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
    const ringClass = avatarRingClass(mode);
    return (
      <span class={`avatar avatar--assistant${sizeClass}${ringClass}`} aria-hidden="true">
        <SentientMark size={px} mode={mode} />
      </span>
    );
  }
  return (
    <span class={`avatar avatar--user avatar--${tint}${sizeClass}`} aria-hidden="true">
      {initial ?? ""}
    </span>
  );
}
