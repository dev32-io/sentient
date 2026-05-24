import type { JSX } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";

const PIN_LENGTH = 4;
const KEYS: Array<{ digit: string; label: string }> = [
  { digit: "1", label: "1" },
  { digit: "2", label: "2" },
  { digit: "3", label: "3" },
  { digit: "4", label: "4" },
  { digit: "5", label: "5" },
  { digit: "6", label: "6" },
  { digit: "7", label: "7" },
  { digit: "8", label: "8" },
  { digit: "9", label: "9" },
  { digit: "", label: "" },
  { digit: "0", label: "0" },
  { digit: "del", label: "⌫" },
];

export interface PinPadProps {
  onSubmit: (pin: string) => void;
  resetSignal?: number;
}

export function PinPad({ onSubmit, resetSignal }: PinPadProps): JSX.Element {
  const [digits, setDigits] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    setDigits("");
    setSubmitted(false);
  }, [resetSignal]);

  const handleKey = useCallback(
    (digit: string) => {
      if (submitted) return;
      if (digit === "del") {
        setDigits((prev) => prev.slice(0, -1));
        return;
      }
      if (digits.length >= PIN_LENGTH) return;
      const next = digits + digit;
      setDigits(next);
      if (next.length === PIN_LENGTH) {
        setSubmitted(true);
        onSubmit(next);
      }
    },
    [digits, submitted, onSubmit],
  );

  return (
    <div class="pin-pad">
      <div class="pin-pad__dots">
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <span
            key={i}
            class={`pin-pad__dot${i < digits.length ? " pin-pad__dot--filled" : ""}`}
          />
        ))}
      </div>
      <div class="pin-pad__keys">
        {KEYS.map(({ digit, label }) => {
          if (digit === "") {
            return <span key="blank" class="pin-pad__key pin-pad__key--blank" />;
          }
          if (digit === "del") {
            return (
              <button
                key="del"
                class="pin-pad__key pin-pad__key--delete"
                onClick={() => handleKey("del")}
                aria-label="delete"
              >
                {label}
              </button>
            );
          }
          return (
            <button
              key={digit}
              class="pin-pad__key"
              onClick={() => handleKey(digit)}
              aria-label={digit}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}