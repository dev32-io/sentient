import type { JSX } from "preact";
import { SelectMenu, type SelectMenuOption } from "../../common/select-menu.tsx";

export type SelectOption = SelectMenuOption;
export interface SelectProps { value: string; onChange: (value: string) => void; options: SelectOption[]; placeholder?: string; disabled?: boolean; }

/** Compatibility wrapper; the shared SelectMenu owns semantics and keyboard behavior. */
export function Select(props: SelectProps): JSX.Element {
  return <SelectMenu {...props} />;
}
