import type { JSX } from "preact";
import { SegmentedControl } from "../../common/foundation.tsx";
export interface SegmentedOption { value: string; label: string; }
export interface SegmentedProps { value: string; onChange: (value: string) => void; options: SegmentedOption[]; disabled?: boolean; }
export function Segmented(props: SegmentedProps): JSX.Element { return <SegmentedControl {...props} label="Options" />; }
