import type { JSX } from "preact";
import { PinEntry } from "../../common/composites.tsx";
export interface PinInputProps { value: string; onChange: (value: string) => void; autoFocus?: boolean; }
export function PinInput(props: PinInputProps): JSX.Element { return <PinEntry {...props} label="PIN" />; }
