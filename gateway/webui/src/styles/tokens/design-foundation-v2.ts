// GENERATED FILE — DO NOT EDIT.
// Design foundation 2.0.0; contract sha256: f7799ee0711e7d8e4bd944606ab9342607f326ff109a44d905d8a2a7b91c7dc6
// Source: shared/mobile-sdk/design-foundation-v2.json

export const DESIGN_FOUNDATION_VERSION = "2.0.0" as const;
export const DESIGN_FOUNDATION_SHA256 = "f7799ee0711e7d8e4bd944606ab9342607f326ff109a44d905d8a2a7b91c7dc6" as const;
export type DesignComponentState =
  | "rest"
  | "hover"
  | "focus"
  | "pressed"
  | "selected"
  | "on"
  | "destructive"
  | "disabled";
export type SentientAvatarState = "idle" | "thinking" | "responding";

export interface DesignFoundationV2 {
  readonly version: typeof DESIGN_FOUNDATION_VERSION;
  readonly description: string;
  readonly colors: Readonly<Record<string, string>>;
  readonly typography: {
    readonly families: Readonly<Record<string, string>>;
    readonly sizesPx: Readonly<Record<string, number>>;
    readonly lineHeights: Readonly<Record<string, number>>;
  };
  readonly spacingPx: Readonly<Record<string, number>>;
  readonly radiiPx: Readonly<Record<string, number>>;
  readonly pill: { readonly kind: "pill"; readonly cssValue: string; readonly kotlinValue: number };
  readonly motion: Readonly<Record<string, number>>;
  readonly materials: {
    readonly physicalModel: Readonly<Record<string, string | boolean | readonly string[]>>;
    readonly recipes: Readonly<Record<string, string>>;
  };
  readonly componentStates: readonly DesignComponentState[];
  readonly avatars: {
    readonly sentient: {
      readonly runtimeFile: string;
      readonly manifestPath: string;
      readonly manifestSha256: string;
      readonly runtimeSha256: string;
      readonly artboard: string;
      readonly stateMachine: string;
      readonly states: readonly SentientAvatarState[];
      readonly triggers: Readonly<Record<SentientAvatarState, string>>;
      readonly reducedMotion: { readonly input: string; readonly type: "boolean" };
      readonly transitionDurationMs: number;
    };
    readonly user: {
      readonly sizesPx: readonly number[];
      readonly tints: readonly string[];
      readonly states: readonly string[];
    };
  };
}

export const designFoundationV2 = JSON.parse(
  String.raw`{"$schema":"./design-foundation-v2.schema.json","version":"2.0.0","description":"Locked, additive Sentient design foundation v2. Design values are implementation protocol constants; operator-tunable product behavior remains in YAML/config.","colors":{"bg":"#2B2621","elevated":"#332D28","sunk":"#241F1B","paper":"#39322C","line":"#4A4138","lineSoft":"#3E362F","ink":"#F2E8D6","inkSecondary":"#D7C6AB","inkTertiary":"#9E907E","inkMuted":"#706456","ember":"#F2A06A","emberSoft":"#5A3A28","emberDeep":"#402C22","amber":"#E9B168","sage":"#B9C8A6","sageSoft":"#3A4232","clay":"#9A5A3E","ok":"#5F8A5B","warn":"#C2892F","stop":"#B8442E"},"typography":{"families":{"display":"Fraunces, Cormorant Garamond, Georgia, serif","ui":"DM Sans, Inter, system-ui, -apple-system, sans-serif","mono":"JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"},"sizesPx":{"xs":11,"sm":12.5,"base":15,"lg":18,"xl":22,"display":44},"lineHeights":{"tight":1.25,"normal":1.55,"relaxed":1.6}},"spacingPx":{"xs":4,"sm":8,"md":12,"lg":18,"xl":26,"xxl":32,"xxxl":40},"radiiPx":{"sm":8,"md":12,"lg":18,"xl":26},"pill":{"kind":"pill","cssValue":"9999px","kotlinValue":2147483647},"motion":{"feedbackMs":150,"stateTransitionMs":250,"respondingCadenceMs":1550},"materials":{"physicalModel":{"actionableFaces":"elevated-subtly-concave","receivingSurfaces":"recessed","broadPlates":"quiet","brightPerimeterRim":false,"centerHighlight":false,"emberUsage":["commitment","focus","activity"]},"recipes":{"slate-face":"radial-gradient( ellipse 82% 105% at 50% 52%, color-mix(in oklab, var(--slate-base, var(--color-paper)) 80%, var(--color-bg-sunk)) 0%, color-mix(in oklab, var(--slate-base, var(--color-paper)) 88%, var(--color-bg-sunk)) 42%, transparent 76% ), linear-gradient( 180deg, color-mix(in oklab, var(--slate-base, var(--color-paper)) 96%, var(--color-ink)) 0%, var(--slate-base, var(--color-paper)) 100% )","slate-face-hover":"radial-gradient( ellipse 82% 105% at 50% 52%, color-mix(in oklab, var(--slate-base, var(--color-paper)) 77%, var(--color-bg-sunk)) 0%, color-mix(in oklab, var(--slate-base, var(--color-paper)) 86%, var(--color-bg-sunk)) 42%, transparent 76% ), linear-gradient( 180deg, color-mix(in oklab, var(--slate-base, var(--color-paper)) 94%, var(--color-ink)) 0%, color-mix(in oklab, var(--slate-base, var(--color-paper)) 97%, var(--color-accent)) 100% )","slate-face-muted":"radial-gradient( ellipse 82% 105% at 50% 52%, color-mix(in oklab, var(--slate-base, var(--color-bg-elev)) 84%, var(--color-bg-sunk)) 0%, transparent 74% ), linear-gradient(180deg, color-mix(in oklab, var(--slate-base, var(--color-bg-elev)) 97%, var(--color-ink-4)), var(--slate-base, var(--color-bg-elev)))","slate-top-light":"inset 0 1px 0 color-mix(in oklab, var(--color-ink) 7%, transparent)","slate-contact":"0 2px 0 -1px color-mix(in oklab, var(--color-bg-sunk) 88%, var(--color-line))","slate-cast":"0 9px 15px -10px rgba(0, 0, 0, .9)","slate-ember-cast":"0 12px 20px -16px color-mix(in oklab, var(--color-accent) 42%, transparent)","slate-shadow":"var(--slate-top-light), var(--slate-contact), var(--slate-cast), var(--slate-ember-cast)","slate-shadow-hover":"inset 0 1px 0 color-mix(in oklab, var(--color-ink) 13%, transparent), 0 2px 0 -1px color-mix(in oklab, var(--color-bg-sunk) 90%, var(--color-line)), 0 11px 18px -10px rgba(0, 0, 0, .94), 0 14px 22px -14px color-mix(in oklab, var(--color-accent) 48%, transparent)","slate-shadow-pressed":"inset 0 2px 3px color-mix(in oklab, var(--color-bg-sunk) 42%, transparent), 0 1px 0 -1px color-mix(in oklab, var(--color-bg-sunk) 90%, var(--color-line)), 0 3px 6px -5px rgba(0, 0, 0, .88)","slate-shadow-disabled":"inset 0 1px 0 color-mix(in oklab, var(--color-ink) 5%, transparent), 0 1px 0 -1px color-mix(in oklab, var(--color-bg-sunk) 72%, var(--color-line)), 0 5px 9px -8px rgba(0, 0, 0, .7)","well-face":"linear-gradient( 180deg, color-mix(in oklab, var(--color-bg-sunk) 95%, black) 0%, var(--color-bg-sunk) 56%, color-mix(in oklab, var(--color-bg-sunk) 90%, var(--color-bg-elev)) 100% )","well-shadow":"inset 0 3px 6px -2px rgba(0, 0, 0, .72), inset 0 -1px 0 color-mix(in oklab, var(--color-ink) 7%, transparent), 0 1px 0 color-mix(in oklab, var(--color-line) 45%, transparent)","well-shadow-focus":"inset 0 3px 6px -2px rgba(0, 0, 0, .76), inset 0 -1px 0 color-mix(in oklab, var(--color-ink) 8%, transparent), 0 0 0 3px color-mix(in oklab, var(--color-accent) 18%, transparent), 0 8px 18px -14px color-mix(in oklab, var(--color-accent) 48%, transparent)","plate-shadow":"inset 0 1px 0 color-mix(in oklab, var(--color-ink) 5%, transparent), 0 2px 0 -1px color-mix(in oklab, var(--color-bg-sunk) 78%, var(--color-line)), 0 18px 30px -22px rgba(0, 0, 0, .9)","float-shadow":"inset 0 1px 0 color-mix(in oklab, var(--color-ink) 7%, transparent), 0 3px 0 -1px color-mix(in oklab, var(--color-bg-sunk) 86%, var(--color-line)), 0 28px 58px -22px rgba(0, 0, 0, .96), 0 24px 40px -30px color-mix(in oklab, var(--color-accent) 38%, transparent)"}},"componentStates":["rest","hover","focus","pressed","selected","on","destructive","disabled"],"avatars":{"sentient":{"runtimeFile":"sentient-avatar.riv","manifestPath":"design/prototype/foundation-components/assets/avatars/sentient-avatar.rive-manifest.json","manifestSha256":"b9a8a732688499510050e023c541667ddb5dacb5bc9d1ab368cca97b23b810ee","runtimeSha256":"bad6f8c82fba6386233cef356adc59fa6017a7c97c0de61a377546405b1e892b","artboard":"SentientAvatar","stateMachine":"Avatar","states":["idle","thinking","responding"],"triggers":{"idle":"toIdle","thinking":"toThinking","responding":"toResponding"},"reducedMotion":{"input":"reducedMotion","type":"boolean"},"transitionDurationMs":250},"user":{"sizesPx":[28,44,56],"tints":["emberDeep","sageSoft","amber","clay"],"states":["fallback","selected","disabled"]}}}`,
) as DesignFoundationV2;
