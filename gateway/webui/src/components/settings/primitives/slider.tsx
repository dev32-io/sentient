import type { JSX } from "preact";
import { SliderControl } from "../../common/foundation.tsx";
export interface SliderProps { value: number; onChange: (value: number) => void; min: number; max: number; step: number; format?: (value: number) => string; disabled?: boolean; }
export function Slider(props: SliderProps): JSX.Element { return <SliderControl {...props} />; }
