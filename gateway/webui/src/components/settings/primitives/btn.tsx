import type { ComponentChildren, JSX } from "preact";

export interface BtnProps {
  kind?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
  danger?: boolean;
  dark?: boolean;
  children: ComponentChildren;
  icon?: JSX.Element;
  disabled?: boolean;
  onClick?: (e: MouseEvent) => void;
  type?: "button" | "submit";
  title?: string;
}

export function Btn({
  kind = "ghost",
  size = "md",
  danger,
  dark,
  children,
  icon,
  disabled,
  onClick,
  type = "button",
  title,
}: BtnProps): JSX.Element {
  const cls = [
    "btn",
    `b-${kind}`,
    `b-${size}`,
    danger ? "danger" : "",
    dark ? "on-dark" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type={type} class={cls} disabled={disabled} onClick={onClick} title={title}>
      {icon && <span class="b-icon">{icon}</span>}
      {children}
    </button>
  );
}
