import type { JSX } from "preact";

export function LampIcon({ size }: { size: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 2h6l3 7H6z" />
      <path d="M12 9v13" />
      <path d="M8 22h8" />
    </svg>
  );
}
