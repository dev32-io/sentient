import type { JSX } from "preact";
import { SentientIdentity, type SentientIdentityProps, type SentientIdentityState } from "./sentient-identity.tsx";

/** @deprecated Use SentientIdentityState. */
export type SentientMarkMode = SentientIdentityState;

export interface SentientMarkProps {
  size?: number | undefined;
  mode?: SentientMarkMode | undefined;
  className?: string | undefined;
  label?: string | undefined;
  riveFactory?: SentientIdentityProps["riveFactory"] | undefined;
}

/** Compatibility name for the production three-state identity adapter. */
export function SentientMark({ size = 26, mode = "idle", className, label, riveFactory }: SentientMarkProps): JSX.Element {
  return <SentientIdentity size={size} state={mode} className={className} label={label} riveFactory={riveFactory} />;
}

export { SentientIdentity };
export type { SentientIdentityProps, SentientIdentityState };
