import type { JSX } from "preact";

export function BrainIcon({ size }: { size: number }): JSX.Element {
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
      <path d="M12 5a3 3 0 0 0-3-3 3 3 0 0 0-3 3 2.5 2.5 0 0 0-2 4 2.5 2.5 0 0 0 0 4 2.5 2.5 0 0 0 2 4 3 3 0 0 0 3 3 3 3 0 0 0 3-3z" />
      <path d="M12 5a3 3 0 0 1 3-3 3 3 0 0 1 3 3 2.5 2.5 0 0 1 2 4 2.5 2.5 0 0 1 0 4 2.5 2.5 0 0 1-2 4 3 3 0 0 1-3 3 3 3 0 0 1-3-3z" />
      <path d="M12 5v14" />
    </svg>
  );
}
