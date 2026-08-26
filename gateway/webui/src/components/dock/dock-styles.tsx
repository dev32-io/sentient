import type { JSX } from "preact";

/**
 * Dock-local composition styles. Material faces, wells, shadows, typography,
 * and motion all come from the generated foundation; this sheet owns only the
 * dock's layout and state wiring.
 */
export const DOCK_STYLES = `
.dock-composer {
  --dock-target-size: 44px;
  --dock-live-width: 14.875rem;
  --dock-live-width-narrow: 12.375rem;
  --dock-live-height: 54px;
  --dock-focus-width: 2px;
  width: 100%;
  display: flex;
  justify-content: center;
  padding: var(--space-xl) var(--space-lg) var(--space-lg);
}
.dock-composer__inner {
  width: 100%;
  max-width: 45rem;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}
.dock-composer__frame {
  position: relative;
  min-width: 0;
}
.dock-composer__frame > .dock-task-shelf {
  position: relative;
  z-index: 2;
  margin-inline: var(--space-md);
  margin-block-end: calc(-1 * var(--dock-focus-width));
  overflow: hidden;
  border: 1px solid var(--color-line-soft);
  border-block-end: 0;
  border-radius: var(--radius-md);
  background: var(--color-bg-sunk);
}
.dock-composer__surface {
  position: relative;
  z-index: 1;
  min-width: 0;
  display: grid;
  gap: var(--space-sm);
  padding: var(--space-md);
  overflow: visible;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  background: var(--slate-face);
  box-shadow: var(--float-shadow);
  cursor: text;
  transition: border-color var(--motion-state), box-shadow var(--motion-state);
}
.dock-composer__surface:focus-within {
  border-color: var(--color-accent);
}
.dock-composer__surface[data-voice-state="hold"],
.dock-composer__surface[data-voice-state="auto"] {
  border-color: var(--color-accent);
}
.dock-composer__surface[data-voice-state="reconnect-disabled"] {
  border-color: var(--color-warn);
}
.dock-composer__draft {
  width: 100%;
  min-height: var(--dock-target-size);
  max-height: calc(var(--space-3xl) * 3 + var(--space-xs));
  display: block;
  padding: var(--space-xs) var(--space-xs);
  overflow-y: auto;
  border: 0;
  outline: 0;
  resize: none;
  field-sizing: content;
  background: transparent;
  color: var(--color-ink);
  font: var(--font-size-base) / var(--line-height-relaxed) var(--font-ui);
  transition: opacity var(--motion-feedback), transform var(--motion-state);
}
.dock-composer__draft:focus-visible {
  outline: var(--dock-focus-width) solid var(--color-accent);
  outline-offset: var(--space-xs);
}
.dock-composer__draft::placeholder {
  color: var(--color-ink-3);
}
.dock-composer__draft--receded {
  opacity: 0.08;
  pointer-events: none;
  transform: translateY(var(--space-xs));
}
.dock-composer__actions {
  position: relative;
  z-index: 3;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-sm);
}
.dock-composer__grow {
  flex: 1 1 var(--space-sm);
}
.dock-composer__actions > :is(.dock-composer__attachment, .dock-composer__send, .icon-btn, .dock-composer__interrupt-button),
.dock-composer__actions > .dock-composer__interrupt {
  min-width: var(--dock-target-size);
  min-height: var(--dock-target-size);
}
.dock-composer__attachment,
.dock-composer__send {
  width: var(--dock-target-size);
  min-width: var(--dock-target-size);
  min-height: var(--dock-target-size);
  padding: 0;
}
.dock-composer__attachment:disabled {
  color: var(--color-ink-3);
}
.dock-composer__send {
  --slate-base: var(--color-accent);
}
.dock-composer__send:disabled {
  opacity: 0.45;
}
.dock-composer__interrupt {
  display: inline-flex;
  min-width: var(--dock-target-size);
  transition: opacity var(--motion-feedback), transform var(--motion-state), width var(--motion-state);
}
.dock-composer__interrupt--receded {
  width: 0;
  min-width: 0;
  overflow: hidden;
  opacity: 0;
  transform: scale(0.8);
  pointer-events: none;
}
.dock-composer__connection {
  justify-self: start;
  padding: var(--space-xs) var(--space-md);
  border-radius: var(--radius-pill);
  background: var(--color-accent-soft);
  color: var(--color-ink-2);
  font: var(--font-size-sm) / var(--line-height-tight) var(--font-ui);
}
.dock-composer__connection--flash {
  background: var(--color-warn);
  color: var(--color-bg-sunk);
}

.dock-task-shelf {
  display: flex;
  flex-direction: column;
  width: 100%;
  container-type: inline-size;
}
.dock-task-shelf__pills {
  display: flex;
  align-items: stretch;
  flex-wrap: nowrap;
  width: 100%;
  overflow-x: auto;
  scrollbar-width: thin;
}
.dock-task-pill {
  --slate-base: var(--color-bg-elev);
  flex: 0 0 auto;
  min-width: clamp(7rem, 42cqw, 12.5rem);
  max-width: 12.5rem;
  min-height: var(--dock-target-size);
  padding: var(--space-sm) var(--space-md);
  border: 0;
  border-inline-start: 1px solid var(--color-line-soft);
  border-radius: inherit;
  background: transparent;
  color: var(--color-ink-2);
  font: 600 var(--font-size-sm) / var(--line-height-tight) var(--font-ui);
  box-shadow: none;
  text-align: start;
  transition: background var(--motion-feedback), color var(--motion-feedback);
}
.dock-task-pill:first-child {
  border-inline-start: 0;
}
.dock-task-pill:hover,
.dock-task-pill[aria-expanded="true"] {
  background: var(--color-accent-soft);
  color: var(--color-ink);
}
.dock-task-pill__name {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  color: var(--color-ink);
  font: var(--font-size-sm) / var(--line-height-tight) var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dock-task-pill__icon,
.dock-task-pill__chevron {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
}
.dock-task-pill__icon {
  width: var(--space-lg);
  height: var(--space-lg);
  border-radius: var(--radius-sm);
  background: var(--color-bg-sunk);
  color: var(--color-ink-2);
}
.dock-task-pill__dot {
  width: var(--space-xs);
  height: var(--space-xs);
  flex: 0 0 auto;
  border-radius: var(--radius-pill);
  background: var(--color-ink-4);
}
.dock-task-pill__dot--running {
  border: var(--dock-focus-width) solid var(--color-accent);
  border-inline-end-color: transparent;
  background: transparent;
  animation: dock-task-spin var(--motion-state) infinite;
}
.dock-task-pill__dot--done {
  background: var(--color-ok);
}
.dock-task-pill__dot--error {
  background: var(--color-stop);
}
.dock-task-pill__chevron {
  color: var(--color-ink-4);
  transition: transform var(--motion-feedback), color var(--motion-feedback);
}
.dock-task-pill[aria-expanded="true"] .dock-task-pill__chevron {
  color: var(--color-accent);
  transform: rotate(90deg);
}
.dock-task-shelf .tool-inline-detail {
  padding: var(--space-md) var(--space-lg);
  background: var(--color-accent-soft);
  color: var(--color-ink);
  font: var(--font-size-sm) / var(--line-height-normal) var(--font-mono);
}
.dock-task-shelf .tool-inline-detail__label {
  display: block;
  margin-block-end: var(--space-xs);
  color: var(--color-ink-3);
  font: 500 var(--font-size-xs) / var(--line-height-tight) var(--font-mono);
  text-transform: uppercase;
}
.dock-task-shelf .tool-inline-detail__preview {
  display: block;
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--color-ink-2);
  font: var(--font-size-sm) / var(--line-height-normal) var(--font-mono);
  white-space: pre-wrap;
}
@keyframes dock-task-spin {
  to { transform: rotate(1turn); }
}

.dock-interrupt-button {
  min-width: var(--dock-target-size);
  min-height: var(--dock-target-size);
}
.dock-interrupt-button__glyph {
  width: var(--space-sm);
  height: var(--space-sm);
  border-radius: var(--radius-sm);
  background: currentColor;
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
  z-index: 5;
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
  font: var(--font-size-sm) / var(--line-height-tight) var(--font-ui);
  white-space: nowrap;
}
.dock-voice-capture {
  --dock-target-size: 44px;
  --dock-live-width: 14.875rem;
  --dock-live-width-narrow: 12.375rem;
  --dock-live-height: 54px;
  --dock-focus-width: 2px;
  --dock-voice-target: var(--dock-target-size);
  --dock-voice-width: var(--dock-live-width);
  position: relative;
  width: var(--dock-voice-target);
  height: var(--dock-voice-target);
  min-width: 0;
  flex: 0 1 var(--dock-voice-target);
  transition: width var(--motion-state), flex-basis var(--motion-state), height var(--motion-state);
}
.dock-voice-capture:is(.dock-voice-capture--hold, .dock-voice-capture--auto, .dock-voice-capture--transitioning) {
  width: min(var(--dock-voice-width), 100%);
  height: var(--dock-live-height);
  flex-basis: min(var(--dock-voice-width), 100%);
}
.dock-voice-capture__primary {
  position: absolute;
  inset-block-end: 0;
  inset-inline-end: 0;
  z-index: 4;
  width: var(--dock-voice-target);
  height: var(--dock-voice-target);
  min-width: var(--dock-voice-target);
  min-height: var(--dock-voice-target);
  overflow: hidden;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--slate-face);
  color: var(--color-ink);
  box-shadow: var(--slate-shadow);
  cursor: pointer;
  touch-action: none;
  transition: width var(--motion-state), height var(--motion-state), border-radius var(--motion-state), background var(--motion-feedback), box-shadow var(--motion-feedback);
}
.dock-voice-capture__primary:focus-visible,
.dock-voice-capture__choice:focus-visible {
  outline: var(--dock-focus-width) solid var(--color-accent);
  outline-offset: var(--space-xs);
}
.dock-voice-capture__primary:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.dock-voice-capture[data-tone="error"] .dock-voice-capture__primary {
  border-color: var(--color-stop);
  color: var(--color-stop);
}
.dock-voice-capture[data-tone="disabled"] .dock-voice-capture__primary {
  border-color: var(--color-line-soft);
}
.dock-voice-capture:is(.dock-voice-capture--hold, .dock-voice-capture--auto, .dock-voice-capture--transitioning) .dock-voice-capture__primary {
  width: 100%;
  height: var(--dock-live-height);
  border-radius: var(--radius-lg);
  --slate-base: var(--color-paper);
  background: var(--slate-face-hover);
}
.dock-voice-capture--auto .dock-voice-capture__primary {
  --slate-base: var(--color-sage-soft);
}
.dock-voice-capture__glyph {
  position: absolute;
  inset-block-start: 50%;
  inset-inline-start: 50%;
  display: grid;
  place-items: center;
  transform: translate(-50%, -50%);
  transition: inset-inline-start var(--motion-state), transform var(--motion-state);
}
.dock-voice-capture:is(.dock-voice-capture--hold, .dock-voice-capture--auto, .dock-voice-capture--transitioning) .dock-voice-capture__glyph {
  inset-inline-start: calc(100% - var(--space-lg));
}
.dock-voice-capture__wave {
  position: absolute;
  inset-block-start: 50%;
  inset-inline: var(--space-lg) var(--space-3xl);
  height: var(--space-2xl);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-xs);
  transform: translateY(-50%);
}
.dock-voice-capture__wave i {
  width: var(--space-xs);
  height: var(--space-lg);
  border-radius: var(--radius-pill);
  background: var(--color-accent);
  transform: scaleY(0.35);
  animation: dock-voice-wave var(--motion-responding-cadence) infinite alternate;
}
.dock-voice-capture--auto .dock-voice-capture__wave i {
  background: var(--color-sage);
}
@keyframes dock-voice-wave {
  to { transform: scaleY(1); opacity: 0.62; }
}
.dock-voice-capture__fan {
  position: absolute;
  inset-block-end: calc(100% - var(--space-sm));
  inset-inline-end: 0;
  z-index: 3;
  width: min(var(--dock-voice-width), 100%);
  min-width: 0;
  height: var(--dock-live-height);
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: translateY(var(--space-md));
  transform-origin: 50% 100%;
  transition: opacity var(--motion-feedback), transform var(--motion-state), visibility var(--motion-state);
}
.dock-voice-capture__fan--open {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transform: translateY(0);
  transition-delay: 0s;
}
.dock-voice-capture__choice {
  min-width: 0;
  min-height: var(--dock-target-size);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-xs);
  padding: 0 var(--space-xs);
  border: 1px solid var(--color-line-soft);
  border-radius: var(--radius-sm);
  background: var(--slate-face-muted);
  color: var(--color-ink-2);
  font: 600 var(--font-size-sm) / var(--line-height-tight) var(--font-ui);
  box-shadow: var(--slate-shadow);
  cursor: pointer;
  transition: transform var(--motion-feedback), background var(--motion-feedback), color var(--motion-feedback);
}
.dock-voice-capture__choice + .dock-voice-capture__choice {
  border-inline-start-color: var(--color-line);
}
.dock-voice-capture__choice.is-selected {
  background: var(--color-accent);
  color: var(--color-bg-sunk);
  transform: translateY(calc(-1 * var(--space-xs)));
}
.dock-voice-capture__choice--auto.is-selected {
  background: var(--color-sage);
}
.dock-voice-capture__choice--cancel.is-selected {
  background: var(--color-stop);
  color: var(--color-ink);
}

@media (max-width: 860px) {
  .dock-composer {
    padding: var(--space-md) var(--space-lg) var(--space-lg);
  }
}
@media (max-width: 480px) {
  .dock-composer {
    padding-inline: var(--space-sm);
  }
  .dock-composer__surface {
    padding: var(--space-sm);
    border-radius: var(--radius-md);
  }
  .dock-voice-capture {
    --dock-voice-width: var(--dock-live-width-narrow);
  }
  .dock-task-shelf .tool-inline-detail {
    padding: var(--space-sm) var(--space-md);
  }
  .dock-suggestions {
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .dock-suggestions::-webkit-scrollbar {
    display: none;
  }
  .dock-suggestions .snt-chip {
    flex: 0 0 auto;
  }
}
@media (max-width: 300px) {
  .dock-composer__attachment {
    display: none;
  }
  .dock-composer__actions {
    gap: var(--space-xs);
  }
}
@media (prefers-reduced-motion: reduce) {
  .dock-composer__surface,
  .dock-composer__draft,
  .dock-composer__interrupt,
  .dock-task-pill,
  .dock-task-pill__chevron,
  .dock-voice-capture,
  .dock-voice-capture__primary,
  .dock-voice-capture__glyph,
  .dock-voice-capture__fan,
  .dock-voice-capture__choice {
    transition: none;
  }
  .dock-task-pill__dot--running,
  .dock-voice-capture__wave i {
    animation: none;
  }
  .dock-voice-capture__wave i {
    transform: scaleY(0.62);
  }
}
`;

export function DockStyleSheet(): JSX.Element {
  return <style data-sentient-dock-style>{DOCK_STYLES}</style>;
}
