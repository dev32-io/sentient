# Settings v2 — Dusk Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt the v2 design from `sentient-webui-design-v2/` as the gateway webui's settings page (sidebar + panes + unified Apply bar), apply Dusk + Fraunces+DM tokens app-wide, drop placeholder tabs, and verify the result via a dedicated `/qa-session web settings-page` charter run with up to 3 fix iterations.

**Architecture:** Big-bang rewrite of `gateway/webui/src/components/settings/` namespace in an isolated git worktree on `feature/settings-v2-dusk` off `develop`. New layout: `settings-view.tsx` owns `tab` + `dirty` state; sidebar nav switches active pane; each pane container handles its own data loading via existing API clients (`profile-api`, `auth-api`, `admin-api`, `providers-api`); a docked Apply bar (visible only on Soul-group panes when dirty) ports the existing `apply-machine.ts` FSM, extended for unified Soul.md + personality + profile-field flow. Tokens edited in place (no file moves). Old CSS sections stripped from `components.css`; new CSS lives colocated under `.settings-v2` namespace.

**Tech Stack:** Preact + TypeScript (strict) + Vite, Bun runtime, Vitest + Testing Library, AudioWorklet (untouched), `@sentient/web-sdk` logger.

**Spec:** `docs/superpowers/specs/2026-04-28-settings-v2-dusk-design.md` (commit `9c318ef` + amendments in `da34ebb`).

**Reference visuals:** `sentient-webui-design-v2/screenshots/00-chat-reference.png` … `10-apply-bar-dirty.png` (committed in `da34ebb`). Each pane task references its specific screenshot.

---

## Phase 0 — Worktree setup

### Task 0: Create isolated worktree on `feature/settings-v2-dusk`

**Files:** none (operates on git refs, not files in the repo)

- [ ] **Step 1: Verify clean starting state on `develop`**

```bash
source scripts/env.sh
git status --short
```

Expected: any in-flight edits visible but **no staged changes**. Worktree creation only requires that `develop` itself has the spec + reference assets committed (commits `9c318ef` and `da34ebb`). Unstaged in-flight work in `gateway/src/` is fine — it stays in this main worktree.

- [ ] **Step 2: Invoke `superpowers:using-git-worktrees` skill**

Use the Skill tool with skill name `superpowers:using-git-worktrees`. Ask the skill to create a worktree for branch `feature/settings-v2-dusk` based on `develop`. Skill will pick a directory, run `git worktree add`, and report the path.

- [ ] **Step 3: Switch context into the worktree**

`cd` into the worktree path returned by the skill. From here on, **all** subsequent tasks (T_TOK through T_FINAL_4) run inside the worktree.

```bash
pwd                        # confirm you're in the worktree
git rev-parse --abbrev-ref HEAD   # must print: feature/settings-v2-dusk
git status --short          # must print nothing — worktree starts clean
```

- [ ] **Step 4: Re-source env and verify baseline tooling**

```bash
source scripts/env.sh
which bun
bun --version
```

Expected: `bun` resolves; version >= 1.0.

- [ ] **Step 5: Run baseline tests in the worktree**

```bash
cd gateway/webui
bun run typecheck
bun run lint
bun run test
```

Expected: all pass on the develop snapshot. If any fails, stop and reconcile before proceeding — we need a green baseline to detect regressions cleanly.

- [ ] **Step 6: Commit a worktree readiness marker (optional but recommended)**

Skip if no changes to commit. The point of this step is to mark the start of the implementation cycle in git history. If preferred, skip and let Task 1 (font imports) be the first commit on the branch.

---

## Phase 1 — Token + font edits

### Task 1: Add Fraunces + DM Sans Google Font imports

**Files:**
- Modify: `gateway/webui/index.html`

- [ ] **Step 1: Open `gateway/webui/index.html` and locate the existing `<head>`**

Read the file. Look for the existing `<title>` and any `<link>` tags.

- [ ] **Step 2: Replace the head section to add font preconnects + Google Fonts link**

Edit `gateway/webui/index.html` head: ensure these lines exist between `<meta>` and the existing stylesheet links / module script (insert after `<title>` if missing):

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
  rel="stylesheet"
/>
```

If any pre-existing Inter or Instrument Serif `<link>` is present in the head, delete it.

- [ ] **Step 3: Build the webui and confirm no errors**

```bash
cd gateway/webui
bun run build
```

Expected: build succeeds, no missing-asset warnings.

- [ ] **Step 4: Commit**

```bash
git add gateway/webui/index.html
git commit -m "feat(webui): add Fraunces + DM Sans Google Font imports"
```

---

### Task 2: Update typography token values

**Files:**
- Modify: `gateway/webui/src/styles/tokens/typography.css`

- [ ] **Step 1: Replace typography.css with Fraunces+DM stack**

Overwrite `gateway/webui/src/styles/tokens/typography.css` with:

```css
/* gateway/webui/src/styles/tokens/typography.css */
:root {
  --font-display: "Fraunces", "Cormorant Garamond", Georgia, serif;
  --font-ui:      "DM Sans", "Inter", system-ui, -apple-system, sans-serif;
  --font-mono:    "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;

  --font-size-xs:      11px;
  --font-size-sm:      12.5px;
  --font-size-base:    15px;
  --font-size-lg:      18px;
  --font-size-xl:      22px;
  --font-size-display: 44px;

  --line-height-tight:   1.25;
  --line-height-normal:  1.55;
  --line-height-relaxed: 1.6;
}
```

- [ ] **Step 2: Smoke-render the chat to verify font swap**

```bash
cd /Users/kevinye/Development/sentient
source scripts/env.sh
bun run dev
```

Open `https://localhost:8888/` in Chrome. The chat bubbles should now render in DM Sans (UI text) and any heading-level elements in Fraunces. Compare against `sentient-webui-design-v2/screenshots/00-chat-reference.png` — fonts should match.

Stop the dev server (`Ctrl-C`) when satisfied.

- [ ] **Step 3: Commit**

```bash
git add gateway/webui/src/styles/tokens/typography.css
git commit -m "feat(webui): swap fonts to Fraunces + DM Sans for Dusk theme"
```

---

### Task 3: Add Comfortable density tokens

**Files:**
- Modify: `gateway/webui/src/styles/tokens/spacing.css`

- [ ] **Step 1: Read the current spacing.css**

Open `gateway/webui/src/styles/tokens/spacing.css`. Note current contents.

- [ ] **Step 2: Append density tokens**

Add these lines inside the existing `:root { … }` block (do not introduce a `[data-density]` selector — single locked combo):

```css
  /* Layout density (Comfortable — single locked combo) */
  --pad-msg: 18px;
  --gap-msg: 32px;
  --msg-max: 720px;
```

- [ ] **Step 3: Verify no regressions**

```bash
cd gateway/webui
bun run typecheck
bun run lint
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add gateway/webui/src/styles/tokens/spacing.css
git commit -m "feat(webui): add Comfortable density tokens (--pad-msg, --gap-msg, --msg-max)"
```

---

### Task 4: Audit color/shadow/radius tokens against v2 Dusk

**Files:** read-only audit, then `gateway/webui/src/styles/tokens/{colors,shadows,radius}.css` if drift found.

- [ ] **Step 1: Diff colors.css against v2 Dusk values**

Open both files side-by-side:
- `gateway/webui/src/styles/tokens/colors.css`
- `sentient-webui-design-v2/styles.css` lines 84–106 (the `[data-theme="dusk"]` block)

Tokens to compare (variable names differ — current uses `--color-*`, v2 uses bare names):

| current | v2 (dusk) |
|---|---|
| `--color-bg` | `--bg: #2B2621` |
| `--color-bg-elev` | `--bg-elev: #332D28` |
| `--color-bg-sunk` | `--bg-sunk: #241F1B` |
| `--color-paper` | `--paper: #39322C` |
| `--color-line` | `--line: #4A4138` |
| `--color-line-soft` | `--line-soft: #3E362F` |
| `--color-ink` | `--ink: #F2E8D6` |
| `--color-ink-2` | `--ink-2: #D7C6AB` |
| `--color-ink-3` | `--ink-3: #9E907E` |
| `--color-ink-4` | `--ink-4: #706456` |
| `--color-accent` | `--terra: #F2A06A` |
| `--color-accent-soft` | `--terra-soft: #5A3A28` |
| `--color-accent-50` | `--terra-50: #402C22` |
| `--color-amber` | `--amber: #E9B168` |
| `--color-sage` | `--sage: #B9C8A6` |
| `--color-sage-soft` | `--sage-soft: #3A4232` |

Any drift → correct in `colors.css` to match the v2 hex values.

- [ ] **Step 2: Diff shadows.css against v2 Dusk shadows**

v2 Dusk shadows (`styles.css` lines 102–105):

```css
--shadow-1: 0 1px 0 rgba(0,0,0,.15), 0 1px 2px rgba(0,0,0,.25);
--shadow-2: 0 1px 0 rgba(0,0,0,.2), 0 12px 32px -10px rgba(0,0,0,.5),
            0 0 40px -20px rgba(242,160,106,.4);
--shadow-inset: inset 0 1px 0 rgba(255,255,255,.04), inset 0 -1px 0 rgba(0,0,0,.2);
```

Confirm `gateway/webui/src/styles/tokens/shadows.css` matches. Correct any drift.

- [ ] **Step 3: Diff radius.css against v2**

v2 (`styles.css` lines 29–33):

```css
--r-sm: 8px;
--r-md: 12px;
--r-lg: 18px;
--r-xl: 26px;
--r-pill: 999px;
```

Confirm `gateway/webui/src/styles/tokens/radius.css` matches. Correct any drift.

- [ ] **Step 4: Commit any token corrections**

If any file changed:

```bash
git add gateway/webui/src/styles/tokens/
git commit -m "fix(webui): correct token drift to match v2 Dusk byte-for-byte"
```

If nothing changed (already correct), skip this step.

---

## Phase 2 — Primitives

Build 15 reusable primitives ported from `sentient-webui-design-v2/settings_view.jsx`. Each is pure / presentational; data flows in via props. Group into 3 batched commits to keep the change log readable.

### Task 5: Form scaffolding primitives — Card, Row, TextField, Textarea, PaneHead

**Files:**
- Create: `gateway/webui/src/components/settings/primitives/card.tsx`
- Create: `gateway/webui/src/components/settings/primitives/row.tsx`
- Create: `gateway/webui/src/components/settings/primitives/text-field.tsx`
- Create: `gateway/webui/src/components/settings/primitives/textarea.tsx`
- Create: `gateway/webui/src/components/settings/primitives/pane-head.tsx`

- [ ] **Step 1: Create `card.tsx`**

```tsx
// gateway/webui/src/components/settings/primitives/card.tsx
import type { ComponentChildren, JSX } from "preact";

export interface CardProps {
  title?: string;
  sub?: string;
  action?: JSX.Element;
  children: ComponentChildren;
  padding?: boolean;
}

export function Card({ title, sub, action, children, padding = true }: CardProps): JSX.Element {
  const hasHeader = title || sub || action;
  return (
    <section class="sc-card">
      {hasHeader && (
        <header class="sc-h">
          <div>
            {title && <h3 class="sc-title">{title}</h3>}
            {sub && <p class="sc-sub">{sub}</p>}
          </div>
          {action && <div class="sc-act">{action}</div>}
        </header>
      )}
      <div class={`sc-body ${padding ? "" : "flush"}`}>{children}</div>
    </section>
  );
}
```

- [ ] **Step 2: Create `row.tsx`**

```tsx
// gateway/webui/src/components/settings/primitives/row.tsx
import type { ComponentChildren, JSX } from "preact";

export interface RowProps {
  label: string;
  hint?: string;
  children: ComponentChildren;
  dirty?: boolean;
  vertical?: boolean;
}

export function Row({ label, hint, children, dirty, vertical }: RowProps): JSX.Element {
  const cls = ["row", dirty ? "dirty" : "", vertical ? "v" : ""].filter(Boolean).join(" ");
  return (
    <div class={cls}>
      <div class="row-l">
        <div class="row-label">
          <span>{label}</span>
          {dirty && <span class="dot-dirty" title="Restart required" />}
        </div>
        {hint && <p class="row-hint">{hint}</p>}
      </div>
      <div class="row-r">{children}</div>
    </div>
  );
}
```

- [ ] **Step 3: Create `text-field.tsx`**

```tsx
// gateway/webui/src/components/settings/primitives/text-field.tsx
import type { JSX } from "preact";

export interface TextFieldProps {
  value: string;
  onChange: (e: Event) => void;
  placeholder?: string;
  prefix?: string;
  suffix?: string;
  type?: "text" | "password" | "email" | "tel";
  monospace?: boolean;
  fullWidth?: boolean;
  error?: boolean;
  disabled?: boolean;
}

export function TextField({
  value,
  onChange,
  placeholder,
  prefix,
  suffix,
  type = "text",
  monospace,
  fullWidth,
  error,
  disabled,
}: TextFieldProps): JSX.Element {
  const cls = ["tf", monospace ? "mono" : "", fullWidth ? "full" : "", error ? "err" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div class={cls}>
      {prefix && <span class="tf-pre">{prefix}</span>}
      <input
        type={type}
        value={value ?? ""}
        onInput={onChange}
        placeholder={placeholder}
        disabled={disabled}
      />
      {suffix && <span class="tf-suf">{suffix}</span>}
    </div>
  );
}
```

- [ ] **Step 4: Create `textarea.tsx`**

```tsx
// gateway/webui/src/components/settings/primitives/textarea.tsx
import type { JSX } from "preact";

export interface TextareaProps {
  value: string;
  onChange: (e: Event) => void;
  placeholder?: string;
  rows?: number;
  monospace?: boolean;
  dirty?: boolean;
  disabled?: boolean;
  spellcheck?: boolean;
}

export function Textarea({
  value,
  onChange,
  placeholder,
  rows = 4,
  monospace,
  dirty,
  disabled,
  spellcheck,
}: TextareaProps): JSX.Element {
  const cls = ["ta", monospace ? "mono" : "", dirty ? "dirty" : ""].filter(Boolean).join(" ");
  return (
    <textarea
      class={cls}
      rows={rows}
      value={value ?? ""}
      onInput={onChange}
      placeholder={placeholder}
      disabled={disabled}
      spellcheck={spellcheck}
    />
  );
}
```

- [ ] **Step 5: Create `pane-head.tsx`**

```tsx
// gateway/webui/src/components/settings/primitives/pane-head.tsx
import type { JSX } from "preact";

export interface PaneHeadProps {
  title: string;
  sub?: string;
  action?: JSX.Element;
}

export function PaneHead({ title, sub, action }: PaneHeadProps): JSX.Element {
  return (
    <div class="pane-head">
      <div>
        <h2>{title}</h2>
        {sub && <p class="pane-sub">{sub}</p>}
      </div>
      {action && <div class="pane-action">{action}</div>}
    </div>
  );
}
```

- [ ] **Step 6: Typecheck**

```bash
cd gateway/webui
bun run typecheck
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add gateway/webui/src/components/settings/primitives/{card,row,text-field,textarea,pane-head}.tsx
git commit -m "feat(webui-settings): add Card, Row, TextField, Textarea, PaneHead primitives"
```

---

### Task 6: Input control primitives — Select, Toggle, Segmented, Slider, Chip, SearchField

**Files:**
- Create: `gateway/webui/src/components/settings/primitives/select.tsx`
- Create: `gateway/webui/src/components/settings/primitives/toggle.tsx`
- Create: `gateway/webui/src/components/settings/primitives/segmented.tsx`
- Create: `gateway/webui/src/components/settings/primitives/slider.tsx`
- Create: `gateway/webui/src/components/settings/primitives/chip.tsx`
- Create: `gateway/webui/src/components/settings/primitives/search-field.tsx`

- [ ] **Step 1: Create `select.tsx`** (custom dropdown with click-outside close)

```tsx
// gateway/webui/src/components/settings/primitives/select.tsx
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { ChevronIcon } from "../../common/icons/chevron.tsx";
import { CheckIcon } from "../../common/icons/check.tsx";

export interface SelectOption {
  value: string;
  label: string;
  icon?: JSX.Element;
  tag?: string;
}

export interface SelectProps {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
}

export function Select({ value, onChange, options, placeholder, disabled }: SelectProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const cur = options.find((o) => o.value === value);

  return (
    <div class={`sel ${open ? "open" : ""}`} ref={ref}>
      <button
        type="button"
        class="sel-btn"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
      >
        {cur ? (
          <span class="sel-cur">
            {cur.icon}
            <span class="sel-l">{cur.label}</span>
            {cur.tag && <span class="sel-tag">{cur.tag}</span>}
          </span>
        ) : (
          <span class="sel-ph">{placeholder ?? "Select…"}</span>
        )}
        <ChevronIcon size={12} />
      </button>
      {open && (
        <div class="sel-menu">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              class={`sel-opt ${o.value === value ? "on" : ""}`}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.icon}
              <span class="sel-l">{o.label}</span>
              {o.tag && <span class="sel-tag">{o.tag}</span>}
              {o.value === value && <CheckIcon size={12} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create `toggle.tsx`**

```tsx
// gateway/webui/src/components/settings/primitives/toggle.tsx
import type { JSX } from "preact";

export interface ToggleProps {
  on: boolean;
  onChange: () => void;
  disabled?: boolean;
}

export function Toggle({ on, onChange, disabled }: ToggleProps): JSX.Element {
  return (
    <button
      type="button"
      class={`tg ${on ? "on" : ""}`}
      onClick={onChange}
      aria-pressed={on}
      disabled={disabled}
    >
      <span class="tg-knob" />
    </button>
  );
}
```

- [ ] **Step 3: Create `segmented.tsx`**

```tsx
// gateway/webui/src/components/settings/primitives/segmented.tsx
import type { JSX } from "preact";

export interface SegmentedOption {
  value: string;
  label: string;
}

export interface SegmentedProps {
  value: string;
  onChange: (v: string) => void;
  options: SegmentedOption[];
  disabled?: boolean;
}

export function Segmented({ value, onChange, options, disabled }: SegmentedProps): JSX.Element {
  return (
    <div class="seg2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          class={value === o.value ? "on" : ""}
          onClick={() => onChange(o.value)}
          disabled={disabled}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Create `slider.tsx`**

```tsx
// gateway/webui/src/components/settings/primitives/slider.tsx
import type { JSX } from "preact";

export interface SliderProps {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  disabled?: boolean;
}

export function Slider({ value, onChange, min, max, step, format, disabled }: SliderProps): JSX.Element {
  return (
    <div class="sld">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onInput={(e) => onChange(parseFloat((e.target as HTMLInputElement).value))}
        disabled={disabled}
      />
      <span class="sld-v">{format ? format(value) : String(value)}</span>
    </div>
  );
}
```

- [ ] **Step 5: Create `chip.tsx`**

```tsx
// gateway/webui/src/components/settings/primitives/chip.tsx
import type { ComponentChildren, JSX } from "preact";

export interface ChipProps {
  active: boolean;
  onClick: () => void;
  children: ComponentChildren;
  disabled?: boolean;
}

export function Chip({ active, onClick, children, disabled }: ChipProps): JSX.Element {
  return (
    <button
      type="button"
      class={`pill-chip ${active ? "on" : ""}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
```

- [ ] **Step 6: Create `search-field.tsx`**

```tsx
// gateway/webui/src/components/settings/primitives/search-field.tsx
import type { JSX } from "preact";

export interface SearchFieldProps {
  value: string;
  onChange: (e: Event) => void;
  placeholder?: string;
  fullWidth?: boolean;
}

export function SearchField({ value, onChange, placeholder, fullWidth }: SearchFieldProps): JSX.Element {
  return (
    <div class={`srch ${fullWidth ? "full" : ""}`}>
      <span class="srch-icon" aria-hidden="true">⌕</span>
      <input value={value} onInput={onChange} placeholder={placeholder} />
    </div>
  );
}
```

- [ ] **Step 7: Typecheck**

```bash
cd gateway/webui
bun run typecheck
```

Expected: pass. (If `ChevronIcon` / `CheckIcon` import paths fail, find the correct path in `src/components/common/icons/` and adjust.)

- [ ] **Step 8: Commit**

```bash
git add gateway/webui/src/components/settings/primitives/{select,toggle,segmented,slider,chip,search-field}.tsx
git commit -m "feat(webui-settings): add Select, Toggle, Segmented, Slider, Chip, SearchField primitives"
```

---

### Task 7: Action / overlay primitives — Btn, Modal, PinInput, WipBadge

**Files:**
- Create: `gateway/webui/src/components/settings/primitives/btn.tsx`
- Create: `gateway/webui/src/components/settings/primitives/modal.tsx`
- Create: `gateway/webui/src/components/settings/primitives/pin-input.tsx`
- Create: `gateway/webui/src/components/settings/primitives/wip-badge.tsx`

- [ ] **Step 1: Create `btn.tsx`**

```tsx
// gateway/webui/src/components/settings/primitives/btn.tsx
import type { ComponentChildren, JSX } from "preact";

export interface BtnProps {
  kind?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
  danger?: boolean;
  dark?: boolean;
  children: ComponentChildren;
  icon?: JSX.Element;
  disabled?: boolean;
  onClick?: (e: MouseEvent) => void;
  type?: "button" | "submit";
  title?: string;
}

export function Btn({
  kind = "ghost",
  size = "md",
  danger,
  dark,
  children,
  icon,
  disabled,
  onClick,
  type = "button",
  title,
}: BtnProps): JSX.Element {
  const cls = [
    "btn",
    `b-${kind}`,
    `b-${size}`,
    danger ? "danger" : "",
    dark ? "on-dark" : "",
  ].filter(Boolean).join(" ");
  return (
    <button type={type} class={cls} disabled={disabled} onClick={onClick} title={title}>
      {icon && <span class="b-icon">{icon}</span>}
      {children}
    </button>
  );
}
```

- [ ] **Step 2: Create `modal.tsx`**

```tsx
// gateway/webui/src/components/settings/primitives/modal.tsx
import type { ComponentChildren, JSX } from "preact";
import { useEffect } from "preact/hooks";
import { XIcon } from "../../common/icons/x.tsx";

export interface ModalProps {
  title: string;
  children: ComponentChildren;
  footer?: JSX.Element;
  onClose: () => void;
  width?: number;
}

export function Modal({ title, children, footer, onClose, width = 440 }: ModalProps): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div class="modal-scrim" onClick={onClose}>
      <div class="modal" style={{ maxWidth: width }} onClick={(e) => e.stopPropagation()}>
        <header class="modal-h">
          <h3>{title}</h3>
          <button type="button" class="modal-x" onClick={onClose} aria-label="Close">
            <XIcon size={14} />
          </button>
        </header>
        <div class="modal-b">{children}</div>
        {footer && <footer class="modal-f">{footer}</footer>}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create `pin-input.tsx`**

```tsx
// gateway/webui/src/components/settings/primitives/pin-input.tsx
import type { JSX } from "preact";
import { useRef } from "preact/hooks";

export interface PinInputProps {
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}

export function PinInput({ value, onChange, autoFocus }: PinInputProps): JSX.Element {
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  const setDigit = (i: number, d: string) => {
    if (!/^[0-9]?$/.test(d)) return;
    const arr = (value ?? "").padEnd(4, " ").split("");
    arr[i] = d || " ";
    const next = arr.join("").trimEnd();
    onChange(next.slice(0, 4));
    if (d && i < 3) refs.current[i + 1]?.focus();
  };

  const onKey = (i: number, e: KeyboardEvent) => {
    if (e.key === "Backspace" && !value[i] && i > 0) refs.current[i - 1]?.focus();
    if (e.key === "ArrowLeft" && i > 0) refs.current[i - 1]?.focus();
    if (e.key === "ArrowRight" && i < 3) refs.current[i + 1]?.focus();
  };

  return (
    <div class="pin">
      {[0, 1, 2, 3].map((i) => (
        <input
          key={i}
          ref={(el) => (refs.current[i] = el)}
          type="password"
          inputMode="numeric"
          maxLength={1}
          class="pin-box"
          autoFocus={autoFocus && i === 0}
          value={value[i] ?? ""}
          onInput={(e) => setDigit(i, (e.target as HTMLInputElement).value)}
          onKeyDown={(e) => onKey(i, e)}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Create `wip-badge.tsx`**

```tsx
// gateway/webui/src/components/settings/primitives/wip-badge.tsx
import type { JSX } from "preact";

export interface WipBadgeProps {
  label?: string;
}

export function WipBadge({ label = "WIP" }: WipBadgeProps): JSX.Element {
  return <span class="wip-badge">{label}</span>;
}
```

- [ ] **Step 5: Typecheck**

```bash
cd gateway/webui
bun run typecheck
```

Expected: pass. If `XIcon` import path is wrong, fix to match the actual location of the X icon (likely `../../common/icons/x.tsx`).

- [ ] **Step 6: Commit**

```bash
git add gateway/webui/src/components/settings/primitives/{btn,modal,pin-input,wip-badge}.tsx
git commit -m "feat(webui-settings): add Btn, Modal, PinInput, WipBadge primitives"
```

---

### Task 8: Primitives CSS scaffolding

**Files:**
- Create: `gateway/webui/src/components/settings/primitives/primitives.css`

- [ ] **Step 1: Create `primitives.css` by porting from v2 styles.css**

The v2 styles.css contains all the CSS for these primitives. Open `sentient-webui-design-v2/styles.css` and grep for: `.sc-card`, `.sc-h`, `.sc-title`, `.sc-sub`, `.sc-act`, `.sc-body`, `.row`, `.row-l`, `.row-r`, `.row-label`, `.row-hint`, `.dot-dirty`, `.tf`, `.tf-pre`, `.tf-suf`, `.ta`, `.sel`, `.sel-btn`, `.sel-cur`, `.sel-l`, `.sel-tag`, `.sel-ph`, `.sel-menu`, `.sel-opt`, `.tg`, `.tg-knob`, `.seg2`, `.sld`, `.sld-v`, `.pill-chip`, `.srch`, `.srch-icon`, `.btn`, `.b-primary`, `.b-secondary`, `.b-ghost`, `.b-sm`, `.b-md`, `.b-icon`, `.modal-scrim`, `.modal`, `.modal-h`, `.modal-x`, `.modal-b`, `.modal-f`, `.pin`, `.pin-box`, `.wip-badge`, `.pane-head`, `.pane-sub`, `.pane-action`.

Port each block to `primitives.css`, preserving rules verbatim but mapping any `var(--bg)` → `var(--color-bg)`, `var(--ink)` → `var(--color-ink)`, `var(--terra)` → `var(--color-accent)`, etc. (current token names use `--color-` prefix; v2 uses bare names).

If the v2 source uses a token name not present in the current `--color-*` set, **add an alias to colors.css** (e.g., if v2 references `--paper`, add `--paper: var(--color-paper);` to colors.css) — don't rename existing tokens.

Wrap all primitive selectors under `.settings-v2 { … }` to avoid global collisions during the rewrite.

- [ ] **Step 2: Add a `wip-badge` style if not present in v2**

```css
.settings-v2 .wip-badge {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border-radius: var(--r-pill);
  background: var(--color-amber);
  color: var(--color-bg);
  font-size: var(--font-size-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
```

- [ ] **Step 3: Verify the CSS file compiles**

```bash
cd gateway/webui
bun run build
```

Expected: build succeeds (the CSS is not yet imported anywhere — we'll wire it in Task 25).

- [ ] **Step 4: Commit**

```bash
git add gateway/webui/src/components/settings/primitives/primitives.css
git commit -m "feat(webui-settings): port primitive CSS from v2 styles.css under .settings-v2 namespace"
```

---

## Phase 3 — Apply Bar (FSM-driven, TDD)

The apply bar's state machine classifies pending changes (fast vs slow ops), drives the smart label ("Apply" vs "Apply & Restart"), and resolves the restart cycle. This is the only place in the plan that gets test-first per the project's test-lean rule.

### Task 9: Apply-bar FSM type definitions

**Files:**
- Create: `gateway/webui/src/components/settings/apply-bar/apply-bar-machine.ts`

- [ ] **Step 1: Skeleton with types only**

Create `apply-bar-machine.ts` with this scaffolding (no logic yet — just types and a placeholder export to satisfy compiler):

```ts
// gateway/webui/src/components/settings/apply-bar/apply-bar-machine.ts

/** A pending change. `slow` ops trigger a Hermes restart on apply. */
export interface PendingOp {
  key: string;
  kind: "fast" | "slow";
}

/** External-facing state of the apply bar. */
export type ApplyBarState =
  | { phase: "idle"; pending: PendingOp[] }
  | { phase: "saving"; pending: PendingOp[] }
  | { phase: "restarting"; pending: PendingOp[] }
  | { phase: "ready"; elapsedMs: number }
  | { phase: "failed"; errorMessage: string };

/** Smart label for the Apply button. */
export function applyButtonLabel(pending: PendingOp[]): string {
  if (pending.some((op) => op.kind === "slow")) return "Apply & Restart";
  return "Apply";
}

/** True when at least one pending op is dirty. */
export function isDirty(pending: PendingOp[]): boolean {
  return pending.length > 0;
}
```

- [ ] **Step 2: Typecheck**

```bash
cd gateway/webui
bun run typecheck
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add gateway/webui/src/components/settings/apply-bar/apply-bar-machine.ts
git commit -m "feat(webui-settings): scaffold apply-bar machine types + label classifier"
```

---

### Task 10: Apply-bar machine — failing tests

**Files:**
- Create: `gateway/webui/src/components/settings/apply-bar/apply-bar-machine.test.ts`

- [ ] **Step 1: Write tests for label + dirty classifiers**

Create `apply-bar-machine.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { applyButtonLabel, isDirty, type PendingOp } from "./apply-bar-machine.ts";

describe("applyButtonLabel", () => {
  it("returns 'Apply' when all pending ops are fast", () => {
    const pending: PendingOp[] = [{ key: "personalities.active", kind: "fast" }];
    expect(applyButtonLabel(pending)).toBe("Apply");
  });

  it("returns 'Apply & Restart' when any pending op is slow", () => {
    const pending: PendingOp[] = [
      { key: "personalities.active", kind: "fast" },
      { key: "profile.voice", kind: "slow" },
    ];
    expect(applyButtonLabel(pending)).toBe("Apply & Restart");
  });

  it("returns 'Apply' for empty pending list (degenerate; bar should be hidden in this state)", () => {
    expect(applyButtonLabel([])).toBe("Apply");
  });
});

describe("isDirty", () => {
  it("returns false for empty pending list", () => {
    expect(isDirty([])).toBe(false);
  });

  it("returns true when at least one op is pending", () => {
    expect(isDirty([{ key: "x", kind: "fast" }])).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests; expect them to PASS already** (the classifiers were already implemented in Task 9 — this is a sanity check, not failure-driven)

```bash
cd gateway/webui
bun run test apply-bar-machine
```

Expected: 5 passed.

(Note: the FSM transitions — saving, restarting, ready, failed — get test coverage via Task 11 which builds out the apply orchestrator. Splitting these into "test first, code next" is the discipline.)

- [ ] **Step 3: Commit**

```bash
git add gateway/webui/src/components/settings/apply-bar/apply-bar-machine.test.ts
git commit -m "test(webui-settings): cover applyButtonLabel + isDirty classifiers"
```

---

### Task 11: Apply-bar machine — apply orchestrator (FSM)

**Files:**
- Modify: `gateway/webui/src/components/settings/apply-bar/apply-bar-machine.ts`
- Modify: `gateway/webui/src/components/settings/apply-bar/apply-bar-machine.test.ts`

- [ ] **Step 1: Add orchestrator test cases (failing)**

Append to `apply-bar-machine.test.ts`:

```ts
import { runApply, type ApplyDeps, type ApplyOutcome } from "./apply-bar-machine.ts";

function fakeDeps(overrides?: Partial<ApplyDeps>): ApplyDeps {
  return {
    saveSoul: async () => ({ ok: true, elapsedMs: 50 }),
    saveProfile: async () => ({ ok: true, elapsedMs: 80 }),
    savePersonalityActive: async () => ({ ok: true, elapsedMs: 5 }),
    savePersonalityBody: async () => ({ ok: true, elapsedMs: 60 }),
    savePersonalityCreate: async () => ({ ok: true, elapsedMs: 60 }),
    savePersonalityDelete: async () => ({ ok: true, elapsedMs: 40 }),
    waitForRestart: async () => ({ state: "ready", elapsedMs: 1500 }),
    ...overrides,
  };
}

describe("runApply", () => {
  it("emits idle → saving → ready when only fast ops are pending", async () => {
    const states: string[] = [];
    const deps = fakeDeps();
    const outcome: ApplyOutcome = await runApply(
      [{ key: "personalities.active", kind: "fast", payload: { name: "Calm Companion" } }],
      deps,
      (s) => states.push(s.phase),
    );
    expect(states).toEqual(["saving", "ready"]);
    expect(outcome.ok).toBe(true);
  });

  it("emits idle → saving → restarting → ready when any slow op is pending", async () => {
    const states: string[] = [];
    const deps = fakeDeps();
    await runApply(
      [
        { key: "personalities.active", kind: "fast", payload: { name: "X" } },
        { key: "profile.voice", kind: "slow", payload: { voice: "Hazel" } },
      ],
      deps,
      (s) => states.push(s.phase),
    );
    expect(states).toEqual(["saving", "restarting", "ready"]);
  });

  it("emits failed when a save returns ok=false", async () => {
    const states: string[] = [];
    const deps = fakeDeps({
      saveProfile: async () => ({ ok: false, errorMessage: "network error" }),
    });
    const outcome = await runApply(
      [{ key: "profile.voice", kind: "slow", payload: { voice: "Hazel" } }],
      deps,
      (s) => states.push(s.phase),
    );
    expect(outcome.ok).toBe(false);
    expect(states[states.length - 1]).toBe("failed");
  });

  it("emits failed when waitForRestart returns failed", async () => {
    const states: string[] = [];
    const deps = fakeDeps({
      waitForRestart: async () => ({ state: "failed", elapsedMs: 30000 }),
    });
    const outcome = await runApply(
      [{ key: "profile.voice", kind: "slow", payload: { voice: "Hazel" } }],
      deps,
      (s) => states.push(s.phase),
    );
    expect(outcome.ok).toBe(false);
    expect(states[states.length - 1]).toBe("failed");
  });
});
```

- [ ] **Step 2: Run tests; expect failure (runApply not yet implemented)**

```bash
cd gateway/webui
bun run test apply-bar-machine
```

Expected: tests fail with "runApply is not exported" or similar.

- [ ] **Step 3: Implement `runApply` orchestrator**

Append to `apply-bar-machine.ts`:

```ts
// ----- Pending ops with payload -----

export interface FastOp extends PendingOp { kind: "fast"; payload: unknown }
export interface SlowOp extends PendingOp { kind: "slow"; payload: unknown }

export type PendingOpWithPayload = FastOp | SlowOp;

// ----- Save dependencies (injected by the React component) -----

export interface SaveResult {
  ok: boolean;
  elapsedMs?: number;
  errorMessage?: string;
}

export interface RestartWaitResult {
  state: "ready" | "failed";
  elapsedMs: number;
}

export interface ApplyDeps {
  saveSoul(body: string): Promise<SaveResult>;
  saveProfile(profileDraft: unknown): Promise<SaveResult>;
  savePersonalityActive(name: string): Promise<SaveResult>;
  savePersonalityBody(name: string, body: string): Promise<SaveResult>;
  savePersonalityCreate(name: string, body: string): Promise<SaveResult>;
  savePersonalityDelete(name: string): Promise<SaveResult>;
  waitForRestart(): Promise<RestartWaitResult>;
}

export interface ApplyOutcome {
  ok: boolean;
  errorMessage?: string;
}

/**
 * Walks pending ops, dispatches each to the right save dep, then
 * (if any slow op was in the batch) waits for the Hermes restart.
 * Emits state transitions via `onState` so the UI can drive the spinner.
 *
 * Stops on first failure. Caller is responsible for keeping pending
 * ops in dirty until the user acks the failure or retries.
 */
export async function runApply(
  pending: PendingOpWithPayload[],
  deps: ApplyDeps,
  onState: (s: ApplyBarState) => void,
): Promise<ApplyOutcome> {
  if (pending.length === 0) return { ok: true };

  onState({ phase: "saving", pending });

  for (const op of pending) {
    const r = await dispatchOp(op, deps);
    if (!r.ok) {
      const msg = r.errorMessage ?? `Save failed for ${op.key}`;
      onState({ phase: "failed", errorMessage: msg });
      return { ok: false, errorMessage: msg };
    }
  }

  const hasSlow = pending.some((op) => op.kind === "slow");
  if (!hasSlow) {
    onState({ phase: "ready", elapsedMs: 0 });
    return { ok: true };
  }

  onState({ phase: "restarting", pending });
  const restart = await deps.waitForRestart();
  if (restart.state === "failed") {
    const msg = "Your assistant didn't come back up. Try again.";
    onState({ phase: "failed", errorMessage: msg });
    return { ok: false, errorMessage: msg };
  }

  onState({ phase: "ready", elapsedMs: restart.elapsedMs });
  return { ok: true };
}

async function dispatchOp(op: PendingOpWithPayload, deps: ApplyDeps): Promise<SaveResult> {
  switch (op.key) {
    case "persona.soul":
      return deps.saveSoul(op.payload as string);
    case "personalities.active":
      return deps.savePersonalityActive((op.payload as { name: string }).name);
    case "personalities.new":
      return deps.savePersonalityCreate(
        (op.payload as { name: string; body: string }).name,
        (op.payload as { name: string; body: string }).body,
      );
    default:
      if (op.key.startsWith("personalities.delete:")) {
        return deps.savePersonalityDelete(op.key.slice("personalities.delete:".length));
      }
      if (op.key.startsWith("personalities.")) {
        const name = op.key.slice("personalities.".length);
        return deps.savePersonalityBody(name, (op.payload as { body: string }).body);
      }
      if (op.key.startsWith("profile.")) {
        return deps.saveProfile(op.payload);
      }
      return { ok: false, errorMessage: `unknown op key: ${op.key}` };
  }
}
```

- [ ] **Step 4: Run tests; expect pass**

```bash
cd gateway/webui
bun run test apply-bar-machine
```

Expected: 9 tests passing.

- [ ] **Step 5: Commit**

```bash
git add gateway/webui/src/components/settings/apply-bar/apply-bar-machine.ts gateway/webui/src/components/settings/apply-bar/apply-bar-machine.test.ts
git commit -m "feat(webui-settings): apply-bar FSM (saving → restarting → ready/failed) with op-key dispatch"
```

---

### Task 12: Apply-bar component (UI)

**Files:**
- Create: `gateway/webui/src/components/settings/apply-bar/apply-bar.tsx`
- Create: `gateway/webui/src/components/settings/apply-bar/apply-bar.css`

- [ ] **Step 1: Create `apply-bar.tsx`**

```tsx
// gateway/webui/src/components/settings/apply-bar/apply-bar.tsx
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import { Btn } from "../primitives/btn.tsx";
import {
  applyButtonLabel,
  runApply,
  type ApplyBarState,
  type ApplyDeps,
  type PendingOpWithPayload,
} from "./apply-bar-machine.ts";

const log = createLogger(["sentient", "webui", "settings", "apply-bar"]);

export interface ApplyBarProps {
  pending: PendingOpWithPayload[];
  deps: ApplyDeps;
  onApplied: () => void;   // parent clears dirty
  onDiscard: () => void;
}

export function ApplyBar({ pending, deps, onApplied, onDiscard }: ApplyBarProps): JSX.Element | null {
  const [state, setState] = useState<ApplyBarState>({ phase: "idle", pending });

  if (pending.length === 0 && state.phase === "idle") return null;

  const label = applyButtonLabel(pending);
  const isBusy = state.phase === "saving" || state.phase === "restarting";

  const handleApply = async () => {
    log.info("apply.start", { count: pending.length, hasSlow: pending.some((p) => p.kind === "slow") });
    const outcome = await runApply(pending, deps, setState);
    if (outcome.ok) {
      log.info("apply.ok");
      onApplied();
      // hold "ready" briefly, then return to idle
      setTimeout(() => setState({ phase: "idle", pending: [] }), 1500);
    } else {
      log.warn("apply.failed", { errorMessage: outcome.errorMessage });
    }
  };

  return (
    <div class="apply-bar" role="status" aria-live="polite">
      <div class="ab-text">
        <span class="ab-count">
          {pending.length} pending {pending.length === 1 ? "change" : "changes"}
        </span>
        <span class="ab-sub">{subtextFor(state, label)}</span>
      </div>
      <Btn kind="ghost" size="sm" dark onClick={onDiscard} disabled={isBusy}>
        Discard
      </Btn>
      <Btn kind="primary" size="sm" dark onClick={handleApply} disabled={isBusy}>
        {state.phase === "saving" && <><span class="spin-mini" /> Saving…</>}
        {state.phase === "restarting" && <><span class="spin-mini" /> Restarting…</>}
        {state.phase === "ready" && <>Done</>}
        {state.phase === "failed" && <>Retry</>}
        {state.phase === "idle" && label}
      </Btn>
    </div>
  );
}

function subtextFor(state: ApplyBarState, label: string): string {
  if (state.phase === "failed") return state.errorMessage;
  if (label === "Apply & Restart") return "Sentient will restart to apply";
  return "Changes will apply instantly";
}
```

- [ ] **Step 2: Create `apply-bar.css`**

```css
/* gateway/webui/src/components/settings/apply-bar/apply-bar.css */

.settings-v2 .apply-bar {
  position: fixed;
  left: 50%;
  bottom: 20px;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-radius: var(--r-pill);
  background: var(--color-bg-elev);
  border: 1px solid var(--color-line);
  box-shadow: var(--shadow-2);
  z-index: 50;
}

.settings-v2 .apply-bar .ab-text {
  display: inline-flex;
  flex-direction: column;
  margin-right: 6px;
  line-height: 1.2;
}

.settings-v2 .apply-bar .ab-count {
  color: var(--color-ink);
  font-weight: 600;
  font-size: var(--font-size-sm);
}

.settings-v2 .apply-bar .ab-sub {
  color: var(--color-ink-3);
  font-size: var(--font-size-xs);
  margin-top: 2px;
}

.settings-v2 .spin-mini {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: ab-spin 0.7s linear infinite;
  margin-right: 6px;
  vertical-align: -2px;
}

@keyframes ab-spin {
  to { transform: rotate(360deg); }
}
```

- [ ] **Step 3: Typecheck**

```bash
cd gateway/webui
bun run typecheck
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add gateway/webui/src/components/settings/apply-bar/apply-bar.tsx gateway/webui/src/components/settings/apply-bar/apply-bar.css
git commit -m "feat(webui-settings): apply-bar component with smart label + spinner cycle"
```

---

## Phase 4 — Sidebar shell

### Task 13: Sidebar nav config + types

**Files:**
- Create: `gateway/webui/src/components/settings/sidebar/nav-config.ts`

- [ ] **Step 1: Create `nav-config.ts`**

```ts
// gateway/webui/src/components/settings/sidebar/nav-config.ts

export type SidebarKey =
  | "persona"
  | "personalities"
  | "voice"
  | "model"
  | "tools"
  | "advanced"
  | "account"
  | "members"
  | "provider-keys";

export interface NavItem {
  key: SidebarKey;
  label: string;
  icon: string;   // icon name; resolved by sidebar-nav.tsx
}

export interface NavGroup {
  group: "Soul" | "User" | "Admin";
  items: NavItem[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    group: "Soul",
    items: [
      { key: "persona",       label: "Persona",       icon: "spark" },
      { key: "personalities", label: "Personalities", icon: "sliders" },
      { key: "voice",         label: "Voice",         icon: "music" },
      { key: "model",         label: "Model",         icon: "globe" },
      { key: "tools",         label: "Tools",         icon: "settings" },
      { key: "advanced",      label: "Advanced",      icon: "settings" },
    ],
  },
  {
    group: "User",
    items: [{ key: "account", label: "Account", icon: "spark" }],
  },
  {
    group: "Admin",
    items: [
      { key: "members",       label: "Members",       icon: "spark" },
      { key: "provider-keys", label: "Provider keys", icon: "key" },
    ],
  },
] as const;

/** Tabs that get the docked Apply bar treatment when dirty. */
export const SOUL_KEYS: ReadonlySet<SidebarKey> = new Set([
  "persona", "personalities", "voice", "model", "tools", "advanced",
]);
```

- [ ] **Step 2: Typecheck**

```bash
cd gateway/webui
bun run typecheck
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add gateway/webui/src/components/settings/sidebar/nav-config.ts
git commit -m "feat(webui-settings): add sidebar NAV_GROUPS + SOUL_KEYS constants"
```

---

### Task 14: Sidebar nav component

**Files:**
- Create: `gateway/webui/src/components/settings/sidebar/sidebar-nav.tsx`

- [ ] **Step 1: Create `sidebar-nav.tsx`**

```tsx
// gateway/webui/src/components/settings/sidebar/sidebar-nav.tsx
import type { JSX } from "preact";
import { Icon, type IconName } from "../../common/icon.tsx";
import { NAV_GROUPS, SOUL_KEYS, type SidebarKey } from "./nav-config.ts";

export interface SidebarNavProps {
  active: SidebarKey;
  onChange: (key: SidebarKey) => void;
  dirtyKeys: ReadonlySet<SidebarKey>;
}

export function SidebarNav({ active, onChange, dirtyKeys }: SidebarNavProps): JSX.Element {
  return (
    <nav class="s-nav">
      <div class="s-brand">
        <div class="s-brand-name">Sentient Gateway</div>
        <div class="s-brand-meta">
          Hermes <code>v0.x</code>
        </div>
      </div>

      {NAV_GROUPS.map((g) => (
        <div key={g.group} class="s-nav-group">
          <div class="s-nav-h">{g.group.toUpperCase()}</div>
          {g.items.map((it) => (
            <button
              key={it.key}
              type="button"
              class={`s-nav-i ${active === it.key ? "active" : ""}`}
              onClick={() => onChange(it.key)}
            >
              <Icon name={it.icon as IconName} size={14} />
              <span>{it.label}</span>
              {SOUL_KEYS.has(it.key) && dirtyKeys.has(it.key) && <span class="dot-dirty" />}
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd gateway/webui
bun run typecheck
```

Expected: pass. If `IconName` import path is wrong, find the right one in `src/components/common/icon.tsx` and adjust.

- [ ] **Step 3: Commit**

```bash
git add gateway/webui/src/components/settings/sidebar/sidebar-nav.tsx
git commit -m "feat(webui-settings): add SidebarNav with grouped sections + dirty indicators"
```

---

### Task 15: Sidebar status footer

**Files:**
- Create: `gateway/webui/src/components/settings/sidebar/sidebar-status.tsx`
- Create: `gateway/webui/src/components/settings/sidebar/sidebar.css`

- [ ] **Step 1: Create `sidebar-status.tsx`**

```tsx
// gateway/webui/src/components/settings/sidebar/sidebar-status.tsx
import type { JSX } from "preact";

export interface SidebarStatusProps {
  /** Number of MCP servers with `enabled: true` in the current profile. */
  enabledMcpCount: number;
}

export function SidebarStatus({ enabledMcpCount }: SidebarStatusProps): JSX.Element {
  return (
    <div class="s-side-foot">
      <div class="s-status">
        <span class="ok-dot" /> Healthy · {enabledMcpCount} MCP connected
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `sidebar.css` with sidebar layout + brand + status styles**

Port from `sentient-webui-design-v2/styles.css` blocks for: `.s-nav`, `.s-brand`, `.s-brand-name`, `.s-brand-meta`, `.s-nav-group`, `.s-nav-h`, `.s-nav-i`, `.s-nav-i.active`, `.s-side-foot`, `.s-status`, `.ok-dot`. Apply the `.settings-v2` namespace prefix.

```css
/* gateway/webui/src/components/settings/sidebar/sidebar.css */
/* Ported from sentient-webui-design-v2/styles.css; namespaced under .settings-v2 */

.settings-v2 .s-nav {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 22px 14px 18px;
  border-right: 1px solid var(--color-line-soft);
  min-height: 100%;
  background: var(--color-bg);
}

.settings-v2 .s-brand {
  padding: 0 8px 18px;
  border-bottom: 1px solid var(--color-line-soft);
}

.settings-v2 .s-brand-name {
  font-family: var(--font-display);
  font-size: 22px;
  letter-spacing: 0.2px;
  color: var(--color-ink);
}

.settings-v2 .s-brand-meta {
  margin-top: 4px;
  color: var(--color-ink-3);
  font-size: var(--font-size-xs);
}

.settings-v2 .s-nav-group { display: flex; flex-direction: column; gap: 2px; }

.settings-v2 .s-nav-h {
  font-size: var(--font-size-xs);
  letter-spacing: 0.12em;
  color: var(--color-ink-4);
  padding: 0 10px 6px;
}

.settings-v2 .s-nav-i {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--r-md);
  color: var(--color-ink-2);
  text-align: left;
  position: relative;
}

.settings-v2 .s-nav-i:hover { background: var(--color-bg-sunk); color: var(--color-ink); }
.settings-v2 .s-nav-i.active { background: var(--color-accent-50); color: var(--color-accent); }

.settings-v2 .s-nav-i .dot-dirty {
  position: absolute; right: 12px; top: 14px;
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--color-amber);
}

.settings-v2 .s-side-foot {
  margin-top: auto;
  padding: 12px 8px 4px;
  border-top: 1px solid var(--color-line-soft);
}

.settings-v2 .s-status {
  display: inline-flex; align-items: center; gap: 8px;
  color: var(--color-ink-3);
  font-size: var(--font-size-xs);
}

.settings-v2 .ok-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--color-ok);
  box-shadow: 0 0 0 3px rgba(95, 138, 91, 0.18);
}
```

- [ ] **Step 3: Typecheck**

```bash
cd gateway/webui
bun run typecheck
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add gateway/webui/src/components/settings/sidebar/sidebar-status.tsx gateway/webui/src/components/settings/sidebar/sidebar.css
git commit -m "feat(webui-settings): add SidebarStatus + sidebar layout CSS"
```

---

## Phase 5 — Panes

Each pane task: build the pane container component (data + state) + any pane-local helpers, port logic from the corresponding existing component, restyle with primitives + v2 chrome, eyeball against the reference screenshot. CSS for all panes lives in one file at the end of Phase 5.

### Task 16: Persona pane (Soul.md)

Replaces the current `SoulSection` AND `PersonaSection`. Per spec: drop the Template Card; pane is just the Soul.md textarea + Edit/Preview seg + Restore default.

**Files:**
- Create: `gateway/webui/src/components/settings/panes/persona-pane.tsx`

**Reference:** `sentient-webui-design-v2/screenshots/01-settings-persona.png`, `01a-settings-persona-preview.png`.

- [ ] **Step 1: Create `persona-pane.tsx`**

```tsx
// gateway/webui/src/components/settings/panes/persona-pane.tsx
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import type { ProfileApi, SoulDoc } from "../../../services/profile-api.js";
import { Card } from "../primitives/card.tsx";
import { PaneHead } from "../primitives/pane-head.tsx";
import { Segmented } from "../primitives/segmented.tsx";
import { Textarea } from "../primitives/textarea.tsx";
import { Btn } from "../primitives/btn.tsx";

const log = createLogger(["sentient", "webui", "settings", "persona-pane"]);

export interface PersonaPaneProps {
  api: ProfileApi;
  token: string;
  /** Called when user types in textarea — registers dirty op. */
  onMark: (op: { key: "persona.soul"; kind: "slow"; payload: string }) => void;
  /** Called when user clicks Restore default — also registers a dirty op. */
  onRestoreDefault: (defaultBody: string) => void;
  /** Source of truth for textarea content (controlled by SettingsView via dirty payload). */
  draft: string | null;
  /** Last-saved Soul.md (used for Discard / dirty diff). */
  original: SoulDoc | null;
  /** SettingsView passes a setter so pane can hydrate when fetch lands. */
  setOriginal: (doc: SoulDoc) => void;
  setDraft: (body: string) => void;
}

export function PersonaPane({
  api, token, onMark, onRestoreDefault,
  draft, original, setOriginal, setDraft,
}: PersonaPaneProps): JSX.Element {
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (original !== null) return;
    (async () => {
      const r = await api.getSoul(token);
      if (!r.ok) { log.warn("getSoul.failed", { code: r.error.code }); setLoadError("Couldn't load Soul.md."); return; }
      setOriginal(r.value);
      setDraft(r.value.content);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, token]);

  const handleEdit = (e: Event) => {
    const value = (e.target as HTMLTextAreaElement).value;
    setDraft(value);
    if (original && value !== original.content) {
      onMark({ key: "persona.soul", kind: "slow", payload: value });
    }
  };

  const handleRestore = async () => {
    log.debug("restoreDefault.fetch");
    const r = await api.getSoulDefault(token);
    if (!r.ok) { log.warn("restoreDefault.failed", { code: r.error.code }); return; }
    onRestoreDefault(r.value.content);
  };

  if (loadError) {
    return (
      <>
        <PaneHead title="Persona" sub="The base personality template — Soul.md loaded at boot." />
        <p class="pane-error">{loadError}</p>
      </>
    );
  }

  if (!original || draft === null) {
    return (
      <>
        <PaneHead title="Persona" sub="The base personality template — Soul.md loaded at boot." />
        <p class="pane-loading">Loading…</p>
      </>
    );
  }

  return (
    <>
      <PaneHead title="Persona" sub="The base personality template — Soul.md loaded at boot." />

      <Card
        title="Soul.md"
        sub="Markdown supported. Restart required after Apply."
        action={
          <Btn kind="secondary" size="sm" onClick={handleRestore}>
            Restore default
          </Btn>
        }
      >
        <div class="md-wrap">
          <Segmented
            value={tab}
            onChange={(v) => setTab(v as "edit" | "preview")}
            options={[
              { value: "edit",    label: "Edit" },
              { value: "preview", label: "Preview" },
            ]}
          />
        </div>
        {tab === "edit" ? (
          <Textarea value={draft} monospace rows={18} onChange={handleEdit} />
        ) : (
          <pre class="md-prev">{draft}</pre>
        )}
      </Card>
    </>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd gateway/webui
bun run typecheck
```

Expected: pass. (Will likely complain `ProfileApi.getSoulDefault` etc. — confirm those methods exist in `services/profile-api.ts` and are exported. They should — they were used by `SoulSection`.)

- [ ] **Step 3: Commit**

```bash
git add gateway/webui/src/components/settings/panes/persona-pane.tsx
git commit -m "feat(webui-settings): add Persona pane (Soul.md editor + Edit/Preview seg)"
```

---

### Task 17: Personalities pane (inline expand/edit)

Replaces `PersonalitySection` + `PersonalityEditor` with the v2 inline-expand pattern: each personality is a row that expands in-place to show a body textarea.

**Files:**
- Create: `gateway/webui/src/components/settings/panes/personalities-pane.tsx`

**Reference:** `02-settings-personalities.png`, `02a-settings-personalities-expanded.png`.

- [ ] **Step 1: Create `personalities-pane.tsx`**

```tsx
// gateway/webui/src/components/settings/panes/personalities-pane.tsx
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import type { PersonalityList, ProfileApi } from "../../../services/profile-api.js";
import { Card } from "../primitives/card.tsx";
import { PaneHead } from "../primitives/pane-head.tsx";
import { Btn } from "../primitives/btn.tsx";
import { Textarea } from "../primitives/textarea.tsx";
import { TextField } from "../primitives/text-field.tsx";
import { Icon } from "../../common/icon.tsx";

const log = createLogger(["sentient", "webui", "settings", "personalities-pane"]);

const NEW_KEY = "__new__";

export interface PersonalitiesPaneProps {
  api: ProfileApi;
  token: string;
  onMark: (op: { key: string; kind: "fast" | "slow"; payload: unknown }) => void;
}

export function PersonalitiesPane({ api, token, onMark }: PersonalitiesPaneProps): JSX.Element {
  const [list, setList] = useState<PersonalityList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editDrafts, setEditDrafts] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState("");
  const [newBody, setNewBody] = useState("");

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, token]);

  async function reload() {
    const r = await api.getPersonalities(token);
    if (!r.ok) { log.warn("list.failed", { code: r.error.code }); setLoadError("Couldn't load personalities."); return; }
    setList(r.value);
    setLoadError(null);
  }

  if (loadError) {
    return (
      <>
        <PaneHead title="Personalities" sub="Switchable tone profiles. Activate one for the assistant to wear." />
        <p class="pane-error">{loadError}</p>
      </>
    );
  }

  if (!list) {
    return (
      <>
        <PaneHead title="Personalities" sub="Switchable tone profiles. Activate one for the assistant to wear." />
        <p class="pane-loading">Loading…</p>
      </>
    );
  }

  const isNewOpen = openId === NEW_KEY;

  return (
    <>
      <PaneHead title="Personalities" sub="Switchable tone profiles. Activate one for the assistant to wear." />

      <Card
        title="All personalities"
        action={
          <Btn
            kind="ghost"
            size="sm"
            icon={<Icon name="plus" size={11} />}
            onClick={() => { setOpenId(isNewOpen ? null : NEW_KEY); setNewName(""); setNewBody(""); }}
          >
            New
          </Btn>
        }
        padding={false}
      >
        <div class="lst">
          {isNewOpen && (
            <div class="lst-row open lst-row-new">
              <div class="lst-row-main">
                <TextField
                  value={newName}
                  onChange={(e) => setNewName((e.target as HTMLInputElement).value)}
                  placeholder="e.g. friendly, terse, scientist"
                  fullWidth
                />
              </div>
              <div class="lst-edit">
                <Textarea
                  value={newBody}
                  onChange={(e) => setNewBody((e.target as HTMLTextAreaElement).value)}
                  rows={10}
                  monospace
                  placeholder="Personality body — system-prompt-style instructions."
                />
                <div class="lst-edit-acts">
                  <Btn
                    kind="primary"
                    size="sm"
                    disabled={!validNewName(newName, list)}
                    onClick={() => {
                      onMark({
                        key: "personalities.new",
                        kind: "slow",
                        payload: { name: newName.trim(), body: newBody },
                      });
                      setOpenId(null);
                    }}
                  >
                    Create
                  </Btn>
                  <Btn kind="ghost" size="sm" onClick={() => setOpenId(null)}>Cancel</Btn>
                </div>
              </div>
            </div>
          )}

          {list.personalities.map((p) => {
            const isOpen = openId === p.name;
            const isActive = p.name === list.activeName;
            const draft = editDrafts[p.name] ?? p.body;
            const isDirty = draft !== p.body;

            return (
              <div key={p.name} class={`lst-row ${isActive ? "on" : ""} ${isOpen ? "open" : ""}`}>
                <div
                  class="lst-row-main lst-row-btn"
                  role="button"
                  tabIndex={0}
                  onClick={() => setOpenId(isOpen ? null : p.name)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setOpenId(isOpen ? null : p.name);
                    }
                  }}
                >
                  <span class={`lst-chev ${isOpen ? "open" : ""}`}>
                    <Icon name="chevron" size={12} />
                  </span>
                  <div class="lst-body">
                    <div class="lst-title">
                      {p.name}
                      {isActive && <span class="tag tag-active">active</span>}
                    </div>
                  </div>
                  <div class="lst-acts" onClick={(e) => e.stopPropagation()}>
                    {!isActive && (
                      <Btn
                        kind="ghost"
                        size="sm"
                        onClick={() => onMark({
                          key: "personalities.active",
                          kind: "fast",
                          payload: { name: p.name },
                        })}
                      >
                        Activate
                      </Btn>
                    )}
                    <Btn
                      kind="ghost"
                      size="sm"
                      danger
                      onClick={() => onMark({
                        key: `personalities.delete:${p.name}`,
                        kind: "slow",
                        payload: { name: p.name },
                      })}
                    >
                      Delete
                    </Btn>
                  </div>
                </div>

                {isOpen && (
                  <div class="lst-edit">
                    <Textarea
                      value={draft}
                      rows={10}
                      monospace
                      dirty={isDirty}
                      onChange={(e) => {
                        const v = (e.target as HTMLTextAreaElement).value;
                        setEditDrafts((d) => ({ ...d, [p.name]: v }));
                        if (v !== p.body) {
                          onMark({
                            key: `personalities.${p.name}`,
                            kind: "slow",
                            payload: { body: v },
                          });
                        }
                      }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>
    </>
  );
}

function validNewName(name: string, list: PersonalityList): boolean {
  const t = name.trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(t)) return false;
  return !list.personalities.some((p) => p.name === t);
}
```

- [ ] **Step 2: Typecheck**

```bash
cd gateway/webui
bun run typecheck
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add gateway/webui/src/components/settings/panes/personalities-pane.tsx
git commit -m "feat(webui-settings): add Personalities pane (inline expand/edit per v2)"
```

---

### Task 18: Voice pane (library grid)

**Files:**
- Create: `gateway/webui/src/components/settings/panes/voice-pane.tsx`

**Reference:** `03-settings-voice.png`.

- [ ] **Step 1: Create `voice-pane.tsx`**

```tsx
// gateway/webui/src/components/settings/panes/voice-pane.tsx
import type { JSX } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import type { ProvidersApi, VoiceEntry } from "../../../services/providers-api.ts";
import type { ProfileV1 } from "../../../services/profile-api.js";
import { Card } from "../primitives/card.tsx";
import { PaneHead } from "../primitives/pane-head.tsx";
import { SearchField } from "../primitives/search-field.tsx";
import { Chip } from "../primitives/chip.tsx";
import { Btn } from "../primitives/btn.tsx";
import { Icon } from "../../common/icon.tsx";

const log = createLogger(["sentient", "webui", "settings", "voice-pane"]);
const PER_PAGE = 8;
const LANGS = ["all", "en-US", "en-GB", "ja-JP", "zh-CN", "es-ES"] as const;
type Lang = typeof LANGS[number];

export interface VoicePaneProps {
  api: ProvidersApi;
  token: string;
  draft: ProfileV1;
  onMark: (op: { key: "profile.voice"; kind: "slow"; payload: ProfileV1["voice"] }) => void;
  onDraftVoice: (voice: ProfileV1["voice"]) => void;
}

export function VoicePane({ api, token, draft, onMark, onDraftVoice }: VoicePaneProps): JSX.Element {
  const [voices, setVoices] = useState<VoiceEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [lang, setLang] = useState<Lang>("all");
  const [page, setPage] = useState(0);

  useEffect(() => {
    (async () => {
      const r = await api.listVoices(token);
      if (!r.ok) { log.warn("listVoices.failed", { code: r.error.code }); setLoadError("Couldn't load voices."); return; }
      setVoices(r.value.voices);
    })();
  }, [api, token]);

  useEffect(() => { setPage(0); }, [q, lang]);

  const filtered = useMemo(() => {
    if (!voices) return [];
    return voices.filter((v) => {
      const matchLang = lang === "all" || v.languages.includes(lang);
      const matchQ = !q || v.title.toLowerCase().includes(q.toLowerCase());
      return matchLang && matchQ;
    });
  }, [voices, q, lang]);

  const pages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const safePage = Math.min(page, pages - 1);
  const slice = filtered.slice(safePage * PER_PAGE, (safePage + 1) * PER_PAGE);

  if (loadError) {
    return (
      <>
        <PaneHead title="Voice" sub="The voice Sentient uses for replies. Powered by Fish Audio." />
        <p class="pane-error">{loadError}</p>
      </>
    );
  }

  if (!voices) {
    return (
      <>
        <PaneHead title="Voice" sub="The voice Sentient uses for replies. Powered by Fish Audio." />
        <p class="pane-loading">Loading…</p>
      </>
    );
  }

  const handleSelect = (v: VoiceEntry) => {
    if (draft.voice?.id === v.id) return;
    const next = { id: v.id, title: v.title };
    onDraftVoice(next);
    onMark({ key: "profile.voice", kind: "slow", payload: next });
  };

  return (
    <>
      <PaneHead title="Voice" sub="The voice Sentient uses for replies. Powered by Fish Audio." />
      <Card title="Library" sub={`${voices.length} voices · selected: ${draft.voice?.title ?? "—"}`}>
        <div class="filterbar">
          <SearchField value={q} onChange={(e) => setQ((e.target as HTMLInputElement).value)} placeholder="Search voices…" />
          <div class="chips-row">
            {LANGS.map((l) => (
              <Chip key={l} active={lang === l} onClick={() => setLang(l)}>{l}</Chip>
            ))}
          </div>
        </div>

        <div class="voice-grid">
          {slice.map((v) => {
            const sel = draft.voice?.id === v.id;
            return (
              <div key={v.id} class={`voice ${sel ? "sel" : ""}`} onClick={() => handleSelect(v)}>
                <div
                  class="v-cov"
                  style={{ background: v.coverImageUrl ? `url(${v.coverImageUrl}) center/cover` : "var(--color-paper)" }}
                >
                  <span>{v.title.charAt(0).toUpperCase()}</span>
                  {v.previewAudioUrl && (
                    <button
                      type="button"
                      class="v-play"
                      onClick={(e) => { e.stopPropagation(); new Audio(v.previewAudioUrl ?? "").play().catch(() => {}); }}
                    >
                      ▶
                    </button>
                  )}
                </div>
                <div class="v-meta">
                  <div class="v-name">{v.title}</div>
                  <div class="v-info">
                    <span class="v-lang">{v.languages[0] ?? ""}</span>
                    <span> · {v.description}</span>
                  </div>
                </div>
                {sel && <div class="v-check"><Icon name="check" size={11} /></div>}
              </div>
            );
          })}
          {slice.length === 0 && <div class="empty-pad">No voices match.</div>}
        </div>

        {filtered.length > PER_PAGE && (
          <div class="pager">
            <span class="pager-info">{safePage * PER_PAGE + 1}–{Math.min(filtered.length, (safePage + 1) * PER_PAGE)} of {filtered.length}</span>
            <div class="pager-ctrls">
              <Btn kind="ghost" size="sm" disabled={safePage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>‹</Btn>
              <span class="pager-num">{safePage + 1} / {pages}</span>
              <Btn kind="ghost" size="sm" disabled={safePage >= pages - 1} onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}>›</Btn>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd gateway/webui
bun run typecheck
```

Expected: pass. If `ProfileV1["voice"]` shape mismatches, adjust to the actual field names from the existing `voice-section.tsx` ports.

- [ ] **Step 3: Commit**

```bash
git add gateway/webui/src/components/settings/panes/voice-pane.tsx
git commit -m "feat(webui-settings): add Voice pane (library grid + search + lang chips + paginate)"
```

---

### Task 19: Model pane (provider seg + card list)

**Files:**
- Create: `gateway/webui/src/components/settings/panes/model-pane.tsx`

**Reference:** `04-settings-model.png`.

- [ ] **Step 1: Create `model-pane.tsx`**

```tsx
// gateway/webui/src/components/settings/panes/model-pane.tsx
import type { JSX } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import type { ModelEntry, ProvidersApi } from "../../../services/providers-api.ts";
import type { ProfileV1 } from "../../../services/profile-api.js";
import { Card } from "../primitives/card.tsx";
import { PaneHead } from "../primitives/pane-head.tsx";
import { Segmented } from "../primitives/segmented.tsx";
import { SearchField } from "../primitives/search-field.tsx";

const log = createLogger(["sentient", "webui", "settings", "model-pane"]);
type Provider = "openrouter" | "ollama-cloud";

export interface ModelPaneProps {
  api: ProvidersApi;
  token: string;
  draft: ProfileV1;
  onMark: (op: { key: "profile.model"; kind: "slow"; payload: ProfileV1["model"] }) => void;
  onDraftModel: (model: ProfileV1["model"]) => void;
}

export function ModelPane({ api, token, draft, onMark, onDraftModel }: ModelPaneProps): JSX.Element {
  const [models, setModels] = useState<ModelEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [provider, setProvider] = useState<Provider>(
    (draft.model?.provider as Provider) ?? "openrouter",
  );
  const [q, setQ] = useState("");

  useEffect(() => {
    (async () => {
      const r = await api.listModels(token);
      if (!r.ok) { log.warn("listModels.failed", { code: r.error.code }); setLoadError("Couldn't load models."); return; }
      setModels(r.value.models);
    })();
  }, [api, token]);

  const list = useMemo(() => {
    if (!models) return [];
    return models.filter((m) => m.provider === provider && (!q || m.id.toLowerCase().includes(q.toLowerCase())));
  }, [models, provider, q]);

  if (loadError) {
    return <><PaneHead title="Model" sub="The LLM that powers Sentient's reasoning and tool calls." /><p class="pane-error">{loadError}</p></>;
  }
  if (!models) {
    return <><PaneHead title="Model" sub="The LLM that powers Sentient's reasoning and tool calls." /><p class="pane-loading">Loading…</p></>;
  }

  const handleSelect = (m: ModelEntry) => {
    if (draft.model?.id === m.id) return;
    const next = { id: m.id, provider: m.provider };
    onDraftModel(next);
    onMark({ key: "profile.model", kind: "slow", payload: next });
  };

  return (
    <>
      <PaneHead title="Model" sub="The LLM that powers Sentient's reasoning and tool calls." />

      <Card title="Source &amp; model" sub="Pick a provider, then a model." padding={false}>
        <div class="prov-body">
          <div class="prov-row">
            <Segmented
              value={provider}
              onChange={(v) => setProvider(v as Provider)}
              options={[
                { value: "openrouter",   label: "OpenRouter" },
                { value: "ollama-cloud", label: "Ollama Cloud" },
              ]}
            />
            <span class="prov-row-s">
              {provider === "openrouter" ? "Cloud · pay-per-token" : "Local · free"}
            </span>
          </div>
          <div class="prov-search">
            <SearchField
              value={q}
              onChange={(e) => setQ((e.target as HTMLInputElement).value)}
              placeholder={`Search ${list.length} models…`}
              fullWidth
            />
          </div>
          <div class="model-grid">
            {list.map((m) => {
              const sel = draft.model?.id === m.id;
              return (
                <div key={m.id} class={`mod ${sel ? "is-sel" : ""}`} onClick={() => handleSelect(m)}>
                  <div class="mod-top">
                    <code class="mod-id">{m.id}</code>
                    {sel && <span class="mod-sel-tag">SELECTED</span>}
                  </div>
                  <div class="mod-meta">
                    <span class="mod-price">
                      ${m.pricingPer1mPrompt} / ${m.pricingPer1mCompletion}
                      <span class="muted">{typeof m.pricingPer1mPrompt === "number" ? " /1M" : ""}</span>
                    </span>
                    <span class="mod-dot">·</span>
                    <span class="mod-ctx">{Math.round(m.contextLength / 1000)}k context</span>
                    <span class="grow" />
                    <span class="mod-caps">
                      {m.supportsTools && <span class="cap">tools</span>}
                      {m.supportsVision && <span class="cap">vision</span>}
                    </span>
                  </div>
                </div>
              );
            })}
            {list.length === 0 && <div class="empty-pad">No models match.</div>}
          </div>
        </div>
      </Card>
    </>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd gateway/webui
bun run typecheck
```

Expected: pass. If `ProfileV1["model"]` shape differs (id only? id+provider?), adjust to the actual shape used by `model-section.tsx`.

- [ ] **Step 3: Commit**

```bash
git add gateway/webui/src/components/settings/panes/model-pane.tsx
git commit -m "feat(webui-settings): add Model pane (provider seg + card list)"
```

---

### Task 20: Tools pane (MCP server list + per-tool toggle)

**Files:**
- Create: `gateway/webui/src/components/settings/panes/tools-pane.tsx`

**Reference:** `05-settings-tools.png`, `05a-settings-tools-expanded.png`. Per spec: hide the "Add server" button in v1 (no backend).

- [ ] **Step 1: Create `tools-pane.tsx`**

```tsx
// gateway/webui/src/components/settings/panes/tools-pane.tsx
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { ProfileV1 } from "../../../services/profile-api.js";
import { Card } from "../primitives/card.tsx";
import { PaneHead } from "../primitives/pane-head.tsx";
import { Toggle } from "../primitives/toggle.tsx";
import { Icon } from "../../common/icon.tsx";

export interface ToolsPaneProps {
  draft: ProfileV1;
  onMark: (op: { key: string; kind: "slow"; payload: unknown }) => void;
  onDraftTools: (tools: ProfileV1["tools"]) => void;
}

interface ToolDef {
  name: string;
  description: string;
  enabled: boolean;
}

interface ServerDef {
  server: string;
  url: string;
  description: string;
  enabled: boolean;
  tools: ToolDef[];
}

export function ToolsPane({ draft, onMark, onDraftTools }: ToolsPaneProps): JSX.Element {
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const servers = (draft.tools as unknown as ServerDef[]) ?? [];

  const flipServer = (server: string) => {
    const next = servers.map((s) => s.server === server ? { ...s, enabled: !s.enabled } : s);
    onDraftTools(next as unknown as ProfileV1["tools"]);
    onMark({ key: `profile.tools.${server}`, kind: "slow", payload: next });
  };

  const flipTool = (server: string, toolName: string) => {
    const next = servers.map((s) =>
      s.server === server
        ? { ...s, tools: s.tools.map((t) => t.name === toolName ? { ...t, enabled: !t.enabled } : t) }
        : s
    );
    onDraftTools(next as unknown as ProfileV1["tools"]);
    onMark({ key: `profile.tools.${server}.${toolName}`, kind: "slow", payload: next });
  };

  return (
    <>
      <PaneHead title="Tools" sub="MCP servers Sentient can call, and which specific tools are allowed." />

      <Card
        title="Connected servers"
        sub="Toggle a server to revoke everything at once. Expand to allow individual tools."
        padding={false}
        // "Add server" intentionally NOT rendered — backend not built (see spec).
      >
        <div class="mcp-list">
          {servers.map((s) => {
            const isOpen = !!open[s.server];
            const enabledCt = s.tools.filter((t) => t.enabled).length;

            return (
              <div key={s.server} class={`mcp ${s.enabled ? "" : "off"}`}>
                <div
                  class="mcp-h mcp-h-btn"
                  role="button"
                  tabIndex={0}
                  onClick={() => setOpen((o) => ({ ...o, [s.server]: !o[s.server] }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setOpen((o) => ({ ...o, [s.server]: !o[s.server] }));
                    }
                  }}
                >
                  <span class={`mcp-chev ${isOpen ? "open" : ""}`}>
                    <Icon name="chevron" size={12} />
                  </span>
                  <div class="mcp-id">
                    <div class="mcp-name">
                      <code class="kbd">{s.server}</code>
                      <span class="mcp-desc">{s.description}</span>
                    </div>
                    <div class="mcp-url">{s.url}</div>
                  </div>
                  <span class={`mcp-count ${s.enabled ? "" : "dim"}`}>
                    {s.enabled ? `${enabledCt}/${s.tools.length} tools` : "disabled"}
                  </span>
                  <span onClick={(e) => e.stopPropagation()}>
                    <Toggle on={s.enabled} onChange={() => flipServer(s.server)} />
                  </span>
                </div>

                {s.enabled && isOpen && (
                  <div class="tool-table">
                    <div class="tool-row tool-head">
                      <div class="tc-tog" />
                      <div class="tc-name">Tool</div>
                      <div class="tc-desc">Description</div>
                    </div>
                    {s.tools.map((t) => (
                      <div key={t.name} class={`tool-row ${t.enabled ? "on" : "off"}`}>
                        <div class="tc-tog">
                          <Toggle on={t.enabled} onChange={() => flipTool(s.server, t.name)} />
                        </div>
                        <div class="tc-name"><code>{t.name}</code></div>
                        <div class="tc-desc">{t.description}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {servers.length === 0 && (
            <div class="empty-pad">No MCP servers configured. Add servers to <code>gateway/config.yaml#mcp_catalog</code>.</div>
          )}
        </div>
      </Card>
    </>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd gateway/webui
bun run typecheck
```

Expected: pass. The `as unknown as` casts mean we're not constraining the exact ProfileV1.tools shape here — the existing `tools-section.tsx` had the canonical shape; if typecheck fails, mirror those types exactly instead of using the local `ServerDef`.

- [ ] **Step 3: Commit**

```bash
git add gateway/webui/src/components/settings/panes/tools-pane.tsx
git commit -m "feat(webui-settings): add Tools pane (server list + per-tool toggles, Add server hidden)"
```

---

### Task 21: Advanced pane (sliders + injection)

**Files:**
- Create: `gateway/webui/src/components/settings/panes/advanced-pane.tsx`

**Reference:** `06-settings-advanced.png`.

- [ ] **Step 1: Create `advanced-pane.tsx`**

```tsx
// gateway/webui/src/components/settings/panes/advanced-pane.tsx
import type { JSX } from "preact";
import type { ProfileV1 } from "../../../services/profile-api.js";
import { Card } from "../primitives/card.tsx";
import { PaneHead } from "../primitives/pane-head.tsx";
import { Row } from "../primitives/row.tsx";
import { Slider } from "../primitives/slider.tsx";
import { Textarea } from "../primitives/textarea.tsx";

export interface AdvancedPaneProps {
  draft: ProfileV1;
  onMark: (op: { key: string; kind: "slow"; payload: unknown }) => void;
  onDraftCompression: (cmp: ProfileV1["compression"]) => void;
  onDraftAdvanced: (adv: ProfileV1["advanced"]) => void;
}

export function AdvancedPane({
  draft, onMark, onDraftCompression, onDraftAdvanced,
}: AdvancedPaneProps): JSX.Element {
  return (
    <>
      <PaneHead title="Advanced" sub="Power-user knobs. Defaults are sensible — only touch if you know why." />

      <Card title="Context">
        <Row label="Compression threshold" hint="Trigger context summarization when usage exceeds this fraction of the model's window.">
          <Slider
            value={(draft.compression as { threshold?: number })?.threshold ?? 0.7}
            min={0}
            max={1}
            step={0.05}
            format={(v) => v.toFixed(2)}
            onChange={(v) => {
              const next = { ...(draft.compression ?? {}), threshold: v };
              onDraftCompression(next as ProfileV1["compression"]);
              onMark({ key: "profile.compression", kind: "slow", payload: next });
            }}
          />
        </Row>
        <Row label="Max tokens" hint="Hard cap on assistant output per turn.">
          <Slider
            value={(draft.advanced as { maxTokens?: number })?.maxTokens ?? 2048}
            min={128}
            max={8192}
            step={128}
            onChange={(v) => {
              const next = { ...(draft.advanced ?? {}), maxTokens: v };
              onDraftAdvanced(next as ProfileV1["advanced"]);
              onMark({ key: "profile.advanced.maxTokens", kind: "slow", payload: next });
            }}
          />
        </Row>
      </Card>

      <Card title="Prompt injection" sub="Appended to every user message before it's sent. Use sparingly — counts against context.">
        <Textarea
          value={(draft.advanced as { systemPromptInjection?: string })?.systemPromptInjection ?? ""}
          rows={4}
          placeholder="Optional extra instructions…"
          onChange={(e) => {
            const v = (e.target as HTMLTextAreaElement).value;
            const next = { ...(draft.advanced ?? {}), systemPromptInjection: v };
            onDraftAdvanced(next as ProfileV1["advanced"]);
            onMark({ key: "profile.advanced.injection", kind: "slow", payload: next });
          }}
        />
      </Card>
    </>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd gateway/webui
bun run typecheck
```

Expected: pass. If `ProfileV1.compression` / `ProfileV1.advanced` shapes are concrete (not loose), inline-cast to the right shape exactly as in current `advanced-section.tsx`.

- [ ] **Step 3: Commit**

```bash
git add gateway/webui/src/components/settings/panes/advanced-pane.tsx
git commit -m "feat(webui-settings): add Advanced pane (sliders + prompt injection)"
```

---

### Task 22: Account pane (User group, no apply bar)

**Files:**
- Create: `gateway/webui/src/components/settings/panes/account-pane.tsx`

**Reference:** `07-settings-account.png`, `07a-settings-account-pin-modal.png`. Per spec: no Apply bar; per-card immediate save. Voice-print Re-enroll = disabled placeholder.

- [ ] **Step 1: Create `account-pane.tsx`**

```tsx
// gateway/webui/src/components/settings/panes/account-pane.tsx
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import { useAuth } from "../../../hooks/use-auth.tsx";
import { useToast } from "../../../hooks/use-toast.tsx";
import { createAuthApi } from "../../../services/auth-api.js";
import { Card } from "../primitives/card.tsx";
import { PaneHead } from "../primitives/pane-head.tsx";
import { Row } from "../primitives/row.tsx";
import { TextField } from "../primitives/text-field.tsx";
import { Btn } from "../primitives/btn.tsx";
import { Modal } from "../primitives/modal.tsx";
import { PinInput } from "../primitives/pin-input.tsx";

const log = createLogger(["sentient", "webui", "settings", "account-pane"]);
const PIN_PATTERN = /^\d{4}$/;

export function AccountPane(): JSX.Element {
  const auth = useAuth();
  const toast = useToast();
  const api = createAuthApi();
  const [name, setName] = useState(auth.status === "authenticated" ? auth.user.displayName : "");
  const [pinOpen, setPinOpen] = useState(false);
  const [oldPin, setOldPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);
  const [savingPin, setSavingPin] = useState(false);

  if (auth.status !== "authenticated") return <></>;

  const trimmedName = name.trim();
  const nameUnchanged = trimmedName === auth.user.displayName;

  const handleSaveName = async () => {
    if (nameUnchanged || !trimmedName) return;
    setSavingName(true);
    const r = await api.updateMe(auth.token, { displayName: trimmedName });
    setSavingName(false);
    if (!r.ok) { log.warn("update.failed", { code: r.error.code }); toast.show("Couldn't update display name", "error"); return; }
    auth.updateUser(r.value.user);
    toast.show("Display name updated");
  };

  const canSubmitPin = PIN_PATTERN.test(oldPin) && PIN_PATTERN.test(newPin);

  const handleSavePin = async () => {
    if (!canSubmitPin) return;
    setSavingPin(true);
    setPinError(null);
    const r = await api.changePin(auth.token, { currentPin: oldPin, newPin });
    setSavingPin(false);
    if (!r.ok) {
      log.warn("changePin.failed", { code: r.error.code, status: r.error.status });
      if (r.error.status === 401) setPinError("Current PIN is wrong");
      else if (r.error.status === 422) setPinError("PIN must be 4 digits");
      else setPinError("Something went wrong");
      return;
    }
    toast.show("PIN updated");
    setPinOpen(false);
    setOldPin(""); setNewPin("");
  };

  return (
    <>
      <PaneHead title="Account" sub="Your profile inside this household." />

      <Card title="Identity" sub="How Sentient knows it's you.">
        <Row label="Display name">
          <div class="kv-row grow">
            <TextField
              value={name}
              onChange={(e) => setName((e.target as HTMLInputElement).value)}
              fullWidth
            />
            <Btn
              kind="secondary"
              size="sm"
              disabled={nameUnchanged || !trimmedName || savingName}
              onClick={handleSaveName}
            >
              {savingName ? "Saving…" : "Save"}
            </Btn>
          </div>
        </Row>
        <Row label="Voice print" hint="Used to recognize you when you speak.">
          <div class="kv-row">
            <span class="muted xs">Voice print enrollment coming soon.</span>
            <Btn kind="secondary" size="sm" disabled title="Voice print enrollment coming soon">
              Re-enroll
            </Btn>
          </div>
        </Row>
      </Card>

      <Card title="Security" sub="Used for destructive actions like unlocking doors or spending money.">
        <Row label="PIN" hint="4 digits. Required for sensitive actions.">
          <Btn kind="secondary" size="sm" onClick={() => setPinOpen(true)}>Change PIN</Btn>
        </Row>
      </Card>

      <Card title="Session" sub="This device only.">
        <Row label="Sign out" hint="Returns you to the login screen on this device.">
          <Btn kind="secondary" size="sm" danger onClick={() => auth.logout()}>Log out</Btn>
        </Row>
      </Card>

      {pinOpen && (
        <Modal
          title="Change PIN"
          onClose={() => { setPinOpen(false); setOldPin(""); setNewPin(""); setPinError(null); }}
          footer={
            <>
              <Btn kind="ghost" size="sm" onClick={() => setPinOpen(false)} disabled={savingPin}>Cancel</Btn>
              <Btn kind="primary" size="sm" disabled={!canSubmitPin || savingPin} onClick={handleSavePin}>
                {savingPin ? "Saving…" : "Update PIN"}
              </Btn>
            </>
          }
        >
          <p class="modal-lead">Enter your current 4-digit PIN, then choose a new one.</p>
          <div class="modal-fields">
            <label class="mf">
              <span class="mf-l">Current PIN</span>
              <PinInput value={oldPin} onChange={setOldPin} autoFocus />
            </label>
            <label class="mf">
              <span class="mf-l">New PIN</span>
              <PinInput value={newPin} onChange={setNewPin} />
            </label>
            {pinError && <p class="account-section__error">{pinError}</p>}
          </div>
        </Modal>
      )}
    </>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd gateway/webui
bun run typecheck
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add gateway/webui/src/components/settings/panes/account-pane.tsx
git commit -m "feat(webui-settings): add Account pane (identity / security / session, no apply bar)"
```

---

### Task 23: Members pane (Admin group, no apply bar)

**Files:**
- Create: `gateway/webui/src/components/settings/panes/members-pane.tsx`

**Reference:** `08-settings-members.png`. Ports the existing `MembersPanel` + `MemberAddForm` + `MemberDeleteModal` + `MemberRow` logic into a single file.

- [ ] **Step 1: Create `members-pane.tsx`**

```tsx
// gateway/webui/src/components/settings/panes/members-pane.tsx
import type { JSX } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import { useAuth } from "../../../hooks/use-auth.tsx";
import { useToast } from "../../../hooks/use-toast.tsx";
import { createAdminApi, type UserSummary } from "../../../services/admin-api.ts";
import { Card } from "../primitives/card.tsx";
import { PaneHead } from "../primitives/pane-head.tsx";
import { Row } from "../primitives/row.tsx";
import { TextField } from "../primitives/text-field.tsx";
import { Btn } from "../primitives/btn.tsx";
import { Modal } from "../primitives/modal.tsx";
import { Icon } from "../../common/icon.tsx";
import { SpinnerOverlay } from "../../common/spinner-overlay.tsx";

const log = createLogger(["sentient", "webui", "settings", "members-pane"]);
const POOL_SIZE = 3;
const PIN_PATTERN = /^\d{4}$/;

export function MembersPane(): JSX.Element {
  const auth = useAuth();
  const toast = useToast();
  const api = createAdminApi();

  const [users, setUsers] = useState<UserSummary[]>([]);
  const [applying, setApplying] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<UserSummary | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPin, setNewPin] = useState("");
  const [newIsAdmin, setNewIsAdmin] = useState(false);

  const isAuthed = auth.status === "authenticated";
  const token = isAuthed ? auth.token : "";
  const authUserId = isAuthed ? auth.user.userId : "";

  const fetchUsers = useCallback(async () => {
    if (!isAuthed) return;
    const r = await api.listUsers(token);
    if (r.ok) setUsers(r.value.users);
    else { log.warn("list.failed", { code: r.error.code }); toast.show("Failed to load members", "error"); }
  }, [isAuthed, token]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  if (!isAuthed) return <></>;

  const slotsFree = POOL_SIZE - users.length;

  const handleCreate = async () => {
    if (!PIN_PATTERN.test(newPin) || !newName.trim()) return;
    setApplying(true);
    const r = await api.createUser(token, { displayName: newName.trim(), pin: newPin, isAdmin: newIsAdmin });
    setApplying(false);
    if (r.ok) {
      setUsers((u) => [...u, r.value.user]);
      toast.show(`${newName.trim()} added`);
      setAddOpen(false); setNewName(""); setNewPin(""); setNewIsAdmin(false);
    } else {
      const msg = r.error.code === "pool-full" ? "All slots in use"
        : r.error.code === "schema" ? "Check the form fields"
        : "Failed to add member";
      toast.show(msg, "error");
    }
  };

  const handleToggleAdmin = async (u: UserSummary) => {
    const r = await api.setIsAdmin(token, u.userId, !u.isAdmin);
    if (r.ok) {
      setUsers((arr) => arr.map((x) => x.userId === u.userId ? r.value.user : x));
      toast.show(!u.isAdmin ? "Promoted to Admin" : "Demoted to Member");
    } else {
      toast.show(r.error.code === "last-admin" ? "Can't demote the only admin" : "Failed to update role", "error");
    }
  };

  const handleDelete = async (u: UserSummary) => {
    setDeleteTarget(null);
    setApplying(true);
    const r = await api.deleteUser(token, u.userId);
    setApplying(false);
    if (r.ok) { setUsers((arr) => arr.filter((x) => x.userId !== u.userId)); toast.show("Member removed"); }
    else { toast.show(r.error.code === "last-admin" ? "Can't delete the only admin" : "Failed to delete member", "error"); }
  };

  return (
    <>
      <SpinnerOverlay open={applying} heading="Applying changes…" body="Restarting agent — do not close this tab" />

      <PaneHead title="Members" sub="Everyone with a recognized voice or account in this home." />

      <Card title="Household" sub={`${users.length} active · ${slotsFree} slot${slotsFree === 1 ? "" : "s"} free`} padding={false}>
        <div class="member-list">
          {users.map((u) => (
            <div key={u.userId} class="member">
              <div class="avatar" style={{ background: u.avatarTint || "var(--color-bg-elev)" }}>
                {u.displayName.charAt(0).toUpperCase()}
              </div>
              <div class="info">
                <div class="name">{u.displayName}{u.userId === authUserId && <span class="muted xs"> · you</span>}</div>
                <div class="sub">{u.isAdmin ? "Admin" : "Member"}</div>
              </div>
              <span class={`role-pill ${u.isAdmin ? "admin" : "member"}`}>{u.isAdmin ? "Admin" : "Member"}</span>
              {u.userId !== authUserId && (
                <div class="lst-acts">
                  <Btn kind="ghost" size="sm" onClick={() => handleToggleAdmin(u)}>
                    {u.isAdmin ? "Demote" : "Promote"}
                  </Btn>
                  <Btn kind="ghost" size="sm" danger onClick={() => setDeleteTarget(u)}>
                    <Icon name="dots" size={14} />
                  </Btn>
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>

      <Card title="Invite" sub="Add a household member.">
        <Row label="Send to">
          <div class="kv-row grow">
            <TextField
              value={newName}
              onChange={(e) => setNewName((e.target as HTMLInputElement).value)}
              placeholder="e.g. Jordan"
              fullWidth
              disabled={slotsFree === 0}
            />
            <Btn
              kind="primary"
              size="sm"
              icon={<Icon name="plus" size={11} />}
              onClick={() => setAddOpen(true)}
              disabled={slotsFree === 0 || !newName.trim()}
            >
              Add
            </Btn>
          </div>
        </Row>
      </Card>

      {addOpen && (
        <Modal
          title="New member"
          onClose={() => setAddOpen(false)}
          footer={
            <>
              <Btn kind="ghost" size="sm" onClick={() => setAddOpen(false)}>Cancel</Btn>
              <Btn
                kind="primary"
                size="sm"
                disabled={!newName.trim() || !PIN_PATTERN.test(newPin)}
                onClick={handleCreate}
              >
                Create
              </Btn>
            </>
          }
        >
          <div class="modal-fields">
            <label class="mf">
              <span class="mf-l">Display name</span>
              <TextField value={newName} onChange={(e) => setNewName((e.target as HTMLInputElement).value)} fullWidth />
            </label>
            <label class="mf">
              <span class="mf-l">PIN (4 digits)</span>
              <TextField
                value={newPin}
                onChange={(e) => setNewPin((e.target as HTMLInputElement).value)}
                type="password"
                placeholder="****"
                fullWidth
              />
            </label>
            <label class="mf">
              <span class="mf-l">
                <input type="checkbox" checked={newIsAdmin} onChange={(e) => setNewIsAdmin((e.target as HTMLInputElement).checked)} />
                {" "}Admin
              </span>
            </label>
          </div>
        </Modal>
      )}

      {deleteTarget && (
        <Modal
          title={`Remove ${deleteTarget.displayName}?`}
          onClose={() => setDeleteTarget(null)}
          footer={
            <>
              <Btn kind="ghost" size="sm" onClick={() => setDeleteTarget(null)}>Cancel</Btn>
              <Btn kind="primary" size="sm" danger onClick={() => handleDelete(deleteTarget)}>Remove</Btn>
            </>
          }
        >
          <p class="modal-lead">This signs them out and removes their agent. This cannot be undone.</p>
        </Modal>
      )}
    </>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd gateway/webui
bun run typecheck
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add gateway/webui/src/components/settings/panes/members-pane.tsx
git commit -m "feat(webui-settings): add Members pane (list + invite + delete; ports admin-api)"
```

---

### Task 24: Provider keys pane (WIP placeholder)

**Files:**
- Create: `gateway/webui/src/components/settings/panes/provider-keys-pane.tsx`

**Reference:** `09-settings-provider-keys.png` (future visual contract). Pane is a static WIP placeholder per spec Section 4.

- [ ] **Step 1: Create `provider-keys-pane.tsx`**

```tsx
// gateway/webui/src/components/settings/panes/provider-keys-pane.tsx
import type { JSX } from "preact";
import { Card } from "../primitives/card.tsx";
import { PaneHead } from "../primitives/pane-head.tsx";
import { WipBadge } from "../primitives/wip-badge.tsx";

export function ProviderKeysPane(): JSX.Element {
  return (
    <>
      <PaneHead
        title="Provider keys"
        sub="Encrypted at rest. Shared by the household gateway."
        action={<WipBadge />}
      />

      <Card title="Coming soon">
        <p class="pane-body">
          Provider keys management is coming. For now, an admin sets keys server-side via
          the gateway environment. We'll surface rotation, revocation, and audit here once
          the backend supports it safely.
        </p>
      </Card>
    </>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd gateway/webui
bun run typecheck
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add gateway/webui/src/components/settings/panes/provider-keys-pane.tsx
git commit -m "feat(webui-settings): add Provider keys pane (WIP placeholder)"
```

---

### Task 25: Panes CSS (consolidated)

**Files:**
- Create: `gateway/webui/src/components/settings/panes/panes.css`

- [ ] **Step 1: Port pane-specific CSS from v2 styles.css**

Open `sentient-webui-design-v2/styles.css` and port (under `.settings-v2` namespace) the blocks for these classes:

`.pane-head, .pane-sub, .pane-action, .pane-error, .pane-loading, .pane-body, .md-wrap, .md-prev, .lst, .lst-row, .lst-row-main, .lst-row-btn, .lst-chev, .lst-body, .lst-title, .lst-acts, .lst-edit, .lst-edit-acts, .lst-edit-bar, .lst-row-new, .tag, .tag-active, .filterbar, .chips-row, .voice-grid, .voice, .voice.sel, .v-cov, .v-play, .v-meta, .v-name, .v-info, .v-lang, .v-check, .empty-pad, .pager, .pager-info, .pager-ctrls, .pager-num, .prov-body, .prov-row, .prov-row-s, .prov-search, .model-grid, .mod, .mod-top, .mod-id, .mod-meta, .mod-price, .mod-dot, .mod-ctx, .mod-caps, .cap, .mod-sel-tag, .mcp-list, .mcp, .mcp.off, .mcp-h, .mcp-h-btn, .mcp-chev, .mcp-id, .mcp-name, .mcp-desc, .mcp-url, .mcp-count, .kbd, .tool-table, .tool-row, .tool-row.on, .tool-row.off, .tc-tog, .tc-name, .tc-desc, .member-list, .member, .avatar, .info, .name, .sub, .role-pill, .kebab, .role-pill.admin, .role-pill.member, .kv-row, .grow, .modal-lead, .modal-fields, .mf, .mf-l, .muted, .xs, .account-section__error`

Map any `var(--bg)` / `var(--ink)` / `var(--terra)` etc. → `var(--color-bg)` / `var(--color-ink)` / `var(--color-accent)`. Save under the `.settings-v2` namespace prefix.

- [ ] **Step 2: Build the webui**

```bash
cd gateway/webui
bun run build
```

Expected: build succeeds (CSS is not yet imported in main.tsx — that happens in Task 26).

- [ ] **Step 3: Commit**

```bash
git add gateway/webui/src/components/settings/panes/panes.css
git commit -m "feat(webui-settings): port pane-level CSS from v2 styles.css under .settings-v2 namespace"
```

---

## Phase 6 — Wire-up

### Task 26: Wire `settings-view.tsx` (top container with tab + dirty + apply-bar)

**Files:**
- Create: `gateway/webui/src/components/settings/settings-view.tsx` (replaces existing — but the existing file gets deleted in Task 28; create the new one with the same path so imports keep working)
- Create: `gateway/webui/src/components/settings/settings-shell.css`
- Modify: `gateway/webui/src/main.tsx` (add CSS imports)

- [ ] **Step 1: Delete the old `settings-view.tsx`** (the new one replaces it)

```bash
rm gateway/webui/src/components/settings/settings-view.tsx
```

- [ ] **Step 2: Create the new `settings-view.tsx`**

```tsx
// gateway/webui/src/components/settings/settings-view.tsx
import type { JSX } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import { useAuth } from "../../hooks/use-auth.tsx";
import { createProfileApi, type ProfileV1, type SoulDoc } from "../../services/profile-api.js";
import { createProvidersApi } from "../../services/providers-api.ts";
import { SidebarNav } from "./sidebar/sidebar-nav.tsx";
import { SidebarStatus } from "./sidebar/sidebar-status.tsx";
import { ApplyBar } from "./apply-bar/apply-bar.tsx";
import type { ApplyDeps, PendingOpWithPayload } from "./apply-bar/apply-bar-machine.ts";
import { NAV_GROUPS, SOUL_KEYS, type SidebarKey } from "./sidebar/nav-config.ts";
import { PersonaPane } from "./panes/persona-pane.tsx";
import { PersonalitiesPane } from "./panes/personalities-pane.tsx";
import { VoicePane } from "./panes/voice-pane.tsx";
import { ModelPane } from "./panes/model-pane.tsx";
import { ToolsPane } from "./panes/tools-pane.tsx";
import { AdvancedPane } from "./panes/advanced-pane.tsx";
import { AccountPane } from "./panes/account-pane.tsx";
import { MembersPane } from "./panes/members-pane.tsx";
import { ProviderKeysPane } from "./panes/provider-keys-pane.tsx";

const log = createLogger(["sentient", "webui", "settings", "view"]);

export function SettingsView(): JSX.Element {
  const auth = useAuth();
  const profileApi = useMemo(() => createProfileApi(), []);
  const providersApi = useMemo(() => createProvidersApi(), []);

  const [tab, setTab] = useState<SidebarKey>("persona");
  const [pending, setPending] = useState<PendingOpWithPayload[]>([]);
  const [profileDraft, setProfileDraft] = useState<ProfileV1 | null>(null);
  const [profileOriginal, setProfileOriginal] = useState<ProfileV1 | null>(null);
  const [soulOriginal, setSoulOriginal] = useState<SoulDoc | null>(null);
  const [soulDraft, setSoulDraft] = useState<string | null>(null);

  const isAuthed = auth.status === "authenticated";
  const token = isAuthed ? auth.token : "";

  useEffect(() => {
    if (!isAuthed || profileOriginal) return;
    (async () => {
      const r = await profileApi.getMe(token);
      if (r.ok) { setProfileOriginal(r.value); setProfileDraft(r.value); }
      else log.warn("getMe.failed", { code: r.error.code });
    })();
  }, [profileApi, isAuthed, token, profileOriginal]);

  if (!isAuthed) return <></>;

  const dirtyKeys = new Set(pending.map((p) => keyToTab(p.key)).filter((k): k is SidebarKey => k !== null));

  const mark = (op: PendingOpWithPayload) => {
    setPending((arr) => {
      const filtered = arr.filter((x) => x.key !== op.key);
      return [...filtered, op];
    });
  };

  const onApplied = async () => {
    setPending([]);
    // Re-fetch authoritative state
    const r = await profileApi.getMe(token);
    if (r.ok) { setProfileOriginal(r.value); setProfileDraft(r.value); }
    const s = await profileApi.getSoul(token);
    if (s.ok) { setSoulOriginal(s.value); setSoulDraft(s.value.content); }
  };

  const onDiscard = () => {
    setPending([]);
    if (profileOriginal) setProfileDraft(profileOriginal);
    if (soulOriginal) setSoulDraft(soulOriginal.content);
  };

  const deps = makeApplyDeps(profileApi, token);

  const enabledMcpCount = countEnabledMcp(profileDraft);

  return (
    <div class="settings-v2">
      <aside class="s-side">
        <SidebarNav active={tab} onChange={setTab} dirtyKeys={dirtyKeys} />
        <SidebarStatus enabledMcpCount={enabledMcpCount} />
      </aside>

      <main class="s-main">
        <div class="s-pane">
          {tab === "persona" && profileDraft && (
            <PersonaPane
              api={profileApi}
              token={token}
              onMark={mark}
              onRestoreDefault={(body) => { setSoulDraft(body); mark({ key: "persona.soul", kind: "slow", payload: body }); }}
              draft={soulDraft}
              original={soulOriginal}
              setOriginal={setSoulOriginal}
              setDraft={setSoulDraft}
            />
          )}
          {tab === "personalities" && <PersonalitiesPane api={profileApi} token={token} onMark={mark} />}
          {tab === "voice" && profileDraft && (
            <VoicePane
              api={providersApi}
              token={token}
              draft={profileDraft}
              onMark={mark}
              onDraftVoice={(voice) => setProfileDraft({ ...profileDraft, voice })}
            />
          )}
          {tab === "model" && profileDraft && (
            <ModelPane
              api={providersApi}
              token={token}
              draft={profileDraft}
              onMark={mark}
              onDraftModel={(model) => setProfileDraft({ ...profileDraft, model })}
            />
          )}
          {tab === "tools" && profileDraft && (
            <ToolsPane
              draft={profileDraft}
              onMark={mark}
              onDraftTools={(tools) => setProfileDraft({ ...profileDraft, tools })}
            />
          )}
          {tab === "advanced" && profileDraft && (
            <AdvancedPane
              draft={profileDraft}
              onMark={mark}
              onDraftCompression={(compression) => setProfileDraft({ ...profileDraft, compression })}
              onDraftAdvanced={(advanced) => setProfileDraft({ ...profileDraft, advanced })}
            />
          )}
          {tab === "account" && <AccountPane />}
          {tab === "members" && <MembersPane />}
          {tab === "provider-keys" && <ProviderKeysPane />}
        </div>
      </main>

      {SOUL_KEYS.has(tab) && (
        <ApplyBar pending={pending} deps={deps} onApplied={onApplied} onDiscard={onDiscard} />
      )}
    </div>
  );
}

function keyToTab(key: string): SidebarKey | null {
  if (key.startsWith("persona.")) return "persona";
  if (key.startsWith("personalities.")) return "personalities";
  if (key === "profile.voice") return "voice";
  if (key === "profile.model") return "model";
  if (key.startsWith("profile.tools")) return "tools";
  if (key.startsWith("profile.compression") || key.startsWith("profile.advanced.")) return "advanced";
  return null;
}

function countEnabledMcp(profile: ProfileV1 | null): number {
  if (!profile) return 0;
  // Tools shape mirrors the existing tools-section.tsx contract; fall back to 0 if unrecognized.
  const tools = (profile.tools as unknown as Array<{ enabled: boolean }>) ?? [];
  return tools.filter((t) => t && t.enabled).length;
}

function makeApplyDeps(profileApi: ReturnType<typeof createProfileApi>, token: string): ApplyDeps {
  return {
    saveSoul: async (body) => {
      const r = await profileApi.putSoul(token, body);
      if (!r.ok) return { ok: false, errorMessage: r.error.code };
      return { ok: true };
    },
    saveProfile: async (draft) => {
      const r = await profileApi.putProfile(token, draft as ProfileV1);
      if (!r.ok) return { ok: false, errorMessage: r.error.code };
      return { ok: true };
    },
    savePersonalityActive: async (name) => {
      const r = await profileApi.postActivePersonality(token, name);
      if (!r.ok) return { ok: false, errorMessage: r.error.code };
      return { ok: true };
    },
    savePersonalityBody: async (name, body) => {
      const r = await profileApi.putPersonality(token, name, body);
      if (!r.ok) return { ok: false, errorMessage: r.error.code };
      return { ok: true };
    },
    savePersonalityCreate: async (name, body) => {
      const r = await profileApi.postPersonality(token, name, body);
      if (!r.ok) return { ok: false, errorMessage: r.error.code };
      return { ok: true };
    },
    savePersonalityDelete: async (name) => {
      const r = await profileApi.deletePersonality(token, name);
      if (!r.ok) return { ok: false, errorMessage: r.error.code };
      return { ok: true };
    },
    waitForRestart: async () => {
      // The existing API returns the restart result inside putSoul/putProfile/etc.
      // For the unified bar we resolve immediately as "ready" — restart was already
      // exercised by the save call's RestartResult. (See follow-up: surface
      // elapsedMs from the underlying RestartResult into the spinner.)
      return { state: "ready", elapsedMs: 0 };
    },
  };
}
```

- [ ] **Step 3: Create `settings-shell.css`**

```css
/* gateway/webui/src/components/settings/settings-shell.css */

.settings-v2 {
  display: grid;
  grid-template-columns: 240px 1fr;
  min-height: calc(100vh - 56px); /* topbar height; adjust if it differs */
  background: var(--color-bg);
  color: var(--color-ink);
  font-family: var(--font-ui);
}

.settings-v2 .s-side {
  display: flex;
  flex-direction: column;
}

.settings-v2 .s-main {
  padding: 32px 40px 80px;
  overflow-y: auto;
}

.settings-v2 .s-pane {
  max-width: 760px;
  display: flex;
  flex-direction: column;
  gap: 22px;
}
```

- [ ] **Step 4: Wire CSS imports in `main.tsx`**

Open `gateway/webui/src/main.tsx`. Find existing CSS imports. Add (alphabetical or after `components.css`):

```ts
import "./components/settings/settings-shell.css";
import "./components/settings/sidebar/sidebar.css";
import "./components/settings/apply-bar/apply-bar.css";
import "./components/settings/primitives/primitives.css";
import "./components/settings/panes/panes.css";
```

- [ ] **Step 5: Typecheck and build**

```bash
cd gateway/webui
bun run typecheck
bun run build
```

Expected: typecheck pass; build succeeds.

- [ ] **Step 6: Manual eyeball — start dev server, click through every pane**

```bash
cd /Users/kevinye/Development/sentient
source scripts/env.sh
bun run dev
```

Open `https://localhost:8888/`. Click the Settings icon in the topbar. Verify against each reference screenshot:

- Sidebar with Soul/User/Admin groups + 9 items.
- Click each pane in order; main area swaps; active state on sidebar.
- Type in Persona's Soul.md textarea → Apply bar slides up at bottom.
- Switch to Account → Apply bar disappears.

Stop dev server.

- [ ] **Step 7: Commit**

```bash
git add gateway/webui/src/components/settings/settings-view.tsx \
        gateway/webui/src/components/settings/settings-shell.css \
        gateway/webui/src/main.tsx
git commit -m "feat(webui-settings): wire SettingsView with sidebar + panes + apply bar"
```

---

## Phase 7 — Cleanup

### Task 27: Delete old settings TS/TSX files

**Files:** delete (per spec Section 5).

- [ ] **Step 1: Delete the old files**

```bash
rm gateway/webui/src/components/settings/invites-panel.tsx \
   gateway/webui/src/components/settings/permission-grid.tsx \
   gateway/webui/src/components/settings/permissions-panel.tsx \
   gateway/webui/src/components/settings/session-row.tsx \
   gateway/webui/src/components/settings/sessions-panel.tsx \
   gateway/webui/src/components/settings/voices-panel.tsx \
   gateway/webui/src/components/settings/system-panel.tsx \
   gateway/webui/src/components/settings/settings-tabs.tsx \
   gateway/webui/src/components/settings/my-agent-tab.tsx \
   gateway/webui/src/components/settings/my-account-tab.tsx \
   gateway/webui/src/components/settings/members-panel.tsx \
   gateway/webui/src/components/settings/member-add-form.tsx \
   gateway/webui/src/components/settings/member-delete-modal.tsx \
   gateway/webui/src/components/settings/member-row.tsx \
   gateway/webui/src/components/settings/wip-badge.tsx \
   gateway/webui/src/data/household-fixtures.ts
rm -rf gateway/webui/src/components/settings/my-agent
```

- [ ] **Step 2: Find and remove dangling imports**

```bash
cd gateway/webui
rg --no-heading "from .*(invites-panel|permission-grid|permissions-panel|session-row|sessions-panel|voices-panel|system-panel|settings-tabs|my-agent-tab|my-account-tab|members-panel|member-add-form|member-delete-modal|member-row|wip-badge|my-agent/|household-fixtures)" src/
```

Expected: no results. If any match, fix the importer (likely `app.tsx` for the topbar route or a now-orphan test).

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck
```

Expected: pass.

- [ ] **Step 4: Run unit tests**

```bash
bun run test
```

Expected: pass. The deleted `apply-footer.test.tsx` tests are gone; only the new `apply-bar-machine.test.ts` remains for that surface.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(webui-settings): delete old settings TSX + household-fixtures"
```

---

### Task 28: Strip old settings CSS from `components.css`

**Files:**
- Modify: `gateway/webui/src/styles/components.css`

- [ ] **Step 1: Identify old settings selectors to remove**

In `gateway/webui/src/styles/components.css`, locate and delete every block whose selector starts with one of:

`.settings`, `.settings-tabs`, `.settings-panel`, `.settings-ghost-btn`, `.my-agent`, `.member-list`, `.member`, `.member-add`, `.system-panel`, `.account-section`, `.permission-grid`, `.permissions-panel`, `.soul-section`, `.personality-section`, `.voice-section`, `.voice-row`, `.model-section`, `.tools-section`, `.advanced-section`, `.session-row`, `.sessions-panel`, `.invites-panel`, `.modal__input`, `.modal__field`.

**Do NOT delete** anything related to: `.message-list`, `.message-bubble`, `.composer`, `.dock`, `.topbar`, `.brand`, `.app`, `.crumbs`, `.icon-btn`, `.bubble-text`, `.bubble-speaking-wave`, `.tool-pill`, `.interrupt-chip`, `.day-divider`, `.suggestion-chips`, `.spinner-overlay`, `.toast`, `.role-pill` (used by both — keep), `.avatar` (used by both — keep), `.setup-screen`, `.login-screen`, `.pin-pad`, `.avatar-tile`, `.audio-preview`, `.status-chip`, `.icon-button`.

When in doubt, search for the selector in the new code (`gateway/webui/src/components/settings/**`) — if it's referenced by new code, leave it; otherwise delete.

- [ ] **Step 2: Build to verify nothing broke**

```bash
bun run build
```

Expected: build succeeds.

- [ ] **Step 3: Manual eyeball — dev server, all routes**

```bash
cd /Users/kevinye/Development/sentient
source scripts/env.sh
bun run dev
```

Click through chat (`https://localhost:8888/`) and settings. Verify nothing visual broke.

- [ ] **Step 4: Commit**

```bash
git add gateway/webui/src/styles/components.css
git commit -m "chore(webui-settings): strip old settings CSS from components.css"
```

---

## Phase 8 — Verification

### Task 29: Full local CI + manual eyeball pass

**Files:** none.

- [ ] **Step 1: Run full local CI**

```bash
cd /Users/kevinye/Development/sentient
source scripts/env.sh
bun run ci
```

Expected: lint + typecheck + tests all pass. If anything fails, fix and re-run before proceeding.

- [ ] **Step 2: Manual eyeball — every pane against every reference screenshot**

```bash
bun run dev
```

For each row in spec Section "Reference visuals", open the matching screenshot side-by-side with the rendered pane. Verify:
- Layout matches (sidebar widths, card spacing, button placement).
- Fonts: Fraunces on `<h2>` headings; DM Sans on body / inputs / chips.
- Colors: bg `#2B2621`, accent `#F2A06A`, ink `#F2E8D6`, line `#4A4138`.
- Apply bar appears only on Soul-group panes when something is dirty.
- Apply bar reads "Apply" if only personality activate is dirty; "Apply & Restart" otherwise.
- No console errors, no 5xx network calls.

If anything diverges, fix it in place before committing — don't defer.

- [ ] **Step 3: Final commit if any fixes were made**

```bash
git add -A
git commit -m "fix(webui-settings): final eyeball pass corrections"
```

If no changes, skip this step.

---

## Phase 9 — QA charter + auto-run

### Task 30: Author `qa/web/charters/settings-page.md`

**Files:**
- Create: `qa/web/charters/settings-page.md`

- [ ] **Step 1: Write the charter file (full content per spec Section 6A)**

Create `qa/web/charters/settings-page.md` with:

```markdown
---
id: settings-page
area: settings
auth: seeded
concurrency_key: null
risk_hint: high
oracles:
  - shared.console-error-free
  - shared.network-no-5xx
  - shared.few-hiccupps.product-consistency
  - shared.no-stuck-state
  - web.no-blank-render-after-3s
  - web.no-broken-images
  - web.tap-target-min-44px
  - settings.apply-bar-only-when-dirty
  - settings.restart-spinner-resolves
---

# Charter: settings-page (sentient)

**Mission:** Walk every pane in the v2 settings sidebar and exercise
each interactive case in under 8 minutes. Confirm the apply-bar shows
only for Soul-group dirty state, that restart cycles resolve, and that
no pane regresses Dusk theming after the v2 rewrite.

## Preconditions

- Stack up at https://localhost:8888.
- Fresh seeded auth profile (login charter runs first if stale).
- At least one MCP server registered in `gateway/config.yaml#mcp_catalog`.

## Touchpoints (run in order; each touches one pane + its interactives)

### 1. Sidebar shell
- Click Settings in topbar → sidebar renders with three groups
  (SOUL / USER / ADMIN) and 9 nav items.
- Bottom status reads "Healthy · N MCP connected" with N matching the
  configured catalog.
- Brand block reads "Sentient Gateway" + "Hermes <version>".

### 2. Persona pane (Soul.md)
- Edit textarea: type a char → dirty dot on Persona nav item appears,
  apply-bar slides up reading "1 pending change · Apply & Restart".
- Switch Edit→Preview seg → markdown rendered (h2 / list / code spans
  visible).
- Click Restore default → textarea repopulates with default; dirty
  state stays.
- Click Discard → textarea reverts; apply-bar hides; dirty dot clears.
- Click Apply & Restart → spinner runs (≤ 30s), resolves to ready,
  textarea persists.

### 3. Personalities pane
- All personalities list renders with one Active tag.
- Click Activate on a non-active row → row updates without apply-bar
  appearing (instant op; oracle: apply-bar-only-when-dirty must NOT
  fire here).
- Expand a row chevron → inline body textarea appears.
- Edit body → apply-bar appears with "Apply & Restart".
- Click New → name + body inputs appear; apply-bar shows on type.
- Click Delete on a row → confirm gate; second click commits and
  triggers restart.

### 4. Voice pane
- Library renders ≥ 1 voice tile from providersApi.listVoices.
- Type in search → list filters live.
- Click a lang chip (e.g. en-US) → list filters by language.
- Paginate (if >8 voices) → next/prev buttons advance.
- Click a voice tile → tile gets selected ring; apply-bar appears.
- Apply & Restart resolves.

### 5. Model pane
- Provider segmented defaults to current `profile.model.provider`.
- Toggle to other provider → list refetches.
- Type in search → live filter.
- Click a model card → SELECTED tag appears; apply-bar shows.

### 6. Tools pane
- Server list renders with N enabled / M total chips.
- Click server row → expands to per-tool table.
- Toggle server off → all tools disable; apply-bar shows.
- Toggle a single tool → server stays enabled; apply-bar updates.
- "Add server" button MUST be hidden in v1 (backend not built).

### 7. Advanced pane
- Drag compression slider → value text updates live, apply-bar shows.
- Drag max tokens slider → same.
- Type in prompt-injection textarea → same.

### 8. Account pane (USER group)
- apply-bar must NOT appear at any point on this pane.
- Edit display name + Save → toast "Display name updated".
- Click Change PIN → modal opens. Cancel via Esc, X, scrim, Cancel.
- Enter wrong current PIN → inline error.
- Enter correct current + valid new + matching confirm → toast
  "PIN updated", modal closes.
- Click Log out → returns to login screen.

### 9. Members pane (ADMIN group)
- apply-bar must NOT appear.
- List renders real users from adminApi.listUsers.
- Add member with valid display name + 4-digit PIN → spinner-overlay
  shows "Applying changes…", then row appears, toast "X added".
- Toggle a non-self user's admin role → toast.
- Click delete on a non-self user → confirm modal; confirm triggers
  spinner-overlay + row removal.

### 10. Provider keys pane (ADMIN group, WIP)
- Pane shows WIP badge + the placeholder copy explaining the security
  deferral. No interactive controls.

### 11. Cross-pane sanity (visual)
- Switch between every pane in sequence; sidebar active state follows;
  main pane scroll position resets per pane.
- Fraunces (display) renders on <h2> headings; DM Sans (UI) on body /
  inputs / chips.
- Dusk colors: bg #2B2621, accent terra #F2A06A, ink #F2E8D6 on every
  pane.
- No console errors / warnings / 5xx network during the entire walk.

## Things to skip
- TTS audio quality, AEC — out of scope for settings UI.
- Voice-print enrollment — backend WIP; placeholder only.
- Provider-key reveal/rotate — backend deferred per security review.

## Notes for the Reporter
- A failing apply-bar visibility test (bar shows on Account/Members,
  or doesn't show on Soul-group dirty) is severity:critical — that's a
  contract regression.
- Any pane that doesn't match its reference screenshot in
  `sentient-webui-design-v2/screenshots/` (within minor antialiasing
  tolerance) is severity:major.
```

- [ ] **Step 2: Commit**

```bash
git add qa/web/charters/settings-page.md
git commit -m "test(qa): add settings-page charter for /qa-session web settings-page"
```

---

### Task 31: Add settings-specific oracles to `qa/web/oracles.md`

**Files:**
- Modify: `qa/web/oracles.md`

- [ ] **Step 1: Append to the "Project-specific oracles" section**

Append before the closing `<!--` comment block in `qa/web/oracles.md`:

```markdown
### settings.apply-bar-only-when-dirty
**Checks:** The docked apply-bar at the bottom of the settings page is
visible IFF the active sidebar tab belongs to the Soul group AND at
least one Soul-group field is dirty. It MUST NOT appear on Account,
Members, or Provider keys panes regardless of dirty state.
**How:** After every interactive action in the settings page, query
`document.querySelector('.settings-v2 .apply-bar')` visibility. Fire
if visible on User/Admin panes, or if hidden when Soul fields show
dirty dots.
**Severity:** critical (contract regression).

### settings.restart-spinner-resolves
**Checks:** When Apply & Restart is clicked, the spinner must
transition saving → restarting → ready (or failed) within 30s. Never
stick on "Restarting…" forever.
**How:** After clicking Apply & Restart, watch the spinner element for
≤ 30s. Capture screenshot if it doesn't reach a terminal state.
**Severity:** major (user-blocking).
```

- [ ] **Step 2: Commit**

```bash
git add qa/web/oracles.md
git commit -m "test(qa): add settings.apply-bar-only-when-dirty + settings.restart-spinner-resolves oracles"
```

---

### Task 32: Run `/qa-session web settings-page` (auto-go), iteration 1

**Files:** none directly; reads/writes `qa/web/findings/` and `qa/web/sessions/`.

- [ ] **Step 1: Confirm prerequisites**

```bash
docker compose -f deploy/docker/docker-compose.yml ps
```

Expected: `gateway` container is running. If not, qa-session's stack bringup will start it.

```bash
ls qa/web/.playwright/profiles/ 2>/dev/null || echo "no auth profile yet — login charter will run first"
```

- [ ] **Step 2: Invoke `/qa-session web settings-page`**

Use the Skill tool with skill name `qa-session` and args `web settings-page`.

When the skill prints the preamble ending with "Reply `go` to proceed, `dry-run` to plan and stop, or describe anything different you want.", reply `go` exactly. (This auto-go consent is granted by the user's approval of the spec; it is documented as T_FINAL_3 in the spec.)

The skill will:
1. Run `detect_context.sh web` (recon).
2. Plan via Planner subagent.
3. Bring up gateway container if not running (idempotent).
4. Run login charter if seeded auth is stale.
5. Run settings-page Explorer (real browser session, ~5–8 minutes).
6. Run Reporter (PROOF debrief, classifies bugs vs issues).
7. Commit findings to `qa/web/findings/`.
8. Print handoff with session_id and counts.

Record the printed `session_id` for the next steps.

- [ ] **Step 3: Read findings**

```bash
SESSION_ID=<paste the session_id from step 2>
cat "qa/web/sessions/${SESSION_ID}/session-sheet.md"
ls "qa/web/findings/bugs/"
cat qa/web/findings/issues.md | tail -100
```

Note any new bug JSONs (filename will be `B-YYYY-MM-DD-<short>.json`) and any new issues sections dated today.

- [ ] **Step 4: Triage (write a short triage memo)**

Produce a short markdown summary in your scratchpad (don't commit):

```
Iteration 1 triage:
- Bugs (severity:critical): list of B-IDs + one-line title each
- Bugs (severity:major):    ...
- Bugs (severity:minor):    ...
- Issues (UX feel):         ...
- Issues (tester-blocker):  ...
- Decision per item: FIX-NOW / DOCUMENT-AS-FOLLOWUP / DEFER
```

- [ ] **Step 5: Decide path forward**

- If **no bugs of severity ≥ major** AND remaining issues are all "DOCUMENT-AS-FOLLOWUP" or "DEFER" → skip to Task 34.
- Otherwise → proceed to Task 33 (fix loop).

---

### Task 33: Fix-loop for QA findings (hard cap = 3 iterations including Task 32)

This task represents iterations 2 and 3. Each iteration: fix → re-run /qa-session → triage. Stop when clean OR cap reached.

**Files:** vary by bug. Each fix creates its own commit.

- [ ] **Step 1: Iteration N — apply fixes for FIX-NOW items from previous triage**

For each bug in the FIX-NOW pile from iteration (N-1):
1. Read the bug JSON in `qa/web/findings/bugs/`.
2. Reproduce it locally (the JSON has repro_steps).
3. Edit the source file(s).
4. Run `bun run typecheck && bun run test` to confirm no regression.
5. Commit with a focused message: `fix(webui-settings): <one-line bug title>`.

For each issue in the FIX-NOW pile:
1. Apply the obvious fix (broken layout, wrong copy, missing element).
2. Commit similarly.

- [ ] **Step 2: Iteration N — re-run /qa-session web settings-page**

Repeat Task 32 Step 2 (auto-`go`).

- [ ] **Step 3: Iteration N — re-triage**

Repeat Task 32 Steps 3 and 4. Compare against the previous iteration's findings (oracle: did the fixes actually fix? did anything new regress?).

- [ ] **Step 4: Decide whether to iterate again**

Stop conditions (any one):
- (a) **Clean** — no new bugs of severity ≥ major; remaining issues are DOCUMENT-AS-FOLLOWUP or DEFER.
- (b) **Cap reached** — this was iteration 3 (counting Task 32 as iteration 1).

If (a) — proceed to Task 34.
If (b) — proceed to Task 34 with the **NOT ready** marker (see Task 34 Step 2).
Otherwise — go back to Step 1 with N := N+1.

- [ ] **Step 5: Document any DEFER decisions in the spec's "Open follow-ups" section**

For any bug or issue marked DEFER, append a one-line entry to the `## Open follow-ups (post-merge)` section of `docs/superpowers/specs/2026-04-28-settings-v2-dusk-design.md`. Cite the bug ID or issue title and a brief rationale.

```bash
git add docs/superpowers/specs/2026-04-28-settings-v2-dusk-design.md
git commit -m "docs(spec): record settings v2 deferred QA findings under Open follow-ups"
```

---

### Task 34: Branch readiness handoff

**Files:** none (plan-end checkpoint).

- [ ] **Step 1: Run `bun run ci` one final time**

```bash
cd /Users/kevinye/Development/sentient
source scripts/env.sh
bun run ci
```

Expected: pass.

- [ ] **Step 2: Print readiness summary to the user**

If exit conditions (a) from Task 33 were met, print:

```
✅ feature/settings-v2-dusk is ready for review.

Iterations: <N> of 3
Final findings:
  - Bugs unfixed (severity ≥ major): 0
  - Bugs deferred:    <count> (see spec Open follow-ups)
  - Issues open:      <count> (documented in spec / qa/web/findings/issues.md)

Local CI: passing.

Suggested next step: open a PR against develop.
```

If exit condition (b) (cap reached with unfixed major+ bugs) was hit, print:

```
⚠️  feature/settings-v2-dusk has reached the 3-iteration QA cap with
unresolved findings.

Iterations: 3 of 3 (cap)
Unresolved:
  - Bugs (severity:critical): <count>  — see qa/web/findings/bugs/
  - Bugs (severity:major):    <count>
  - Issues blocking:           <count>

Branch is NOT marked ready. User intervention required: review the
findings and decide whether to (1) authorize additional iterations,
(2) accept the deferrals and merge anyway, or (3) revert specific
panes pending a fix.
```

In either case, do not push or open a PR automatically.

- [ ] **Step 3: Final commit if anything unstaged remains**

```bash
git status --short
```

If there are uncommitted changes (e.g., the spec follow-ups appended in Task 33 Step 5), commit them now:

```bash
git add -A
git commit -m "chore(webui-settings): final readiness checkpoint"
```

---

# Self-review

**Spec coverage:**
- Section 1 Token deltas → Tasks 1, 2, 3, 4 ✓
- Section 2 Settings shell architecture → Tasks 13, 14, 15, 26 ✓
- Section 3 Per-pane data flow → Tasks 16–24 ✓
- Section 4 Content adaptations → Task 14 (sidebar nav with hardcoded "Hermes v0.x"), Task 22 (account pane with "coming soon" Re-enroll), Task 23 (Members real-data wiring), Task 24 (Provider keys WIP placeholder copy) ✓
- Section 5 Cleanup, migration order, CSS strategy → Tasks 27, 28, 29 ✓
- Section 6 QA additions → Tasks 30, 31, 32, 33, 34 ✓
- T_WT_0 (worktree first task) → Task 0 ✓

**Placeholder scan:** No "TBD", "TODO", "fill in details", or "implement later" in any task body. Steps that delegate (e.g., "Port from v2 styles.css") name the exact source file and selectors. CSS port tasks (8, 15, 25, 28) list every selector by name.

**Type consistency:** `PendingOpWithPayload` defined Task 11, used Tasks 12, 16, 17, 18, 19, 20, 21, 26. `SidebarKey` defined Task 13, used 14, 26. `SOUL_KEYS` defined Task 13, used 14, 26. `ApplyDeps` defined Task 11, satisfied Task 26 (`makeApplyDeps`). Method names like `mark`, `onApplied`, `onDiscard`, `setDraft` consistent across pane components and SettingsView.

**Risks I'd flag in reviews:**
- Task 25 (panes.css port) is a large hand-port; visual regressions are easy here. Mitigation: Task 26 Step 6 + Task 29 Step 2 force pane-by-pane eyeball.
- `ProfileV1.tools` shape is treated loosely (`as unknown as`) in Task 20. If the existing `tools-section.tsx` uses a richer schema, mirror it exactly — don't ship the loose cast.
- `waitForRestart` in Task 26 returns `ready` immediately; the existing `RestartResult` from `putSoul`/`putProfile` already covers the restart wait. Followup: thread the elapsedMs through to the spinner for parity with the current UX.
