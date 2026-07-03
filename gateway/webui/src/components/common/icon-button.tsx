import type { JSX } from "preact";
import { Icon, type IconName } from "./icon.tsx";

export interface IconButtonProps {
  iconName: IconName;
  title: string;
  active?: boolean;
  variant?: "default" | "interrupt" | "tts-on" | "tts-off";
  onClick(): void;
}

export function IconButton({
  iconName,
  title,
  active,
  variant = "default",
  onClick,
}: IconButtonProps): JSX.Element {
  const cls = ["icon-btn", `icon-btn--${variant}`, active && "icon-btn--active"]
    .filter(Boolean)
    .join(" ");
  return (
    <button type="button" class={cls} aria-label={title} title={title} onClick={onClick}>
      <Icon name={iconName} size={16} />
    </button>
  );
}
