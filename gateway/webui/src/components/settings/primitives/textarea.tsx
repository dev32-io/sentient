import type { JSX } from "preact";
import { TextArea } from "../../common/foundation.tsx";
export interface TextareaProps { value: string; onChange: (event: Event) => void; placeholder?: string; rows?: number; monospace?: boolean; dirty?: boolean; disabled?: boolean; spellcheck?: boolean; maxLength?: number; }
export function Textarea({ onChange, monospace, dirty, ...props }: TextareaProps): JSX.Element {
  return <TextArea {...props} monospace={monospace} dirty={dirty} onInput={(event) => onChange(event as unknown as Event)} />;
}
