import type { JSX } from "preact";
import { useId } from "preact/hooks";

export type SentientMarkMode = "idle" | "thinking" | "speaking" | "listening";

export interface SentientMarkProps {
  size?: number;
  mode?: SentientMarkMode;
  className?: string;
}

/**
 * Thinking and speaking share the same halo+nucleus animation — the bubble
 * content (pulse-dot ellipsis vs streaming text vs audio wave) is what
 * distinguishes them. Listening is its own visual (full electron orbit suite).
 * Idle = static.
 */
function modeClass(mode: SentientMarkMode): string {
  if (mode === "listening") return " sentient-mark--listening";
  if (mode === "thinking" || mode === "speaking") return " sentient-mark--running";
  return "";
}

interface Orbit {
  rx: number;
  ry: number;
  rot: number;
  electron: { t: number; r: number };
}

const ORBITS: readonly Orbit[] = [
  { rx: 23, ry: 9, rot: 18, electron: { t: 0.18, r: 1.4 } },
  { rx: 23, ry: 9, rot: -28, electron: { t: 0.62, r: 1.1 } },
  { rx: 23, ry: 9, rot: 78, electron: { t: 0.4, r: 1.6 } },
];

interface Point {
  x: number;
  y: number;
}

function electronPos(o: Orbit): Point {
  const theta = o.electron.t * Math.PI * 2;
  const x = o.rx * Math.cos(theta);
  const y = o.ry * Math.sin(theta);
  const rad = (o.rot * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: 32 + x * cos - y * sin,
    y: 32 + x * sin + y * cos,
  };
}

export function SentientMark({
  size = 26,
  mode = "idle",
  className = "",
}: SentientMarkProps): JSX.Element {
  const reactId = useId();
  const id = reactId.replace(/[^a-zA-Z0-9_-]/g, "");
  const tier: "tiny" | "med" | "lg" = size < 22 ? "tiny" : size < 44 ? "med" : "lg";
  const visible = tier === "tiny" ? ORBITS.slice(0, 2) : ORBITS;
  const ringR = tier === "tiny" ? 29 : 30;
  const ringW = tier === "tiny" ? 1.0 : tier === "med" ? 1.2 : 1.4;
  const orbitW = tier === "tiny" ? 0.8 : tier === "med" ? 0.85 : 0.9;
  const orbitOp = tier === "tiny" ? 0.55 : 0.5;

  return (
    <span
      class={`sentient-mark${modeClass(mode)}${className ? ` ${className}` : ""}`}
      style={{ width: `${size}px`, height: `${size}px` }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 64 64" width={size} height={size} fill="none">
        <defs>
          <radialGradient id={`${id}-nuc`} cx="40%" cy="36%" r="70%">
            <stop offset="0%" stop-color="var(--mark-hi, #FFE1BD)" />
            <stop offset="35%" stop-color="var(--mark-ember, #FFB87A)" />
            <stop offset="78%" stop-color="var(--mark-terra, #F2A06A)" />
            <stop offset="100%" stop-color="var(--mark-deep, #B85530)" />
          </radialGradient>
          <radialGradient id={`${id}-glow`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="var(--mark-ember, #FFB87A)" stop-opacity="0.55" />
            <stop offset="55%" stop-color="var(--mark-ember, #FFB87A)" stop-opacity="0.12" />
            <stop offset="100%" stop-color="var(--mark-ember, #FFB87A)" stop-opacity="0" />
          </radialGradient>
          <radialGradient id={`${id}-elec`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="var(--mark-rim, #FFF3DB)" />
            <stop offset="55%" stop-color="var(--mark-hi, #FFE1BD)" />
            <stop offset="100%" stop-color="var(--mark-ember, #FFB87A)" stop-opacity="0.4" />
          </radialGradient>
          <radialGradient id={`${id}-plate`} cx="42%" cy="38%" r="58%">
            <stop offset="0%" stop-color="var(--mark-ember, #FFB87A)" stop-opacity="0.32" />
            <stop offset="30%" stop-color="var(--mark-ember, #FFB87A)" stop-opacity="0.20" />
            <stop offset="60%" stop-color="var(--mark-terra, #F2A06A)" stop-opacity="0.12" />
            <stop offset="88%" stop-color="var(--mark-deep, #B85530)" stop-opacity="0.05" />
            <stop offset="100%" stop-color="var(--mark-deep, #B85530)" stop-opacity="0" />
          </radialGradient>
          <linearGradient id={`${id}-ring`} x1="50%" y1="0%" x2="50%" y2="100%">
            <stop offset="0%" stop-color="var(--mark-rim, #FFF3DB)" stop-opacity="0.95" />
            <stop offset="35%" stop-color="var(--mark-rim, #FFF3DB)" stop-opacity="0.65" />
            <stop offset="70%" stop-color="var(--mark-rim, #FFF3DB)" stop-opacity="0.18" />
            <stop offset="100%" stop-color="var(--mark-rim, #FFF3DB)" stop-opacity="0" />
          </linearGradient>
        </defs>

        <circle cx="32" cy="32" r="32" fill={`url(#${id}-plate)`} class="sentient-mark__plate" />
        <circle
          cx="32"
          cy="32"
          r={ringR}
          fill="none"
          stroke={`url(#${id}-ring)`}
          stroke-width={ringW}
          class="sentient-mark__ring"
        />
        <circle cx="32" cy="32" r="14" fill={`url(#${id}-glow)`} class="sentient-mark__halo" />

        <g
          class="sentient-mark__orbits"
          stroke="var(--mark-rim, #FFF1D9)"
          stroke-width={orbitW}
          fill="none"
          opacity={orbitOp}
        >
          {visible.map((o, i) => (
            <ellipse
              key={i}
              cx="32"
              cy="32"
              rx={o.rx}
              ry={o.ry}
              transform={`rotate(${o.rot} 32 32)`}
            />
          ))}
        </g>

        <circle cx="32" cy="32" r="6" fill={`url(#${id}-nuc)`} class="sentient-mark__nucleus" />
        {tier === "lg" && (
          <ellipse cx="30.5" cy="30" rx="2" ry="1.4" fill="#FFFFFF" opacity="0.5" />
        )}

        {visible.map((o, i) => {
          const p = electronPos(o);
          return (
            <g key={i} class={`sentient-mark__electron-wrap sentient-mark__electron-wrap--${i}`}>
              <circle cx={p.x} cy={p.y} r={o.electron.r} fill={`url(#${id}-elec)`} />
            </g>
          );
        })}
      </svg>
    </span>
  );
}
