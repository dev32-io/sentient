import type { JSX } from "preact";
import { PaneHeader } from "../../common/composites.tsx";

export interface PaneHeadProps { title: string; sub?: string; action?: JSX.Element; eyebrow?: string; }

export function PaneHead({ title, sub, action, eyebrow }: PaneHeadProps): JSX.Element {
  return <PaneHeader eyebrow={eyebrow} title={title} subtitle={sub} action={action} />;
}
