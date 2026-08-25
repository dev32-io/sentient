import type { JSX } from "preact";
import { FoundationIconButton } from "./foundation.tsx";
import { Icon, type IconName } from "./icon.tsx";

export interface IconButtonProps {
  iconName: IconName;
  title: string;
  active?: boolean;
  disabled?: boolean;
  variant?: "default" | "interrupt" | "tts-on" | "tts-off";
  onClick(): void;
}

export function IconButton({ iconName, title, active, disabled, variant = "default", onClick }: IconButtonProps): JSX.Element {
  const destructive = variant === "interrupt";
  return <FoundationIconButton label={title} pressed={active} disabled={disabled} variant={destructive ? "destructive" : "default"} className={`icon-btn icon-btn--${variant}${active ? " icon-btn--active" : ""}`} onClick={onClick}><Icon name={iconName} size={16} /></FoundationIconButton>;
}
