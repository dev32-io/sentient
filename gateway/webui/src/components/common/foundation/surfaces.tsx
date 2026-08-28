import type { ComponentChildren, JSX } from "preact";
import { classes } from "./utils.ts";

export interface SurfaceProps {
  children: ComponentChildren;
  className?: string | undefined;
}

export function Surface({ children, className }: SurfaceProps): JSX.Element {
  return <div class={classes("snt-surface", className)}>{children}</div>;
}

export function Plate({ children, className }: SurfaceProps): JSX.Element {
  return <section class={classes("snt-plate", className)}>{children}</section>;
}

export function Well({ children, className }: SurfaceProps): JSX.Element {
  return <div class={classes("snt-well", className)}>{children}</div>;
}
