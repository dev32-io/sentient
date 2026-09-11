import type { JSX } from "preact";
import { PinKeypad, type PinKeypadProps } from "../common/composites.tsx";

export type PinPadProps = PinKeypadProps;

export function PinPad(props: PinPadProps): JSX.Element {
  return <PinKeypad {...props} />;
}
