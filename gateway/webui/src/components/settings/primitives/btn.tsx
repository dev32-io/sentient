import type { ComponentChildren, JSX } from "preact";
import { ActionButton } from "../../common/foundation.tsx";

export interface BtnProps {
  kind?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
  danger?: boolean;
  dark?: boolean;
  children: ComponentChildren;
  icon?: JSX.Element;
  disabled?: boolean;
  loading?: boolean;
  onClick?: (event: MouseEvent) => void;
  type?: "button" | "submit";
  title?: string;
}

export function Btn({ kind = "ghost", danger, children, icon, size: _size, dark: _dark, ...props }: BtnProps): JSX.Element {
  const variant = danger ? "destructive" : kind === "primary" ? "primary" : kind === "ghost" ? "quiet" : "default";
  return <ActionButton {...props} variant={variant}>{icon}{children}</ActionButton>;
}
