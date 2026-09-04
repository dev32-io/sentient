import type { JSX } from "preact";

/**
 * Product-local composer composition. Shared tokens still own palette, type,
 * spacing, and motion; this sheet owns the approved asymmetric face, joined
 * task shelf, purpose-built keys, and capture pod/crown anatomy.
 */
export const DOCK_STYLES = `
.dock-composer {
  --dock-target-size: 44px;
  --dock-live-width: 238px;
  --dock-live-width-narrow: 198px;
  --dock-live-height: 54px;
  --dock-focus-width: 2px;
  width: 100%;
  display: flex;
  justify-content: center;
  padding: var(--space-xl) var(--space-lg) var(--space-lg);
  background: transparent;
}
.dock-composer__inner {
  width: 100%;
  max-width: 900px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}
.dock-composer__frame {
  position: relative;
  min-width: 0;
  filter: drop-shadow(0 22px 24px color-mix(in oklab, var(--color-bg-sunk) 82%, transparent));
}
.dock-composer__surface {
  position: relative;
  z-index: 2;
  min-width: 0;
  display: grid;
  gap: 10px;
  padding: var(--space-md);
  overflow: visible;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  background:
    radial-gradient(
      ellipse 72% 115% at 50% 52%,
      color-mix(in oklab, var(--color-paper) 74%, var(--color-bg-sunk)) 0%,
      transparent 70%
    ),
    radial-gradient(
      circle at 84% 8%,
      color-mix(in oklab, var(--color-accent) 5%, transparent) 0%,
      transparent 34%
    ),
    linear-gradient(
      118deg,
      color-mix(in oklab, var(--color-paper) 94%, var(--color-ink-4)) 0%,
      var(--color-paper) 48%,
      color-mix(in oklab, var(--color-paper) 96%, var(--color-accent-soft)) 100%
    );
  box-shadow:
    var(--slate-top-light),
    0 2px 0 -1px var(--color-bg-sunk),
    0 18px 32px -20px color-mix(in oklab, var(--color-bg-sunk) 94%, transparent),
    4px 19px 32px -25px color-mix(in oklab, var(--color-accent) 48%, transparent);
  cursor: text;
  transition: border-color var(--motion-state), box-shadow var(--motion-state);
}
.dock-composer__surface::after {
  content: "";
  position: absolute;
  z-index: 0;
  inset: 1px;
  border-radius: calc(var(--radius-lg) - 1px);
  background:
    linear-gradient(
      108deg,
      transparent 0 40%,
      color-mix(in oklab, var(--color-ink) 2.4%, transparent) 49%,
      transparent 58%
    ),
    radial-gradient(
      ellipse 44% 56% at 82% 112%,
      color-mix(in oklab, var(--color-accent) 8%, transparent),
      transparent 72%
    );
  opacity: 0.62;
  pointer-events: none;
}
.dock-composer__surface:focus-within {
  border-color: color-mix(in oklab, var(--color-accent) 46%, var(--color-line));
  box-shadow:
    var(--slate-top-light),
    0 2px 0 -1px var(--color-bg-sunk),
    0 18px 32px -20px color-mix(in oklab, var(--color-bg-sunk) 94%, transparent),
    4px 19px 32px -20px color-mix(in oklab, var(--color-accent) 64%, transparent);
}
.dock-composer__surface[data-voice-state="hold"],
.dock-composer__surface[data-voice-state="auto"] {
  border-color: color-mix(in oklab, var(--color-accent) 44%, var(--color-line));
}
.dock-composer__surface[data-voice-state="auto"] {
  border-color: color-mix(in oklab, var(--color-sage) 42%, var(--color-line));
}
.dock-composer__surface[data-voice-state="reconnect-disabled"] {
  border-color: color-mix(in oklab, var(--color-warn) 52%, var(--color-line));
}
.dock-composer__surface > :not(style) {
  position: relative;
  z-index: 1;
}
.dock-composer__draft {
  width: 100%;
  min-height: 52px;
  max-height: 132px;
  display: block;
  padding: var(--space-xs) 5px;
  overflow-y: auto;
  border: 0;
  outline: 0;
  resize: none;
  field-sizing: content;
  background: transparent;
  color: var(--color-ink);
  font: 16px / var(--line-height-normal) var(--font-ui);
  transition: height 180ms cubic-bezier(.16, 1, .3, 1), opacity var(--motion-feedback), transform var(--motion-state), color var(--motion-feedback);
}
.snt-surface .dock-composer__draft:focus-visible {
  border: 0;
  outline: 0;
  outline-offset: 0;
  box-shadow: none;
}
.dock-composer__draft::placeholder {
  color: var(--color-ink-3);
}
.dock-composer__draft--receded {
  opacity: 0.08;
  pointer-events: none;
  transform: translateY(3px);
}
.dock-composer__actions {
  position: relative;
  z-index: 3;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}
.dock-composer__grow {
  min-width: 0;
  flex: 1 1 auto;
}
.dock-composer__end-actions {
  min-width: 0;
  max-width: 100%;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-sm);
  transition: gap var(--motion-state);
}
.dock-composer__end-actions--held {
  gap: 0;
}
.dock-composer-control {
  --composer-key: color-mix(in oklab, var(--color-paper) 91%, var(--color-ink-2));
  position: relative;
  width: var(--dock-target-size);
  height: var(--dock-target-size);
  min-width: var(--dock-target-size);
  min-height: var(--dock-target-size);
  display: inline-grid;
  place-items: center;
  padding: 0;
  appearance: none;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background:
    radial-gradient(
      ellipse 82% 105% at 50% 52%,
      color-mix(in oklab, var(--composer-key) 78%, var(--color-bg-sunk)) 0%,
      color-mix(in oklab, var(--composer-key) 90%, var(--color-bg-sunk)) 50%,
      var(--composer-key) 100%
    );
  color: var(--color-ink);
  box-shadow: var(--slate-shadow);
  cursor: pointer;
  transform: translateY(0);
  transition: background var(--motion-feedback), color var(--motion-feedback), border-color var(--motion-feedback), box-shadow var(--motion-state), transform 90ms ease, opacity var(--motion-feedback);
}
@media (hover: hover) and (pointer: fine) {
  .dock-composer-control:hover:not(:disabled) {
    border-color: transparent;
    color: var(--color-ink);
    box-shadow: var(--slate-shadow-hover);
    transform: translateY(-1px);
  }
}
.snt-surface .dock-composer-control:focus-visible {
  outline: var(--dock-focus-width) solid var(--color-accent);
  outline-offset: 3px;
}
.dock-composer-control:active:not(:disabled) {
  box-shadow: var(--slate-shadow-pressed);
  transform: translateY(1px);
  transition-duration: 70ms;
}
.dock-composer-control:disabled {
  --composer-key: color-mix(in oklab, var(--color-bg-elev) 92%, var(--color-ink-4));
  border-color: color-mix(in oklab, var(--color-line-soft) 74%, var(--color-bg));
  background: var(--slate-face-muted);
  color: var(--color-ink-3);
  box-shadow: var(--slate-shadow-disabled);
  cursor: not-allowed;
  opacity: 1;
  transform: none;
}
.dock-composer-control--primary,
.dock-composer__tts--enabled {
  --composer-key: var(--color-accent);
  color: var(--color-bg-sunk);
  box-shadow:
    var(--slate-top-light),
    0 2px 0 -1px var(--color-bg-sunk),
    0 12px 18px -12px color-mix(in oklab, var(--color-accent) 66%, transparent);
}
.dock-composer__tts--enabled::after {
  content: "";
  position: absolute;
  inset-block-start: var(--space-xs);
  inset-inline-end: var(--space-xs);
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-ink);
  box-shadow: 0 0 0 2px var(--color-accent);
}
.dock-composer-control--stop {
  --composer-key: color-mix(in oklab, var(--color-paper) 50%, var(--color-stop));
  color: var(--color-ink);
  box-shadow:
    var(--slate-top-light),
    0 2px 0 -1px color-mix(in oklab, var(--color-stop) 38%, var(--color-bg-sunk)),
    0 12px 18px -12px color-mix(in oklab, var(--color-stop) 62%, transparent);
}
.dock-composer__interrupt {
  width: var(--dock-target-size);
  min-width: var(--dock-target-size);
  min-height: var(--dock-target-size);
  display: inline-flex;
  overflow: visible;
  opacity: 1;
  transform: translateY(0) scale(1);
  transition: opacity var(--motion-feedback), transform var(--motion-state), width var(--motion-state), min-width var(--motion-state);
}
.dock-composer__interrupt--receded {
  width: 0;
  min-width: 0;
  overflow: hidden;
  opacity: 0;
  transform: translateY(var(--space-xs)) scale(0.82);
  pointer-events: none;
}
.dock-interrupt-button__glyph {
  width: var(--space-sm);
  height: var(--space-sm);
  border: 1.5px solid currentColor;
  border-radius: 2px;
}
.dock-composer__surface[data-voice-state="hold"] .dock-composer__attachment,
.dock-composer__surface[data-voice-state="hold"] .dock-composer__tts {
  opacity: 0;
  pointer-events: none;
  transform: translateY(var(--space-xs)) scale(0.86);
}
.dock-composer__connection {
  justify-self: start;
  padding: var(--space-xs) var(--space-md);
  border: 1px solid color-mix(in oklab, var(--color-warn) 28%, var(--color-line-soft));
  border-radius: var(--radius-pill);
  background: color-mix(in oklab, var(--color-accent-soft) 72%, var(--color-bg-sunk));
  color: var(--color-ink-2);
  font: var(--font-size-sm) / var(--line-height-tight) var(--font-ui);
}
.dock-composer__connection--flash {
  background: var(--color-warn);
  color: var(--color-bg-sunk);
}

.dock-composer__frame > .dock-task-shelf {
  position: relative;
  z-index: 1;
  margin: 0 var(--space-lg) -1px;
  padding: 7px 7px var(--space-sm);
  overflow: hidden;
  border: 1px solid color-mix(in oklab, var(--color-line) 86%, var(--color-bg-sunk));
  border-block-end: 0;
  border-radius: 14px 14px 0 0;
  background: color-mix(in oklab, var(--color-bg-sunk) 86%, var(--color-paper));
  box-shadow:
    inset 0 1px 0 color-mix(in oklab, var(--color-ink) 5%, transparent),
    0 -9px 18px -17px color-mix(in oklab, var(--color-bg-sunk) 94%, transparent);
}
.dock-composer__frame > .dock-task-shelf::after {
  content: "";
  position: absolute;
  z-index: 0;
  inset-inline: -1px;
  inset-block-end: -9px;
  height: 10px;
  border-inline: 1px solid var(--color-line);
  background: color-mix(in oklab, var(--color-bg-sunk) 86%, var(--color-paper));
  pointer-events: none;
}
.dock-task-shelf {
  width: auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  container-type: inline-size;
}
.dock-task-shelf__pills {
  position: relative;
  z-index: 1;
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  overflow-x: auto;
  scrollbar-width: none;
}
.dock-task-shelf__pills::-webkit-scrollbar {
  display: none;
}
.dock-task-pill {
  flex: 0 0 auto;
  min-width: 0;
  min-height: var(--dock-target-size);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  padding: 0 var(--space-md);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-ink-2);
  box-shadow: none;
  font: 500 14px / var(--line-height-tight) var(--font-ui);
  white-space: nowrap;
  transition: background var(--motion-feedback), color var(--motion-feedback), border-color var(--motion-feedback), box-shadow var(--motion-feedback);
}
@media (hover: hover) and (pointer: fine) {
  .dock-task-pill:hover {
    background: color-mix(in oklab, var(--color-paper) 66%, var(--color-bg-sunk));
    color: var(--color-ink);
  }
}
.snt-surface .dock-task-pill:focus-visible {
  outline: var(--dock-focus-width) solid var(--color-accent);
  outline-offset: -1px;
}
.dock-task-pill[aria-expanded="true"] {
  background: color-mix(in oklab, var(--color-paper) 79%, var(--color-bg-sunk));
  border-color: color-mix(in oklab, var(--color-line) 88%, var(--color-bg-sunk));
  color: var(--color-ink);
  box-shadow:
    inset 0 1px 0 color-mix(in oklab, var(--color-ink) 8%, transparent),
    0 2px 0 color-mix(in oklab, var(--color-bg-sunk) 76%, var(--color-line)),
    0 6px 10px -9px color-mix(in oklab, var(--color-bg-sunk) 92%, transparent);
}
.dock-task-pill__name {
  min-width: 0;
  overflow: hidden;
  color: inherit;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dock-task-pill__dot {
  position: relative;
  width: 10px;
  height: 10px;
  flex: 0 0 auto;
  box-sizing: border-box;
  border: 2px solid currentColor;
  background: transparent;
  color: var(--color-ink-4);
}
.dock-task-pill__dot--running {
  border-radius: 50%;
  color: var(--color-amber);
  box-shadow: 0 0 0 var(--space-xs) color-mix(in oklab, var(--color-amber) 16%, transparent);
  animation: dock-task-pulse 1.45s ease-in-out infinite;
}
.dock-task-pill__dot--running::after {
  content: "";
  position: absolute;
  inset: 2px;
  border-radius: 50%;
  background: currentColor;
}
.dock-task-pill__dot--done {
  border-radius: 50%;
  color: var(--color-sage);
  background: color-mix(in oklab, var(--color-sage) 18%, transparent);
}
.dock-task-pill__dot--done::after {
  content: "";
  position: absolute;
  inset-block-start: -1px;
  inset-inline-start: 2px;
  width: 3px;
  height: 5px;
  border-inline-end: 2px solid currentColor;
  border-block-end: 2px solid currentColor;
  transform: rotate(45deg);
}
.dock-task-pill__dot--error {
  border-radius: 2px;
  color: var(--color-stop);
  background: color-mix(in oklab, var(--color-stop) 16%, transparent);
  box-shadow: 0 0 var(--space-sm) color-mix(in oklab, var(--color-stop) 48%, transparent);
}
.dock-task-pill__dot--error::before,
.dock-task-pill__dot--error::after {
  content: "";
  position: absolute;
  inset-block-start: 2px;
  inset-inline-start: 0;
  width: 6px;
  height: 2px;
  background: currentColor;
}
.dock-task-pill__dot--error::before {
  transform: rotate(45deg);
}
.dock-task-pill__dot--error::after {
  transform: rotate(-45deg);
}
.dock-task-shelf .tool-inline-detail {
  position: relative;
  z-index: 1;
  display: grid;
  gap: var(--space-xs);
  margin-block-start: 7px;
  padding: var(--space-md) 13px;
  border: 1px solid var(--color-line-soft);
  border-radius: var(--radius-sm);
  background: color-mix(in oklab, var(--color-paper) 72%, var(--color-bg-sunk));
  color: var(--color-ink);
  box-shadow: var(--plate-shadow);
}
.dock-task-shelf .tool-inline-detail__label {
  display: block;
  color: var(--color-ink-3);
  font: 500 var(--font-size-sm) / var(--line-height-tight) var(--font-mono);
}
.dock-task-shelf .tool-inline-detail__preview {
  display: block;
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--color-ink-2);
  font: var(--font-size-sm) / var(--line-height-normal) var(--font-mono);
  white-space: pre-wrap;
}
@keyframes dock-task-pulse {
  50% { opacity: 0.55; transform: scale(0.72); }
}

.dock-suggestions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
  padding: 0;
  margin-block-start: var(--space-xs);
}
.dock-suggestions .snt-chip {
  min-height: var(--dock-target-size);
  white-space: nowrap;
}

.dock-voice-capture .sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  border: 0;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}
.dock-voice-capture__hold-access:focus-visible {
  position: absolute;
  inset-block-end: calc(100% + var(--space-xs));
  inset-inline-end: 0;
  z-index: 8;
  width: auto;
  height: var(--dock-target-size);
  min-width: var(--dock-target-size);
  min-height: var(--dock-target-size);
  margin: 0;
  padding: 0 var(--space-md);
  overflow: visible;
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  clip: auto;
  background: var(--slate-face);
  color: var(--color-ink);
  box-shadow: var(--slate-shadow);
  font: 500 14px / var(--line-height-tight) var(--font-ui);
  white-space: nowrap;
}
.dock-voice-capture {
  --dock-target-size: 44px;
  --dock-live-width: 238px;
  --dock-live-width-narrow: 198px;
  --dock-live-height: 54px;
  --dock-focus-width: 2px;
  --dock-voice-width: var(--dock-live-width);
  position: relative;
  isolation: isolate;
  width: var(--dock-target-size);
  height: var(--dock-target-size);
  min-width: 0;
  max-width: 100%;
  flex: 0 0 var(--dock-target-size);
  transition: width var(--motion-state), flex-basis var(--motion-state), height var(--motion-state);
}
.dock-voice-capture:is(.dock-voice-capture--hold, .dock-voice-capture--auto, .dock-voice-capture--transitioning) {
  width: min(var(--dock-voice-width), 100%);
  height: var(--dock-live-height);
  flex-basis: var(--dock-voice-width);
}
.dock-voice-capture--auto::before {
  content: "";
  position: absolute;
  z-index: 0;
  inset: -5px;
  border: 1px solid color-mix(in oklab, var(--color-sage) 52%, transparent);
  border-radius: 19px 11px 19px 19px;
  opacity: 0.72;
  animation: dock-auto-orbit var(--motion-responding-cadence) infinite;
  pointer-events: none;
}
@keyframes dock-auto-orbit {
  50% { opacity: 0.34; transform: scale(1.04); }
}
.dock-voice-capture__primary {
  --voice-key: color-mix(in oklab, var(--color-paper) 91%, var(--color-ink-2));
  position: absolute;
  inset-block-end: 0;
  inset-inline-end: 0;
  z-index: 6;
  width: var(--dock-target-size);
  height: var(--dock-target-size);
  min-width: var(--dock-target-size);
  min-height: var(--dock-target-size);
  display: block;
  overflow: hidden;
  padding: 0;
  appearance: none;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background:
    radial-gradient(
      ellipse 82% 105% at 50% 52%,
      color-mix(in oklab, var(--voice-key) 78%, var(--color-bg-sunk)) 0%,
      color-mix(in oklab, var(--voice-key) 90%, var(--color-bg-sunk)) 52%,
      var(--voice-key) 100%
    );
  color: var(--color-ink);
  box-shadow: var(--slate-shadow);
  cursor: pointer;
  touch-action: none;
  user-select: none;
  transform: translateY(0);
  transition: width var(--motion-state), height var(--motion-state), border-radius var(--motion-state), background var(--motion-feedback), color var(--motion-feedback), box-shadow var(--motion-state), transform 90ms ease;
}
@media (hover: hover) and (pointer: fine) {
  .dock-voice-capture__primary:hover:not(:disabled) {
    box-shadow: var(--slate-shadow-hover);
    transform: translateY(-1px);
  }
}
.snt-surface .dock-voice-capture__primary:focus-visible,
.snt-surface .dock-voice-capture__choice:focus-visible {
  outline: var(--dock-focus-width) solid var(--color-accent);
  outline-offset: 3px;
}
.dock-voice-capture__primary:active:not(:disabled) {
  box-shadow: var(--slate-shadow-pressed);
  transform: translateY(1px);
  transition-duration: 70ms;
}
.dock-voice-capture__primary:disabled {
  --voice-key: color-mix(in oklab, var(--color-bg-elev) 92%, var(--color-ink-4));
  border-color: color-mix(in oklab, var(--color-line-soft) 74%, var(--color-bg));
  background: var(--slate-face-muted);
  color: var(--color-ink-4);
  box-shadow: var(--slate-shadow-disabled);
  cursor: not-allowed;
  opacity: 1;
}
.dock-voice-capture[data-tone="error"] .dock-voice-capture__primary {
  border-color: color-mix(in oklab, var(--color-stop) 72%, var(--color-line));
  color: color-mix(in oklab, var(--color-stop) 72%, var(--color-ink));
  box-shadow: var(--slate-shadow), 4px 12px 18px -14px color-mix(in oklab, var(--color-stop) 60%, transparent);
}
.dock-voice-capture:is(.dock-voice-capture--hold, .dock-voice-capture--transitioning) .dock-voice-capture__primary {
  --voice-key: color-mix(in oklab, var(--color-paper) 88%, var(--color-accent-soft));
  width: 100%;
  height: var(--dock-live-height);
  border-radius: 18px 11px 11px 18px;
  box-shadow:
    var(--slate-top-light),
    0 2px 0 -1px var(--color-bg-sunk),
    0 13px 22px -12px color-mix(in oklab, var(--color-bg-sunk) 92%, transparent),
    4px 15px 24px -12px color-mix(in oklab, var(--color-accent) 68%, transparent);
}
.dock-voice-capture--auto .dock-voice-capture__primary {
  --voice-key: color-mix(in oklab, var(--color-paper) 52%, var(--color-sage));
  width: 100%;
  height: var(--dock-live-height);
  border-color: color-mix(in oklab, var(--color-sage) 28%, var(--color-line));
  border-radius: 18px 10px 15px 18px;
  color: var(--color-bg-sunk);
  box-shadow:
    var(--slate-top-light),
    0 2px 0 -1px var(--color-bg-sunk),
    0 11px 18px -11px color-mix(in oklab, var(--color-bg-sunk) 90%, transparent),
    4px 14px 24px -13px color-mix(in oklab, var(--color-sage) 58%, transparent);
}
.dock-voice-capture__glyph {
  position: absolute;
  z-index: 3;
  inset-block-start: 50%;
  inset-inline-start: 50%;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  transform: translate(-50%, -50%);
  transition: inset-inline-start var(--motion-state), transform var(--motion-state);
}
.dock-voice-capture__glyph svg {
  opacity: 1;
  transform: rotate(0) scale(1);
  transition: opacity 130ms ease, transform var(--motion-state);
}
.dock-voice-capture__glyph::after {
  content: "";
  position: absolute;
  width: var(--space-sm);
  height: var(--space-sm);
  border-radius: 50%;
  background: var(--color-accent);
  box-shadow: none;
  opacity: 0;
  transform: rotate(0) scale(0.4);
  transition: opacity 120ms ease, width var(--motion-state), height var(--motion-state), border-radius var(--motion-state), transform var(--motion-state), box-shadow var(--motion-state);
}
.dock-voice-capture:is(.dock-voice-capture--hold, .dock-voice-capture--auto, .dock-voice-capture--transitioning) .dock-voice-capture__glyph {
  inset-inline-start: calc(100% - 27px);
}
.dock-voice-capture:is(.dock-voice-capture--hold, .dock-voice-capture--transitioning) .dock-voice-capture__glyph svg {
  opacity: 0;
  transform: rotate(-70deg) scale(0.28);
}
.dock-voice-capture:is(.dock-voice-capture--hold, .dock-voice-capture--transitioning) .dock-voice-capture__glyph::after {
  width: 11px;
  height: 11px;
  border-radius: 3px;
  opacity: 1;
  transform: rotate(45deg) scale(1);
  box-shadow:
    0 0 0 5px color-mix(in oklab, var(--color-accent) 13%, transparent),
    0 0 15px color-mix(in oklab, var(--color-accent) 56%, transparent);
}
.dock-voice-capture__wave {
  position: absolute;
  z-index: 2;
  inset-block-start: 50%;
  inset-inline: 18px 55px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-xs);
  transform: translateY(-50%);
}
.dock-voice-capture__wave i {
  --dock-wave-rest: 0.34;
  width: 3px;
  height: var(--space-lg);
  border-radius: var(--radius-pill);
  background: linear-gradient(180deg, var(--color-accent), color-mix(in oklab, var(--color-accent) 54%, var(--color-accent-soft)));
  box-shadow: 0 0 var(--space-sm) -3px color-mix(in oklab, var(--color-accent) 58%, transparent);
  transform: scaleY(var(--dock-wave-rest));
  animation: dock-voice-wave 760ms ease-in-out infinite alternate;
}
.dock-voice-capture__wave i:nth-child(2n) {
  --dock-wave-rest: 0.72;
  animation-delay: -210ms;
}
.dock-voice-capture__wave i:nth-child(3n) {
  --dock-wave-rest: 0.52;
  animation-delay: -430ms;
}
.dock-voice-capture__wave i:nth-child(5n) {
  --dock-wave-rest: 0.88;
  animation-delay: -590ms;
}
.dock-voice-capture--auto .dock-voice-capture__wave i {
  background: linear-gradient(180deg, var(--color-sage), color-mix(in oklab, var(--color-sage) 58%, var(--color-bg-elev)));
  box-shadow: 0 0 var(--space-sm) -3px color-mix(in oklab, var(--color-sage) 58%, transparent);
}
@keyframes dock-voice-wave {
  to { opacity: 0.62; transform: scaleY(1); }
}
.dock-voice-capture__fan {
  --dock-seam-index: 2;
  --dock-seam-color: var(--color-accent);
  position: absolute;
  z-index: 4;
  inset-block-end: calc(100% - var(--space-sm));
  inset-inline-end: 0;
  width: 100%;
  min-width: 0;
  height: 58px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  padding: 0;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  filter: drop-shadow(0 11px 10px color-mix(in oklab, var(--color-bg-sunk) 70%, transparent));
  transform: perspective(420px) translateY(17px) rotateX(-74deg) scaleX(0.88);
  transform-origin: 50% 100%;
  transform-style: preserve-3d;
  transition: opacity 130ms ease, transform var(--motion-state), visibility 0s linear var(--motion-state);
}
.dock-voice-capture__fan[data-target="auto"] {
  --dock-seam-index: 0;
  --dock-seam-color: var(--color-sage);
}
.dock-voice-capture__fan[data-target="cancel"] {
  --dock-seam-index: 1;
  --dock-seam-color: var(--color-stop);
}
.dock-voice-capture__fan::before {
  content: "";
  position: absolute;
  z-index: 3;
  inset-block-end: 1px;
  inset-inline-start: calc((100% / 3) * var(--dock-seam-index) + var(--space-sm));
  width: calc(100% / 3 - var(--space-lg));
  height: 3px;
  border-radius: var(--radius-pill);
  background: linear-gradient(90deg, transparent, var(--dock-seam-color), transparent);
  box-shadow: 0 0 var(--space-md) color-mix(in oklab, var(--dock-seam-color) 55%, transparent);
  transition: inset-inline-start 210ms cubic-bezier(.16, 1, .3, 1);
  pointer-events: none;
}
.dock-voice-capture__fan::after {
  content: "";
  position: absolute;
  z-index: 0;
  inset-inline: 5px;
  inset-block-end: 0;
  height: 15px;
  border-radius: var(--radius-sm) var(--radius-sm) 3px 3px;
  background: linear-gradient(180deg, color-mix(in oklab, var(--color-paper) 88%, var(--color-line)), color-mix(in oklab, var(--color-paper) 68%, var(--color-bg-sunk)));
  box-shadow:
    inset 0 2px 5px -3px color-mix(in oklab, var(--color-bg-sunk) 88%, transparent),
    0 2px 0 -1px var(--color-bg-sunk);
  pointer-events: none;
}
.dock-voice-capture__fan--open {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transform: perspective(420px) translateY(0) rotateX(0) scaleX(1);
  transition: opacity 130ms ease, transform var(--motion-state), visibility 0s;
}
.dock-voice-capture__choice {
  --voice-choice-key: color-mix(in oklab, var(--color-paper) 94%, var(--color-bg-elev));
  position: relative;
  z-index: 1;
  min-width: 0;
  min-height: 50px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 0 7px 7px;
  appearance: none;
  border: 0;
  border-radius: 14px 14px 7px 7px;
  background:
    radial-gradient(
      ellipse 90% 118% at 50% 58%,
      color-mix(in oklab, var(--voice-choice-key) 74%, var(--color-bg-sunk)),
      var(--voice-choice-key)
    );
  color: var(--color-ink-2);
  box-shadow:
    inset 0 1px 0 color-mix(in oklab, var(--color-ink) 8%, transparent),
    inset -1px 0 0 color-mix(in oklab, var(--color-line) 72%, transparent);
  font: 600 14px / var(--line-height-tight) var(--font-ui);
  opacity: 0;
  cursor: pointer;
  transform: translateY(16px) scaleY(0.72);
  transform-origin: 50% 100%;
  transition: opacity 120ms ease, transform var(--motion-state), color var(--motion-feedback), filter var(--motion-feedback), background var(--motion-feedback), box-shadow var(--motion-feedback);
}
.dock-voice-capture__choice::after {
  content: "";
  position: absolute;
  inset-block-start: 2px;
  inset-inline: 17%;
  height: 1px;
  background: linear-gradient(90deg, transparent, color-mix(in oklab, var(--color-ink) 14%, transparent), transparent);
  opacity: 0.7;
  pointer-events: none;
}
.dock-voice-capture__choice--auto {
  --voice-choice-key: color-mix(in oklab, var(--color-paper) 82%, var(--color-sage-soft));
  border-radius: 20px 11px 7px 16px;
  color: color-mix(in oklab, var(--color-ink-2) 82%, var(--color-sage));
  transition-delay: 0ms;
}
.dock-voice-capture__choice--cancel {
  transition-delay: 34ms;
}
.dock-voice-capture__choice--send {
  border-radius: 11px 20px 16px 7px;
  transition-delay: 68ms;
}
.dock-voice-capture__fan--open .dock-voice-capture__choice {
  opacity: 1;
  transform: translateY(0) scaleY(1);
}
.dock-voice-capture__choice.is-selected {
  --voice-choice-key: var(--color-accent);
  color: var(--color-bg-sunk);
  filter: drop-shadow(0 8px 9px color-mix(in oklab, var(--color-accent) 30%, var(--color-bg-sunk)));
  transform: translateY(-5px) scale(1.015);
}
.dock-voice-capture__choice--auto.is-selected {
  --voice-choice-key: color-mix(in oklab, var(--color-sage) 78%, var(--color-paper));
  color: var(--color-bg-sunk);
  filter: drop-shadow(0 8px 9px color-mix(in oklab, var(--color-sage) 38%, var(--color-bg-sunk)));
}
.dock-voice-capture__choice--cancel.is-selected {
  --voice-choice-key: var(--color-stop);
  color: var(--color-ink);
  filter: drop-shadow(0 8px 9px color-mix(in oklab, var(--color-stop) 34%, var(--color-bg-sunk)));
}
.dock-voice-capture__choice:active {
  filter: none;
  transform: translateY(1px) scale(0.985);
  transition-duration: 70ms;
}
@media (hover: hover) and (pointer: fine) {
  .dock-voice-capture__choice:hover:not(.is-selected) {
    color: var(--color-ink);
    filter: drop-shadow(0 7px 8px color-mix(in oklab, var(--color-bg-sunk) 72%, transparent));
    transform: translateY(-4px) scale(1.012);
  }
}

@media (max-width: 860px) {
  .dock-composer {
    padding: var(--space-md) var(--space-lg) var(--space-lg);
  }
}
@media (max-width: 480px) {
  .dock-composer {
    padding: var(--space-md) var(--space-sm) calc(var(--space-sm) + env(safe-area-inset-bottom));
  }
  .dock-composer__surface {
    gap: 7px;
    padding: 9px;
    border-radius: 16px;
  }
  .dock-composer__surface::after {
    border-radius: 15px;
  }
  .dock-composer__draft {
    min-height: 42px;
    max-height: 108px;
    padding: 3px var(--space-xs);
  }
  .dock-composer__actions {
    display: grid;
    grid-template-columns: var(--dock-target-size) var(--dock-target-size) minmax(0, 1fr) auto;
    gap: 6px;
  }
  .dock-composer__end-actions {
    gap: 6px;
  }
  .dock-composer__frame > .dock-task-shelf {
    margin-inline: 10px;
    padding-inline: 5px;
  }
  .dock-task-pill {
    padding-inline: 10px;
  }
  .dock-task-shelf .tool-inline-detail {
    max-height: min(30dvh, 260px);
    padding: var(--space-md);
    overflow-y: auto;
  }
  .dock-voice-capture {
    --dock-voice-width: var(--dock-live-width-narrow);
  }
  .dock-voice-capture__wave {
    inset-inline: 15px 52px;
    gap: 3px;
  }
}
/* The 390px reference fits one exact row; below it the active end controls
   move together so Stop cannot collide with TTS or the voice pod. */
@media (max-width: 389px) {
  .dock-composer__actions:has(.dock-voice-capture--hold, .dock-voice-capture--auto, .dock-voice-capture--transitioning) {
    grid-template-columns: var(--dock-target-size) var(--dock-target-size) minmax(0, 1fr);
  }
  .dock-composer__actions:has(.dock-voice-capture--hold, .dock-voice-capture--auto, .dock-voice-capture--transitioning) .dock-composer__end-actions {
    grid-column: 1 / -1;
    justify-self: end;
  }
}
@media (max-width: 300px) {
  .dock-composer__attachment {
    display: none;
  }
  .dock-composer__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-xs);
  }
  .dock-composer__end-actions {
    max-width: 100%;
  }
  .dock-composer__actions:has(.dock-voice-capture--hold, .dock-voice-capture--auto, .dock-voice-capture--transitioning) .dock-composer__end-actions {
    width: 100%;
  }
  .dock-voice-capture__fan {
    height: 68px;
  }
  .dock-voice-capture__choice {
    min-height: 60px;
    flex-direction: column;
    gap: 1px;
    padding: var(--space-xs) 2px var(--space-sm);
  }
}
@media (prefers-reduced-motion: reduce) {
  .dock-composer__surface,
  .dock-composer__draft,
  .dock-composer-control,
  .dock-composer__end-actions,
  .dock-composer__interrupt,
  .dock-task-pill,
  .dock-voice-capture,
  .dock-voice-capture__primary,
  .dock-voice-capture__glyph,
  .dock-voice-capture__glyph svg,
  .dock-voice-capture__glyph::after,
  .dock-voice-capture__fan,
  .dock-voice-capture__fan::before,
  .dock-voice-capture__choice {
    transition: none;
  }
  .dock-task-pill__dot--running,
  .dock-voice-capture--auto::before,
  .dock-voice-capture__wave i {
    animation: none;
  }
  .dock-task-pill__dot--running {
    box-shadow: none;
  }
  .dock-voice-capture__wave i {
    opacity: 0.82;
    transform: scaleY(var(--dock-wave-rest));
  }
}
@media (prefers-contrast: more), (forced-colors: active) {
  .dock-composer__surface,
  .dock-composer__frame > .dock-task-shelf,
  .dock-task-shelf .tool-inline-detail,
  .dock-composer-control,
  .dock-voice-capture__primary,
  .dock-voice-capture__choice {
    border-color: var(--color-ink-3);
  }
  .dock-task-pill__dot {
    box-shadow: none;
  }
}
`;

export function DockStyleSheet(): JSX.Element {
  return <style data-sentient-dock-style>{DOCK_STYLES}</style>;
}
