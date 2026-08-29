import { Rive, type StateMachineInput } from "@rive-app/canvas";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

export type SentientIdentityState = "idle" | "thinking" | "responding";

export function normalizeSentientIdentityState(value: unknown): SentientIdentityState {
  return value === "thinking" || value === "responding" ? value : "idle";
}

const TRIGGERS: Record<SentientIdentityState, string> = {
  idle: "toIdle",
  thinking: "toThinking",
  responding: "toResponding",
};

interface RiveAdapter {
  stateMachineInputs(name: string): StateMachineInput[];
  resizeDrawingSurfaceToCanvas(): void;
  cleanup(): void;
}

interface RiveConfiguration {
  src: string;
  canvas: HTMLCanvasElement;
  artboard: string;
  stateMachines: string;
  autoplay: boolean;
  onLoad: () => void;
  onLoadError: () => void;
}

export type RiveFactory = (configuration: RiveConfiguration) => RiveAdapter;

const defaultRiveFactory: RiveFactory = (configuration) => new Rive(configuration);

export interface SentientIdentityProps {
  state?: SentientIdentityState | undefined;
  size?: number | undefined;
  className?: string | undefined;
  label?: string | undefined;
  riveFactory?: RiveFactory | undefined;
}

function motionPreference(): MediaQueryList | null {
  return typeof window === "undefined" || typeof window.matchMedia !== "function"
    ? null
    : window.matchMedia("(prefers-reduced-motion: reduce)");
}

export function SentientIdentity({ state = "idle", size = 28, className = "", label = "Sentient", riveFactory = defaultRiveFactory }: SentientIdentityProps): JSX.Element {
  const normalizedState = normalizeSentientIdentityState(state);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const instanceRef = useRef<RiveAdapter | null>(null);
  const inputsRef = useRef<StateMachineInput[]>([]);
  const latestStateRef = useRef<SentientIdentityState>(normalizedState);
  const reducedMotionRef = useRef(Boolean(motionPreference()?.matches));
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  latestStateRef.current = normalizedState;

  const applyLatest = (): void => {
    const inputs = inputsRef.current;
    if (!inputs.length) return;
    const reducedMotion = inputs.find((input) => input.name === "reducedMotion");
    if (reducedMotion) reducedMotion.value = reducedMotionRef.current;
    inputs.find((input) => input.name === TRIGGERS[latestStateRef.current])?.fire();
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let active = true;
    let instance: RiveAdapter | null = null;
    const onLoad = (): void => {
      queueMicrotask(() => {
        if (!active || !instance) return;
        instanceRef.current = instance;
        inputsRef.current = instance.stateMachineInputs("Avatar");
        instance.resizeDrawingSurfaceToCanvas();
        setLoaded(true);
        applyLatest();
      });
    };
    const onLoadError = (): void => {
      if (active) setFailed(true);
    };
    try {
      instance = riveFactory({
        src: "/assets/sentient-avatar.riv",
        canvas,
        artboard: "SentientAvatar",
        stateMachines: "Avatar",
        autoplay: true,
        onLoad,
        onLoadError,
      });
    } catch {
      setFailed(true);
    }
    const resize = (): void => instance?.resizeDrawingSurfaceToCanvas();
    window.addEventListener("resize", resize);
    return () => {
      active = false;
      window.removeEventListener("resize", resize);
      inputsRef.current = [];
      instanceRef.current = null;
      instance?.cleanup();
    };
  }, [riveFactory]);

  useEffect(() => {
    latestStateRef.current = normalizedState;
    applyLatest();
  }, [normalizedState]);

  useEffect(() => {
    const query = motionPreference();
    if (!query) return;
    const update = (): void => {
      reducedMotionRef.current = query.matches;
      applyLatest();
    };
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  const status = normalizedState === "idle" ? `${label} is idle` : `${label} is ${normalizedState}`;
  return (
    <span class={`sentient-identity${className ? ` ${className}` : ""}`} style={{ width: `${size}px`, height: `${size}px` }} role="status" aria-label={status}>
      {!failed && <canvas ref={canvasRef} class="sentient-identity__canvas" width={size} height={size} aria-hidden="true" />}
      {(failed || !loaded) && <img class="sentient-identity__fallback" src="/sentient-mark.svg" width={size} height={size} alt="" aria-hidden="true" />}
      <span class="sr-only" aria-live="polite">{status}</span>
    </span>
  );
}
