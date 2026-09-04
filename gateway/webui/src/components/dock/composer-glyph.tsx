import type { JSX } from "preact";

export type ComposerGlyphName = "attachment" | "auto" | "cancel" | "mic" | "send" | "stop" | "volume" | "volume-off";

interface ComposerGlyphProps {
  name: ComposerGlyphName;
  size?: number;
}

/** Approved chat-composer geometry, intentionally local to the product composite. */
export function ComposerGlyph({ name, size = 19 }: ComposerGlyphProps): JSX.Element {
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
      aria-hidden="true"
    >
      {name === "attachment" && <path d="m9 12 6-6a4 4 0 0 1 6 6l-8 8a6 6 0 0 1-8-8l8-8" />}
      {name === "auto" && <path d="M8 17a6 6 0 1 1 8 0M9 12h6M12 9v6M8 20h8" />}
      {name === "cancel" && <path d="m6 6 12 12M18 6 6 18" />}
      {name === "mic" && (
        <>
          <rect x="8" y="3" width="8" height="12" rx="4" />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
        </>
      )}
      {name === "send" && <path d="m4 4 17 8-17 8 3-8zM7 12h14" />}
      {name === "stop" && <rect x="7" y="7" width="10" height="10" rx="2" />}
      {name === "volume" && <path d="M5 10v4h4l5 4V6l-5 4zM17 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12" />}
      {name === "volume-off" && <path d="M5 10v4h4l5 4V6l-5 4zM3 3l18 18" />}
    </svg>
  );
}
