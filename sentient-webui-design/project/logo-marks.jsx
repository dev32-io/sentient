/**
 * Sentient — Mark library
 *
 * All marks accept `size` and `dark`. Colors are tuned for both themes.
 * Each is a real SVG — no gradients-as-art; geometry-first design.
 *
 * Palette (warm + sci-fi):
 *   ink        #2A221C  (strokes on light)
 *   parchment  #F3EADB  (strokes on dark)
 *   terra      #C8623A  (warm core)
 *   ember      #E08A4E  (highlight inside core)
 *   ember-hi   #FFC591  (specular tip)
 *   terra-deep #7B2F1B  (core shadow)
 */

const COLORS = {
  light: {
    ink:    "#2A221C",
    ink2:   "#5A4D42",
    line:   "#D7C8B2",
    paper:  "#FFFBF3",
    terra:  "#C8623A",
    terraDeep: "#7B2F1B",
    ember:  "#E08A4E",
    emberHi:"#FFD9B0",
    halo:   "rgba(200, 98, 58, 0.18)",
  },
  dark: {
    ink:    "#F3EADB",
    ink2:   "#C9BBA6",
    line:   "#5A4D42",
    paper:  "#2C2723",
    terra:  "#E58258",
    terraDeep: "#A14328",
    ember:  "#F2A06A",
    emberHi:"#FFD9B0",
    halo:   "rgba(229, 130, 88, 0.20)",
  },
};

const useC = (dark) => dark ? COLORS.dark : COLORS.light;

/* ──────────────────────────────────────────────────────────────────────── *
 * 01 · APERTURE
 * Three concentric arcs framing a warm pebble core. The arcs increment
 * in stroke weight, suggesting depth & focus. A single tick mark on the
 * outermost ring keys it as "instrumented" / "scientific".
 * ──────────────────────────────────────────────────────────────────────── */
const MarkAperture = ({ size = 64, dark = false }) => {
  const c = useC(dark);
  const id = React.useId();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden>
      <defs>
        <radialGradient id={`${id}-core`} cx="38%" cy="34%" r="78%">
          <stop offset="0%"  stopColor={c.emberHi}/>
          <stop offset="38%" stopColor={c.ember}/>
          <stop offset="78%" stopColor={c.terra}/>
          <stop offset="100%" stopColor={c.terraDeep}/>
        </radialGradient>
        <radialGradient id={`${id}-halo`} cx="50%" cy="50%" r="50%">
          <stop offset="55%" stopColor={c.terra} stopOpacity="0"/>
          <stop offset="100%" stopColor={c.terra} stopOpacity={dark ? 0.35 : 0.22}/>
        </radialGradient>
      </defs>

      {/* outermost arc, thin — broken with a tick gap at top */}
      <circle cx="32" cy="32" r="29" stroke={c.ink} strokeWidth="1" opacity={dark ? 0.55 : 0.45}
              strokeDasharray="2.2 4" />

      {/* mid ring, solid, with a small gap (aperture cut) at upper-right */}
      <path
        d="M 32 5
           A 27 27 0 1 1 51.6 13.4"
        stroke={c.ink} strokeWidth="1.25" strokeLinecap="round" fill="none"
        opacity={dark ? 0.85 : 0.75}
      />
      {/* the tick that sits in the cut */}
      <line x1="51.5" y1="13.4" x2="54.0" y2="11" stroke={c.terra} strokeWidth="1.5" strokeLinecap="round"/>

      {/* inner ring, heavier — the lens body */}
      <circle cx="32" cy="32" r="20" stroke={c.ink} strokeWidth="1.75" fill={c.paper}/>

      {/* warm halo glow, behind core */}
      <circle cx="32" cy="32" r="18" fill={`url(#${id}-halo)`}/>

      {/* warm core */}
      <circle cx="32" cy="32" r="11.5" fill={`url(#${id}-core)`} />

      {/* specular */}
      <ellipse cx="28" cy="28" rx="3.6" ry="2.2" fill={c.emberHi} opacity="0.85"/>
    </svg>
  );
};

/* ──────────────────────────────────────────────────────────────────────── *
 * 02 · HEARTH PEBBLE
 * A soft, asymmetric pebble with a warm gradient interior and a single
 * precision tick. Domestic body, machine detail.
 * ──────────────────────────────────────────────────────────────────────── */
const MarkHearth = ({ size = 64, dark = false }) => {
  const c = useC(dark);
  const id = React.useId();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden>
      <defs>
        <radialGradient id={`${id}-pebble`} cx="35%" cy="30%" r="85%">
          <stop offset="0%"  stopColor={c.emberHi}/>
          <stop offset="35%" stopColor={c.ember}/>
          <stop offset="80%" stopColor={c.terra}/>
          <stop offset="100%" stopColor={c.terraDeep}/>
        </radialGradient>
      </defs>
      {/* pebble — squashed circle, slightly tilted */}
      <path
        d="M 32 6
           C 46 6 56 16 56 30
           C 56 44 46 58 30 58
           C 16 58 8 47 8 32
           C 8 18 18 6 32 6 Z"
        fill={`url(#${id}-pebble)`}
        stroke={c.terraDeep} strokeOpacity="0.35" strokeWidth="0.75"
      />
      {/* inner shadow line, suggests depth */}
      <path
        d="M 12 30
           C 14 18 24 9 36 9"
        stroke={c.emberHi} strokeOpacity="0.55" strokeWidth="1.2" strokeLinecap="round" fill="none"
      />
      {/* precision tick — single notch on the rim, top-right */}
      <line x1="49" y1="14" x2="53" y2="10" stroke={c.ink} strokeWidth="1.4" strokeLinecap="round" opacity={dark ? 0.85 : 0.75}/>
      {/* tiny machine dot — bottom-left */}
      <circle cx="14" cy="48" r="1.2" fill={c.ink} opacity={dark ? 0.7 : 0.55}/>
    </svg>
  );
};

/* ──────────────────────────────────────────────────────────────────────── *
 * 03 · LISTENING RING
 * Open ring with a small ember pulse at the top. Reads as attention,
 * presence, voice. Strong at small sizes.
 * ──────────────────────────────────────────────────────────────────────── */
const MarkListening = ({ size = 64, dark = false }) => {
  const c = useC(dark);
  const id = React.useId();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden>
      <defs>
        <radialGradient id={`${id}-pulse`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={c.emberHi}/>
          <stop offset="55%" stopColor={c.ember}/>
          <stop offset="100%" stopColor={c.terra}/>
        </radialGradient>
        <radialGradient id={`${id}-glow`} cx="50%" cy="20%" r="55%">
          <stop offset="0%" stopColor={c.terra} stopOpacity={dark ? 0.55 : 0.35}/>
          <stop offset="100%" stopColor={c.terra} stopOpacity="0"/>
        </radialGradient>
      </defs>

      {/* warm glow behind the ember */}
      <circle cx="32" cy="13" r="18" fill={`url(#${id}-glow)`}/>

      {/* the ring — open at top, where the ember sits */}
      <path
        d="M 32 9
           A 23 23 0 1 1 31.99 9"
        stroke={c.ink} strokeWidth="2.25" strokeLinecap="round" fill="none"
        pathLength="100" strokeDasharray="92 100" strokeDashoffset="-4"
      />

      {/* ember at top */}
      <circle cx="32" cy="9" r="4.2" fill={`url(#${id}-pulse)`}/>
      <circle cx="30.7" cy="7.7" r="1.4" fill={c.emberHi} opacity="0.9"/>

      {/* central dot — warm, anchoring */}
      <circle cx="32" cy="32" r="2.3" fill={c.terra}/>
    </svg>
  );
};

/* ──────────────────────────────────────────────────────────────────────── *
 * 04 · LANTERN
 * Hexagonal glass body around a warm vertical filament. Sits like a
 * physical product on a counter.
 * ──────────────────────────────────────────────────────────────────────── */
const MarkLantern = ({ size = 64, dark = false }) => {
  const c = useC(dark);
  const id = React.useId();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden>
      <defs>
        <linearGradient id={`${id}-fil`} x1="50%" y1="0%" x2="50%" y2="100%">
          <stop offset="0%"  stopColor={c.emberHi}/>
          <stop offset="50%" stopColor={c.ember}/>
          <stop offset="100%" stopColor={c.terraDeep}/>
        </linearGradient>
        <radialGradient id={`${id}-glow`} cx="50%" cy="50%" r="40%">
          <stop offset="0%"  stopColor={c.terra} stopOpacity={dark ? 0.55 : 0.32}/>
          <stop offset="100%" stopColor={c.terra} stopOpacity="0"/>
        </radialGradient>
      </defs>

      {/* hex body */}
      <path
        d="M 32 6
           L 53 18
           L 53 46
           L 32 58
           L 11 46
           L 11 18 Z"
        fill={c.paper} stroke={c.ink} strokeWidth="1.6" strokeLinejoin="round"
      />
      {/* inner hex line */}
      <path
        d="M 32 12
           L 47.5 21
           L 47.5 43
           L 32 52
           L 16.5 43
           L 16.5 21 Z"
        stroke={c.ink} strokeWidth="0.9" fill="none" opacity={dark ? 0.5 : 0.32}
      />
      {/* warm glow inside */}
      <circle cx="32" cy="32" r="14" fill={`url(#${id}-glow)`}/>
      {/* filament — vertical capsule */}
      <rect x="29" y="20" width="6" height="24" rx="3" fill={`url(#${id}-fil)`}/>
      {/* highlight on filament */}
      <rect x="30.2" y="22" width="1.4" height="14" rx="0.7" fill={c.emberHi} opacity="0.7"/>
      {/* base notch ticks on top + bottom */}
      <line x1="30" y1="6.5" x2="34" y2="6.5" stroke={c.ink} strokeWidth="1.2" strokeLinecap="round"/>
      <line x1="30" y1="57.5" x2="34" y2="57.5" stroke={c.ink} strokeWidth="1.2" strokeLinecap="round"/>
    </svg>
  );
};

/* ──────────────────────────────────────────────────────────────────────── *
 * 05 · CRESCENT APERTURE
 * Aperture cut to a crescent — reads as a speech-shape, softer than
 * the full ring.
 * ──────────────────────────────────────────────────────────────────────── */
const MarkCrescent = ({ size = 64, dark = false }) => {
  const c = useC(dark);
  const id = React.useId();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden>
      <defs>
        <radialGradient id={`${id}-core`} cx="40%" cy="35%" r="75%">
          <stop offset="0%"  stopColor={c.emberHi}/>
          <stop offset="40%" stopColor={c.ember}/>
          <stop offset="100%" stopColor={c.terraDeep}/>
        </radialGradient>
        <mask id={`${id}-cut`}>
          <rect width="64" height="64" fill="white"/>
          {/* offset circle subtracts the crescent */}
          <circle cx="42" cy="22" r="22" fill="black"/>
        </mask>
      </defs>
      {/* crescent shell */}
      <g mask={`url(#${id}-cut)`}>
        <circle cx="32" cy="32" r="26" fill={c.terra} opacity={dark ? 0.45 : 0.3}/>
        <circle cx="32" cy="32" r="26" stroke={c.ink} strokeWidth="1.4" fill="none"/>
      </g>
      {/* warm core — sits inside the crescent's open mouth */}
      <circle cx="32" cy="32" r="11" fill={`url(#${id}-core)`}/>
      <ellipse cx="28.5" cy="28.5" rx="3" ry="1.8" fill={c.emberHi} opacity="0.85"/>
      {/* tick at the crescent's tip, top */}
      <circle cx="44" cy="11" r="1.5" fill={c.ink} opacity={dark ? 0.9 : 0.7}/>
      <circle cx="51" cy="44" r="1.5" fill={c.ink} opacity={dark ? 0.9 : 0.7}/>
    </svg>
  );
};

/* ──────────────────────────────────────────────────────────────────────── *
 * 06 · IRIS PETALS
 * Three folded petals overlapping toward center — closing-aperture
 * geometry. Most "machine" of the set.
 * ──────────────────────────────────────────────────────────────────────── */
const MarkIris = ({ size = 64, dark = false }) => {
  const c = useC(dark);
  const id = React.useId();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden>
      <defs>
        <radialGradient id={`${id}-core`} cx="50%" cy="50%" r="50%">
          <stop offset="0%"  stopColor={c.emberHi}/>
          <stop offset="50%" stopColor={c.ember}/>
          <stop offset="100%" stopColor={c.terra}/>
        </radialGradient>
      </defs>
      {/* outer ring */}
      <circle cx="32" cy="32" r="26" stroke={c.ink} strokeWidth="1.5" fill={c.paper}/>

      {/* three petals — rotated 120° */}
      {[0, 120, 240].map(deg => (
        <path
          key={deg}
          d="M 32 32
             L 32 8
             A 24 24 0 0 1 52.78 20 Z"
          fill={c.terra}
          opacity={dark ? 0.32 : 0.22}
          stroke={c.ink}
          strokeWidth="1.1"
          strokeLinejoin="round"
          transform={`rotate(${deg} 32 32)`}
        />
      ))}

      {/* core ember at center */}
      <circle cx="32" cy="32" r="5.5" fill={`url(#${id}-core)`}/>
      <circle cx="32" cy="32" r="5.5" stroke={c.ink} strokeWidth="0.8" fill="none" opacity={dark ? 0.4 : 0.25}/>
    </svg>
  );
};

/* ──────────────────────────────────────────────────────────────────────── *
 * 07 · FILAMENT
 * Single curved neon filament inside a soft disc. Editorial, calm.
 * ──────────────────────────────────────────────────────────────────────── */
const MarkFilament = ({ size = 64, dark = false }) => {
  const c = useC(dark);
  const id = React.useId();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden>
      <defs>
        <linearGradient id={`${id}-wire`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"  stopColor={c.emberHi}/>
          <stop offset="50%" stopColor={c.ember}/>
          <stop offset="100%" stopColor={c.terraDeep}/>
        </linearGradient>
      </defs>

      {/* disc */}
      <circle cx="32" cy="32" r="27" fill={c.paper} stroke={c.ink} strokeWidth="1.4"/>
      {/* faint inner guide */}
      <circle cx="32" cy="32" r="22" stroke={c.ink} strokeWidth="0.6" fill="none" strokeDasharray="1.5 3" opacity={dark ? 0.5 : 0.3}/>

      {/* the filament — a sigmoid curve */}
      <path
        d="M 16 40
           C 22 22 30 22 32 32
           C 34 42 42 42 48 24"
        stroke={`url(#${id}-wire)`}
        strokeWidth="3.2"
        strokeLinecap="round"
        fill="none"
      />
      {/* glow pass */}
      <path
        d="M 16 40
           C 22 22 30 22 32 32
           C 34 42 42 42 48 24"
        stroke={c.terra}
        strokeWidth="6"
        strokeLinecap="round"
        fill="none"
        opacity={dark ? 0.32 : 0.18}
      />
      {/* end caps as terminals */}
      <circle cx="16" cy="40" r="1.6" fill={c.ink}/>
      <circle cx="48" cy="24" r="1.6" fill={c.ink}/>
    </svg>
  );
};

/* ──────────────────────────────────────────────────────────────────────── *
 * 08 · SUN STONE
 * Type-driven monogram: a chunky 'S' carved as a warm channel. Most
 * wordmark-friendly direction.
 * ──────────────────────────────────────────────────────────────────────── */
const MarkSunStone = ({ size = 64, dark = false }) => {
  const c = useC(dark);
  const id = React.useId();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden>
      <defs>
        <linearGradient id={`${id}-fill`} x1="50%" y1="0%" x2="50%" y2="100%">
          <stop offset="0%"  stopColor={c.ember}/>
          <stop offset="100%" stopColor={c.terraDeep}/>
        </linearGradient>
      </defs>
      {/* rounded stone */}
      <rect x="6" y="6" width="52" height="52" rx="14" fill={c.paper} stroke={c.ink} strokeWidth="1.5"/>
      {/* the channel — an S-shaped warm path */}
      <path
        d="M 44 18
           C 44 14 38 14 32 14
           C 22 14 18 19 18 24
           C 18 30 24 31 32 32
           C 40 33 46 34 46 40
           C 46 45 42 50 32 50
           C 26 50 20 50 20 46"
        stroke={`url(#${id}-fill)`} strokeWidth="5.5" strokeLinecap="round" fill="none"
      />
      {/* embossed ink shadow under channel */}
      <path
        d="M 44 18
           C 44 14 38 14 32 14
           C 22 14 18 19 18 24
           C 18 30 24 31 32 32
           C 40 33 46 34 46 40
           C 46 45 42 50 32 50
           C 26 50 20 50 20 46"
        stroke={c.ink} strokeWidth="6.8" strokeLinecap="round" fill="none" opacity={dark ? 0.18 : 0.12}
      />
      {/* small ember dot — punctuation */}
      <circle cx="48" cy="48" r="2.2" fill={c.terra}/>
    </svg>
  );
};

Object.assign(window, {
  MarkAperture,
  MarkHearth,
  MarkListening,
  MarkLantern,
  MarkCrescent,
  MarkIris,
  MarkFilament,
  MarkSunStone,
});
