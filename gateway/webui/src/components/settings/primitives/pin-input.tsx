import type { JSX } from "preact";
import { useRef } from "preact/hooks";

export interface PinInputProps {
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}

export function PinInput({ value, onChange, autoFocus }: PinInputProps): JSX.Element {
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  const setDigit = (i: number, d: string) => {
    if (!/^[0-9]?$/.test(d)) return;
    const arr = (value ?? "").padEnd(4, " ").split("");
    arr[i] = d || " ";
    const next = arr.join("").trimEnd();
    onChange(next.slice(0, 4));
    if (d && i < 3) refs.current[i + 1]?.focus();
  };

  const onKey = (i: number, e: KeyboardEvent) => {
    if (e.key === "Backspace" && !value[i] && i > 0) refs.current[i - 1]?.focus();
    if (e.key === "ArrowLeft" && i > 0) refs.current[i - 1]?.focus();
    if (e.key === "ArrowRight" && i < 3) refs.current[i + 1]?.focus();
  };

  return (
    <div class="pin">
      {[0, 1, 2, 3].map((i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="password"
          inputMode="numeric"
          maxLength={1}
          class="pin-box"
          autoFocus={autoFocus && i === 0}
          value={value[i] ?? ""}
          onInput={(e) => setDigit(i, (e.target as HTMLInputElement).value)}
          onKeyDown={(e) => onKey(i, e)}
        />
      ))}
    </div>
  );
}
