import type { JSX } from "preact";

export function PaperclipIcon({ size }: { size: number }): JSX.Element {
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
      <path d="m9 12 6-6a4 4 0 0 1 6 6l-8 8a6 6 0 0 1-8-8l8-8" />
    </svg>
  );
}
