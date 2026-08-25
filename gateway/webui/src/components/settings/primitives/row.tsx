import type { ComponentChildren, JSX } from "preact";
import { SettingsRow } from "../../common/composites.tsx";
export interface RowProps { label: string; hint?: string; children: ComponentChildren; dirty?: boolean; vertical?: boolean; }
export function Row(props: RowProps): JSX.Element { return <SettingsRow {...props} />; }
