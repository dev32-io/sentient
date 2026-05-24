import { useEffect, useRef, useState } from "preact/hooks";

interface Props {
  src: string | null;
}

export function AudioPreview({ src }: Props): preact.JSX.Element {
  const ref = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onEnd = () => setIsPlaying(false);
    el.addEventListener("ended", onEnd);
    return () => el.removeEventListener("ended", onEnd);
  }, []);

  if (!src) {
    return (
      <span class="audio-preview audio-preview--unavailable" aria-label="No preview">
        ·
      </span>
    );
  }

  const toggle = () => {
    const el = ref.current;
    if (!el) return;
    if (isPlaying) {
      el.pause();
      el.currentTime = 0;
      setIsPlaying(false);
    } else {
      void el.play();
      setIsPlaying(true);
    }
  };

  return (
    <button
      type="button"
      class="audio-preview"
      onClick={toggle}
      aria-label={isPlaying ? "Stop preview" : "Play preview"}
    >
      {isPlaying ? "⏸" : "▶"}
      <audio ref={ref} src={src} preload="none" />
    </button>
  );
}
