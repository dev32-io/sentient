import type { CaptureIntentHandler, CaptureStartMode } from "./composer-api.ts";

/** Internal transport mode kept behind the composer boundary. */
export type LegacyCaptureMode = "manual" | "semantic";

/**
 * Identified operations are intentionally private to the dock adapter. The
 * current Web SDK still requires an id for terminalization, while the product
 * API above speaks only in semantic intents.
 */
export interface CapturePort {
  start(mode: CaptureStartMode): Promise<string>;
  commit(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
  auto(id: string, shouldContinue?: () => boolean): Promise<string | null>;
  invalidate(id: string): void;
}

export interface LegacyCaptureSource {
  readonly kind: "legacy";
  readonly onStart: (mode: LegacyCaptureMode) => Promise<string>;
  readonly onCommit: (id: string) => Promise<void>;
  readonly onCancel: (id: string) => Promise<void>;
}

export interface SemanticCaptureSource {
  readonly kind: "semantic";
  readonly onIntent: CaptureIntentHandler;
}

export type CaptureSource = LegacyCaptureSource | SemanticCaptureSource;

function resolve<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    // Invoke before Promise adoption so a host can perform a browser-gesture
    // unlock synchronously in its start handler.
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
}

function modeForLegacy(mode: CaptureStartMode): LegacyCaptureMode {
  return mode === "hold" ? "manual" : "semantic";
}

function isCurrent(current: string | null, id: string): boolean {
  return current === id;
}

/**
 * Adapt either the current identified Web SDK callbacks or the new semantic
 * host callback to the private port consumed by VoiceCaptureControl.
 *
 * `getSource` is read for every operation so the stable adapter can survive a
 * parent rerender without dropping an in-flight capture identity.
 */
export function createCapturePort(getSource: () => CaptureSource): CapturePort {
  let semanticSequence = 0;
  let semanticGeneration = 0;
  let semanticCurrent: string | null = null;

  function nextSemanticId(): string {
    semanticSequence += 1;
    return `composer-capture-${semanticSequence}`;
  }

  return {
    start(mode) {
      const source = getSource();
      if (source.kind === "legacy") return resolve(() => source.onStart(modeForLegacy(mode)));

      // A new start invalidates a stale semantic identity before the host is
      // called. VoiceCaptureControl separately prevents concurrent starts.
      const generation = ++semanticGeneration;
      semanticCurrent = null;
      const id = nextSemanticId();
      return resolve(() => source.onIntent({ type: "start", mode })).then(() => {
        if (generation === semanticGeneration) semanticCurrent = id;
        return id;
      });
    },

    commit(id) {
      const source = getSource();
      if (source.kind === "legacy") return resolve(() => source.onCommit(id));
      if (!isCurrent(semanticCurrent, id)) return Promise.resolve();
      ++semanticGeneration;
      semanticCurrent = null;
      return resolve(() => source.onIntent({ type: "commit" }));
    },

    cancel(id) {
      const source = getSource();
      if (source.kind === "legacy") return resolve(() => source.onCancel(id));
      if (!isCurrent(semanticCurrent, id)) return Promise.resolve();
      ++semanticGeneration;
      semanticCurrent = null;
      return resolve(() => source.onIntent({ type: "cancel" }));
    },

    auto(id, shouldContinue) {
      const source = getSource();
      if (source.kind === "legacy") {
        return resolve(() => source.onCommit(id)).then(() => {
          if (shouldContinue && !shouldContinue()) return null;
          return source.onStart("semantic");
        });
      }
      if (!isCurrent(semanticCurrent, id)) return Promise.resolve(null);
      const generation = ++semanticGeneration;
      semanticCurrent = null;
      return resolve(() => source.onIntent({ type: "auto" })).then(() => {
        const next = nextSemanticId();
        if (generation === semanticGeneration) semanticCurrent = next;
        return next;
      });
    },

    invalidate(id) {
      if (semanticCurrent !== id) return;
      ++semanticGeneration;
      semanticCurrent = null;
    },
  };
}

export function semanticSource(onIntent: CaptureIntentHandler): SemanticCaptureSource {
  return { kind: "semantic", onIntent };
}

export function legacySource(source: Omit<LegacyCaptureSource, "kind">): LegacyCaptureSource {
  return { kind: "legacy", ...source };
}
