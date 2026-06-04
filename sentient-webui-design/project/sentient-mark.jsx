/* Sentient — Brand mark (atom / nucleus)
 *
 * A warm amber nucleus with electrons in tilted orbital paths around it.
 * The nucleus is the "sentient core"; the orbits are the cognition around it.
 *
 * Design choices that keep this from feeling like the React/clipart atom:
 *   - 3 orbits at non-symmetric tilts (not 0/60/120) → reads as real orbitals
 *   - Orbits use a soft rim color, not cold blue
 *   - Electrons are warm pinpoints, sized differently for rhythm
 *   - Nucleus has its own falloff + glow, not a flat dot
 *
 * Two states:
 *   <SentientMark size={26} />              — neutral / idle (nucleus pulses)
 *   <SentientMark size={26} listening />    — electrons orbit, nucleus brightens
 *
 * Detail tier adapts to size:
 *   < 22px  → 2 orbits + 2 electrons + nucleus (chrome-friendly, no clutter)
 *   >= 22px → 3 orbits + 3 electrons
 *   >= 44px → adds nucleus inner highlight + softer orbit gradient
 *
 * Color tokens come from CSS variables so the mark adapts to the active
 * theme automatically.
 */

const SentientMark = ({
  size = 26,
  listening = false,
  className = "",
  style = {},
}) => {
  const id = React.useId();
  const tier = size < 22 ? "tiny" : size < 44 ? "med" : "lg";

  // Orbit definitions — rx, ry, rotation. Asymmetric on purpose.
  // Sized to fit comfortably inside the container ring (r=30) with margin.
  // Each orbit also defines where its electron sits (angle along the path)
  // and how big the electron is. Electrons are positioned by composing
  // the rotation with the parametric ellipse point.
  const orbits = [
    { rx: 23, ry:  9, rot:  18, electron: { t: 0.18, r: 1.4 } },
    { rx: 23, ry:  9, rot: -28, electron: { t: 0.62, r: 1.1 } },
    { rx: 23, ry:  9, rot:  78, electron: { t: 0.40, r: 1.6 } },
  ];

  // For tiny sizes drop the third orbit + electron
  const visibleOrbits = tier === "tiny" ? orbits.slice(0, 2) : orbits;

  // Compute electron pixel position from (orbit rotation, parametric t)
  const electronPos = (o) => {
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
  };

  return (
    <span
      className={`sentient-mark ${listening ? "is-listening" : ""} ${className}`.trim()}
      style={{
        display: "inline-flex",
        width: size,
        height: size,
        position: "relative",
        flexShrink: 0,
        ...style,
      }}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 64 64"
        width={size}
        height={size}
        fill="none"
        style={{ display: "block", overflow: "visible" }}
      >
        <defs>
          {/* NUCLEUS — bright amber heart, deep falloff */}
          <radialGradient id={`${id}-nuc`} cx="40%" cy="36%" r="70%">
            <stop offset="0%"   stopColor="var(--mark-hi, #FFE6BE)"/>
            <stop offset="35%"  stopColor="var(--mark-ember, #F2A86A)"/>
            <stop offset="78%"  stopColor="var(--mark-terra, #B8552E)"/>
            <stop offset="100%" stopColor="var(--mark-deep, #4E1C0A)"/>
          </radialGradient>

          {/* NUCLEUS GLOW — soft warm bloom around it */}
          <radialGradient id={`${id}-glow`} cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="var(--mark-ember, #F2A86A)" stopOpacity="0.55"/>
            <stop offset="55%"  stopColor="var(--mark-ember, #F2A86A)" stopOpacity="0.12"/>
            <stop offset="100%" stopColor="var(--mark-ember, #F2A86A)" stopOpacity="0"/>
          </radialGradient>

          {/* ELECTRON — small bright pinpoint with a soft halo */}
          <radialGradient id={`${id}-elec`} cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="var(--mark-rim, #FFF1D9)"/>
            <stop offset="55%"  stopColor="var(--mark-hi, #FFE6BE)"/>
            <stop offset="100%" stopColor="var(--mark-ember, #F2A86A)" stopOpacity="0.4"/>
          </radialGradient>

          {/* CONTAINER backplate — luminous warm wash inside the ring so
             the icon's interior glows softly instead of sitting on void.
             Brightest near the nucleus, fading to transparent past the ring. */}
          <radialGradient id={`${id}-plate`} cx="42%" cy="38%" r="58%">
            <stop offset="0%"   stopColor="var(--mark-ember, #F2A86A)" stopOpacity="0.32"/>
            <stop offset="30%"  stopColor="var(--mark-ember, #F2A86A)" stopOpacity="0.20"/>
            <stop offset="60%"  stopColor="var(--mark-terra, #B8552E)" stopOpacity="0.12"/>
            <stop offset="88%"  stopColor="var(--mark-deep, #4E1C0A)" stopOpacity="0.05"/>
            <stop offset="100%" stopColor="var(--mark-deep, #4E1C0A)" stopOpacity="0"/>
          </radialGradient>

          {/* RING fade — vertical gradient applied to the outline so it
             reads as "lit from above" and dissolves at the bottom instead
             of closing as a hard circle. Pairs with the nucleus's top-left
             specular so the whole icon feels lit by one warm light. */}
          <linearGradient id={`${id}-ring`} x1="50%" y1="0%" x2="50%" y2="100%">
            <stop offset="0%"   stopColor="var(--mark-rim, #FFF1D9)" stopOpacity="0.95"/>
            <stop offset="35%"  stopColor="var(--mark-rim, #FFF1D9)" stopOpacity="0.65"/>
            <stop offset="70%"  stopColor="var(--mark-rim, #FFF1D9)" stopOpacity="0.18"/>
            <stop offset="100%" stopColor="var(--mark-rim, #FFF1D9)" stopOpacity="0"/>
          </linearGradient>
        </defs>

        {/* OUTER GLOW — soft warm pool that gives the icon presence at any
           size without a hard container edge. */}
        <circle
          cx="32" cy="32" r="32"
          fill={`url(#${id}-plate)`}
          className="plate"
        />

        {/* CONTAINER RING — fades from bright top → invisible bottom so it
           reads as a soft halo arc, not a closed badge edge. */}
        <circle
          cx="32" cy="32" r={tier === "tiny" ? "29" : "30"}
          fill="none"
          stroke={`url(#${id}-ring)`}
          strokeWidth={tier === "tiny" ? "1.0" : tier === "med" ? "1.2" : "1.4"}
          className="ring"
        />

        {/* nucleus glow halo (sits behind orbits) */}
        <circle
          cx="32" cy="32" r="14"
          fill={`url(#${id}-glow)`}
          className="halo"
        />

        {/* ORBITS — tilted ellipses */}
        <g
          className="orbits"
          stroke="var(--mark-rim, #FFF1D9)"
          strokeWidth={tier === "tiny" ? "0.8" : tier === "med" ? "0.85" : "0.9"}
          fill="none"
          opacity={tier === "tiny" ? "0.55" : "0.5"}
        >
          {visibleOrbits.map((o, i) => (
            <ellipse
              key={i}
              cx="32" cy="32"
              rx={o.rx} ry={o.ry}
              transform={`rotate(${o.rot} 32 32)`}
              className={`orbit orbit-${i}`}
            />
          ))}
        </g>

        {/* NUCLEUS body — the amber heart */}
        <circle
          cx="32" cy="32" r="6"
          fill={`url(#${id}-nuc)`}
          className="nucleus"
        />

        {/* nucleus inner highlight — only at larger sizes */}
        {tier === "lg" && (
          <ellipse
            cx="30.5" cy="30" rx="2" ry="1.4"
            fill="#FFFFFF"
            opacity="0.5"
            className="nucSpec"
          />
        )}

        {/* ELECTRONS — one per visible orbit. Each lives in a group that
            rotates around the nucleus when the mark is .is-listening, so
            it appears to travel along its orbit. */}
        {visibleOrbits.map((o, i) => {
          const p = electronPos(o);
          return (
            <g
              key={i}
              className={`electron-wrap electron-wrap-${i}`}
              style={{ transformOrigin: "32px 32px", transformBox: "fill-box" }}
            >
              <circle
                cx={p.x} cy={p.y} r={o.electron.r}
                fill={`url(#${id}-elec)`}
                className={`electron electron-${i}`}
              />
            </g>
          );
        })}
      </svg>
    </span>
  );
};

window.SentientMark = SentientMark;
