import type { JSX } from "preact";
import { ToggleControl } from "../../common/foundation.tsx";
export interface ToggleProps { on: boolean; onChange: () => void; disabled?: boolean; label?: string; }
export function Toggle({ on, onChange, disabled, label = "Toggle" }: ToggleProps): JSX.Element {
  return <ToggleControl label={label} checked={on} disabled={disabled} onChange={onChange} />;
}
