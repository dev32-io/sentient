import type { JSX } from "preact";
import { SearchFilterBar } from "../../common/composites.tsx";
export interface SearchFieldProps { value: string; onChange: (event: Event) => void; placeholder?: string; fullWidth?: boolean; }
export function SearchField({ value, onChange, placeholder }: SearchFieldProps): JSX.Element {
  return <SearchFilterBar value={value} placeholder={placeholder} onChange={(next) => onChange({ target: { value: next }, currentTarget: { value: next } } as unknown as Event)} />;
}
