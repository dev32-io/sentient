import type { ComponentChildren, JSX } from "preact";
import { ChipControl } from "../../common/foundation.tsx";
export interface ChipProps { active: boolean; onClick: () => void; children: ComponentChildren; disabled?: boolean; }
export function Chip({ active, onClick, children, disabled }: ChipProps): JSX.Element {
  return <ChipControl selected={active} onClick={onClick} disabled={disabled}>{children}</ChipControl>;
}
