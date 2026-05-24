# Webui Redesign — Implementation Plan (Phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `gateway/webui/` against the new design (`sentient-webui-design/`, Image #22 variant: dusk + filled + comfortable + Fraunces/DM Sans + bars + default). One semantic token set baked in. Preact components composed around a single hook that derives cycle status, pending-user buffer, and tool grouping from the SDK.

**Architecture:** Hook owns all signals and derivations. Components receive plain props, never the SDK or a store. Token swap = replace files in `styles/tokens/`, no attribute-selector variants. Auto-scroll pins to bottom with near-bottom threshold.

**Tech Stack:** Preact + Vite + TypeScript (strict), Vitest + Testing Library, existing AudioWorklet audio adapters.

**Spec:** `docs/superpowers/specs/2026-04-18-cerebrum-ux-refresh-design.md` §4.

**Depends on:** Phase 1 (`docs/superpowers/plans/2026-04-18-cancel-primitives-cleanup.md`) merged — this plan consumes `cycleId` on `TaskSnapshotItem`.

**Branch:** `feature/cerebrum-ux-refresh` (continues Phase 1).

**Design reference:** `sentient-webui-design/` — React UMD prototype. Read for token values, visual states, interactions. Re-author in Preact + TS; don't copy-paste. Screenshot sources of truth: `sentient-webui-design/screenshots/*.png`, Image #22 (Tweaks panel), Image #24/#26 (dock).

---

## File Map

### Create

**Token files:**
- `gateway/webui/src/styles/tokens/colors.css`
- `gateway/webui/src/styles/tokens/spacing.css`
- `gateway/webui/src/styles/tokens/radius.css`
- `gateway/webui/src/styles/tokens/typography.css`
- `gateway/webui/src/styles/tokens/shadows.css`
- `gateway/webui/src/styles/tokens/motion.css`
- `gateway/webui/src/styles/tokens/index.css`

**Component files (each with matching `.test.tsx`):**
- `gateway/webui/src/components/common/avatar.tsx`
- `gateway/webui/src/components/common/icon.tsx`
- `gateway/webui/src/components/common/icon-button.tsx`
- `gateway/webui/src/components/common/status-chip.tsx`
- `gateway/webui/src/components/common/role-pill.tsx`
- `gateway/webui/src/components/common/icons/` — one file per icon ported from `sentient-webui-design/icons.jsx`
- `gateway/webui/src/components/shell/app-shell.tsx`
- `gateway/webui/src/components/shell/topbar.tsx`
- `gateway/webui/src/components/chat/chat-view.tsx`
- `gateway/webui/src/components/chat/message-list.tsx`
- `gateway/webui/src/components/chat/message-bubble.tsx`
- `gateway/webui/src/components/chat/bubble-text.tsx`
- `gateway/webui/src/components/chat/bubble-speaking-wave.tsx`
- `gateway/webui/src/components/chat/tool-pill-strip.tsx`
- `gateway/webui/src/components/chat/tool-inline-detail.tsx`
- `gateway/webui/src/components/chat/day-divider.tsx`
- `gateway/webui/src/components/chat/interrupt-chip.tsx`
- `gateway/webui/src/components/dock/composer.tsx`
- `gateway/webui/src/components/dock/composer-task-strip.tsx`
- `gateway/webui/src/components/dock/mic-button.tsx`
- `gateway/webui/src/components/dock/send-button.tsx`
- `gateway/webui/src/components/dock/interrupt-button.tsx`
- `gateway/webui/src/components/dock/suggestion-chips.tsx`
- `gateway/webui/src/components/settings/settings-view.tsx`
- `gateway/webui/src/components/settings/settings-tabs.tsx`
- `gateway/webui/src/components/settings/members-panel.tsx`
- `gateway/webui/src/components/settings/permissions-panel.tsx`
- `gateway/webui/src/components/settings/voices-panel.tsx`
- `gateway/webui/src/components/settings/sessions-panel.tsx`
- `gateway/webui/src/components/settings/invites-panel.tsx`
- `gateway/webui/src/components/settings/member-row.tsx`
- `gateway/webui/src/components/settings/permission-grid.tsx`
- `gateway/webui/src/components/settings/session-row.tsx`
- `gateway/webui/src/components/settings/wip-badge.tsx`
- `gateway/webui/src/hooks/use-follow-latest.ts` + test
- `gateway/webui/src/data/household-fixtures.ts`

### Modify

- `gateway/webui/src/types.ts` — extend `ChatMessage` with `cycleId`, `pending`, `tools`
- `gateway/webui/src/hooks/use-voice-client.ts` — add `cycleStatus`, `voiceMode`, pending buffer, tool grouping
- `gateway/webui/src/app.tsx` — render `AppShell` with route state
- `gateway/webui/index.html` — Google Fonts link (Fraunces, DM Sans, JetBrains Mono)

### Delete (at the end, after verifying nothing imports them)

- `gateway/webui/src/components/auth-gate.tsx` + test *(kept if still referenced; re-check)*
- `gateway/webui/src/components/chat-screen.tsx` + test
- `gateway/webui/src/components/input-bar.tsx` + test
- `gateway/webui/src/components/interrupt-button.tsx` *(old; new is under `dock/`)*
- `gateway/webui/src/components/live-transcript.tsx` + test
- `gateway/webui/src/components/message-bubble.tsx` + test *(old, new is under `chat/`)*
- `gateway/webui/src/components/message-list.tsx` + test
- `gateway/webui/src/components/task-sidebar.tsx` + test
- `gateway/webui/src/components/tool-confirm-dialog.tsx` + test
- `gateway/webui/src/components/voice-mode-button.tsx` + test
- `gateway/webui/src/styles/tokens.css` (old)
- `gateway/webui/src/styles/components.css` (old — CSS moves to per-component `.css` or inline per your preference; stick with one global `components.css` rewrite if simpler)

---

## Tasks

### Task 1: Token — colors.css

**Files:**
- Create: `gateway/webui/src/styles/tokens/colors.css`

- [ ] **Step 1: Write colors token file**

Copy values from `sentient-webui-design/styles.css` `[data-theme="dusk"]` block and the base `:root`, merge into one `:root`.

```css
/* gateway/webui/src/styles/tokens/colors.css */
:root {
  /* Surfaces — layered bg depth */
  --color-bg:        #2B2621;
  --color-bg-elev:   #332D28;
  --color-bg-sunk:   #241F1B;
  --color-paper:     #39322C;

  /* Lines */
  --color-line:      #4A4138;
  --color-line-soft: #3E362F;

  /* Ink (text) */
  --color-ink:       #F2E8D6;
  --color-ink-2:     #D7C6AB;
  --color-ink-3:     #9E907E;
  --color-ink-4:     #706456;

  /* Accents */
  --color-accent:       #F2A06A; /* terra — primary */
  --color-accent-soft:  #5A3A28;
  --color-accent-50:    #402C22;
  --color-amber:        #E9B168;
  --color-sage:         #B9C8A6;
  --color-sage-soft:    #3A4232;

  /* Status */
  --color-ok:   #5F8A5B;
  --color-warn: #C2892F;
  --color-stop: #B8442E;
}
```

- [ ] **Step 2: Commit**

```bash
git add gateway/webui/src/styles/tokens/colors.css
git commit -m "feat(webui): add color tokens (dusk variant)"
```

---

### Task 2: Token — spacing, radius, shadows, motion

**Files:**
- Create: `gateway/webui/src/styles/tokens/spacing.css`
- Create: `gateway/webui/src/styles/tokens/radius.css`
- Create: `gateway/webui/src/styles/tokens/shadows.css`
- Create: `gateway/webui/src/styles/tokens/motion.css`

- [ ] **Step 1: Write spacing.css**

```css
/* gateway/webui/src/styles/tokens/spacing.css */
:root {
  --space-xs:   4px;
  --space-sm:   8px;
  --space-md:   12px;
  --space-lg:   18px;
  --space-xl:   26px;
  --space-2xl:  32px;
  --space-3xl:  40px;
}
```

- [ ] **Step 2: Write radius.css**

```css
/* gateway/webui/src/styles/tokens/radius.css */
:root {
  --radius-sm:    8px;
  --radius-md:    12px;
  --radius-lg:    18px;
  --radius-xl:    26px;
  --radius-pill:  999px;
}
```

- [ ] **Step 3: Write shadows.css (dusk halo is here)**

```css
/* gateway/webui/src/styles/tokens/shadows.css */
:root {
  --shadow-1: 0 1px 0 rgba(0, 0, 0, 0.15),
              0 1px 2px rgba(0, 0, 0, 0.25);

  /* Outer terra halo for listening composer + primary cards */
  --shadow-2: 0 1px 0 rgba(0, 0, 0, 0.2),
              0 12px 32px -10px rgba(0, 0, 0, 0.5),
              0 0 40px -20px rgba(242, 160, 106, 0.4);

  --shadow-inset: inset 0 1px 0 rgba(255, 255, 255, 0.04),
                  inset 0 -1px 0 rgba(0, 0, 0, 0.2);
}
```

- [ ] **Step 4: Write motion.css**

```css
/* gateway/webui/src/styles/tokens/motion.css */
:root {
  --motion-fast:     150ms ease;
  --motion-normal:   250ms ease;
  --motion-wave:     3.4s ease-in-out infinite;
  --motion-cursor:   1s steps(2) infinite;
}
```

- [ ] **Step 5: Commit**

```bash
git add gateway/webui/src/styles/tokens/
git commit -m "feat(webui): add spacing/radius/shadow/motion tokens"
```

---

### Task 3: Token — typography + index

**Files:**
- Create: `gateway/webui/src/styles/tokens/typography.css`
- Create: `gateway/webui/src/styles/tokens/index.css`
- Modify: `gateway/webui/index.html` — Google Fonts preconnects + stylesheet

- [ ] **Step 1: Write typography.css**

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

- [ ] **Step 2: Write index.css**

```css
/* gateway/webui/src/styles/tokens/index.css */
@import "./colors.css";
@import "./spacing.css";
@import "./radius.css";
@import "./typography.css";
@import "./shadows.css";
@import "./motion.css";
```

- [ ] **Step 3: Update index.html `<head>` — Google Fonts**

In `gateway/webui/index.html`, add after the existing `<head>` opening (copy block from `sentient-webui-design/Sentient.html:8-10`):

```html
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous"/>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
```

- [ ] **Step 4: Wire `tokens/index.css` into the app entry**

In `gateway/webui/src/main.tsx`, replace any import of the old `./styles/tokens.css` with:

```typescript
import "./styles/tokens/index.css";
```

- [ ] **Step 5: Typecheck**

```
cd gateway/webui && bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add gateway/webui/src/styles/tokens/typography.css gateway/webui/src/styles/tokens/index.css gateway/webui/index.html gateway/webui/src/main.tsx
git commit -m "feat(webui): typography tokens + font loading"
```

---

### Task 4: Port icon library

**Files:**
- Create: `gateway/webui/src/components/common/icons/` (one file per icon)
- Create: `gateway/webui/src/components/common/icon.tsx`
- Create: `gateway/webui/src/components/common/icon.test.tsx`

- [ ] **Step 1: Write icon wrapper test**

```typescript
// gateway/webui/src/components/common/icon.test.tsx
import { render, screen } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { Icon } from "./icon.tsx";

describe("Icon", () => {
  it("renders the named icon svg", () => {
    const { container } = render(<Icon name="mic" />);
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("passes size to the svg", () => {
    const { container } = render(<Icon name="mic" size={24} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("24");
    expect(svg?.getAttribute("height")).toBe("24");
  });

  it("defaults size to 16", () => {
    const { container } = render(<Icon name="send" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("16");
  });
});
```

- [ ] **Step 2: Run to confirm FAIL**

```
cd gateway/webui && bun test src/components/common/icon.test.tsx
```

- [ ] **Step 3: Port each icon from `sentient-webui-design/icons.jsx`**

Read `sentient-webui-design/icons.jsx`. For every named icon there (`mic`, `mic-off`, `send`, `chat`, `bell`, `settings`, `x`, `sliders`, `chevron`, `lamp`, `thermo`, `spark`, `globe`, `music`, `check`, `phone`, `dots`, `plus`, `key`, `tablet`, `laptop`), create one file under `gateway/webui/src/components/common/icons/`:

```typescript
// gateway/webui/src/components/common/icons/mic.tsx
export function MicIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {/* paths copied from sentient-webui-design/icons.jsx */}
    </svg>
  );
}
```

Repeat for every icon. One file per icon (small, testable, tree-shakes cleanly).

- [ ] **Step 4: Write the `Icon` wrapper**

```typescript
// gateway/webui/src/components/common/icon.tsx
import { MicIcon } from "./icons/mic.tsx";
import { MicOffIcon } from "./icons/mic-off.tsx";
// ... import each icon ...

export type IconName =
  | "mic" | "mic-off" | "send" | "chat" | "bell" | "settings"
  | "x" | "sliders" | "chevron" | "lamp" | "thermo" | "spark"
  | "globe" | "music" | "check" | "phone" | "dots" | "plus"
  | "key" | "tablet" | "laptop";

export interface IconProps {
  name: IconName;
  size?: number;
}

const REGISTRY: Record<IconName, (props: { size: number }) => preact.JSX.Element> = {
  mic: MicIcon,
  "mic-off": MicOffIcon,
  // ... map all ...
};

export function Icon({ name, size = 16 }: IconProps) {
  const Component = REGISTRY[name];
  return <Component size={size} />;
}
```

- [ ] **Step 5: Run tests**

```
cd gateway/webui && bun test src/components/common/icon.test.tsx
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add gateway/webui/src/components/common/icon.tsx gateway/webui/src/components/common/icon.test.tsx gateway/webui/src/components/common/icons/
git commit -m "feat(webui): port icon library"
```

---

### Task 5: Common — `IconButton`, `Avatar`, `StatusChip`, `RolePill`

**Files:**
- Create: `gateway/webui/src/components/common/icon-button.tsx` + test
- Create: `gateway/webui/src/components/common/avatar.tsx` + test
- Create: `gateway/webui/src/components/common/status-chip.tsx` + test
- Create: `gateway/webui/src/components/common/role-pill.tsx` + test

For each component, follow the same write-test → fail → implement → pass → commit loop.

- [ ] **Step 1: `icon-button.tsx` — test + impl + commit**

```typescript
// gateway/webui/src/components/common/icon-button.test.tsx
import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { IconButton } from "./icon-button.tsx";

describe("IconButton", () => {
  it("renders with accessible title", () => {
    render(<IconButton iconName="mic" title="Microphone" onClick={() => {}} />);
    expect(screen.getByRole("button", { name: "Microphone" })).toBeTruthy();
  });

  it("fires onClick", () => {
    const fn = vi.fn();
    render(<IconButton iconName="mic" title="t" onClick={fn} />);
    fireEvent.click(screen.getByRole("button"));
    expect(fn).toHaveBeenCalledOnce();
  });

  it("applies active class when active=true", () => {
    const { container } = render(<IconButton iconName="mic" title="t" active onClick={() => {}} />);
    expect(container.querySelector(".icon-btn--active")).toBeTruthy();
  });

  it("applies variant class", () => {
    const { container } = render(<IconButton iconName="mic" title="t" variant="mic-on" onClick={() => {}} />);
    expect(container.querySelector(".icon-btn--mic-on")).toBeTruthy();
  });
});
```

```typescript
// gateway/webui/src/components/common/icon-button.tsx
import type { JSX } from "preact";
import { Icon, type IconName } from "./icon.tsx";

export interface IconButtonProps {
  iconName: IconName;
  title: string;
  active?: boolean;
  variant?: "default" | "interrupt" | "mic-on" | "mic-off";
  onClick(): void;
}

export function IconButton({ iconName, title, active, variant = "default", onClick }: IconButtonProps): JSX.Element {
  const cls = ["icon-btn", `icon-btn--${variant}`, active && "icon-btn--active"].filter(Boolean).join(" ");
  return (
    <button type="button" class={cls} aria-label={title} title={title} onClick={onClick}>
      <Icon name={iconName} size={16} />
    </button>
  );
}
```

```bash
git add gateway/webui/src/components/common/icon-button*
git commit -m "feat(webui): IconButton"
```

- [ ] **Step 2: `avatar.tsx` — test + impl + commit**

Props per spec §4.5. `kind: "user" | "assistant"`. User renders initial + tint class (`avatar--sage` etc). Assistant renders a CSS-gradient orb (terra radial). Write tests for both kinds, each tint variant. Commit with `feat(webui): Avatar`.

- [ ] **Step 3: `status-chip.tsx` — test + impl + commit**

Props: `label`, `indicator?: "live" | "idle" | "off"`. Live = pulsing sage dot. Copy CSS from `sentient-webui-design/styles.css .status-chip`. Commit with `feat(webui): StatusChip`.

- [ ] **Step 4: `role-pill.tsx` — test + impl + commit**

Props: `role`, `label`. Role maps to CSS class (`role-pill--admin`, etc). Copy tints from design CSS `.role-pill.admin/.kid/.guest`. Commit with `feat(webui): RolePill`.

---

### Task 6: Extend `ChatMessage` type

**Files:**
- Modify: `gateway/webui/src/types.ts`

- [ ] **Step 1: Extend `ChatMessage`**

```typescript
// gateway/webui/src/types.ts
import type {
  ConversationAssistantCutoff,
  ConversationUserChannel,
  TaskStatus,
  UserRole,
} from "@sentient/protocol";
import type { TaskSnapshotItem } from "@sentient/web-sdk";

export interface ChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestamp: number;
  readonly isStreaming: boolean;
  readonly cycleId?: string;
  readonly channel?: ConversationUserChannel;
  readonly cutoff?: ConversationAssistantCutoff;
  readonly pending?: boolean;
  readonly tools?: readonly TaskSnapshotItem[];
}

export interface PendingUserMessage {
  readonly pendingId: string;
  readonly text: string;
  readonly createdAtMs: number;
}

// TaskListItem kept for any remaining consumers; may be removed if unused after refactor.
export interface TaskListItem {
  readonly id: string;
  readonly toolName: string;
  readonly argsPreview: string;
  readonly status: TaskStatus;
  readonly timestamp: number;
}

export type AuthState =
  | { status: "pending" }
  | { status: "authenticated"; sessionId: string; role: UserRole }
  | { status: "failed"; reason: string };

export function createChatMessage(
  role: "user" | "assistant",
  text: string,
  overrides: Partial<Pick<ChatMessage, "id" | "isStreaming">> = {},
): ChatMessage {
  return {
    id: overrides.id ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    text,
    timestamp: Date.now(),
    isStreaming: overrides.isStreaming ?? false,
  };
}
```

- [ ] **Step 2: Typecheck**

```
cd gateway/webui && bun run typecheck
```
Expected failures in consumers that don't yet know about new fields; fixed in Task 7.

- [ ] **Step 3: Commit**

```bash
git add gateway/webui/src/types.ts
git commit -m "feat(webui): extend ChatMessage with cycleId/pending/tools"
```

---

### Task 7: Extend `useVoiceClient` — `cycleStatus`, `voiceMode`, pending buffer, tool grouping

**Files:**
- Modify: `gateway/webui/src/hooks/use-voice-client.ts`
- Modify: `gateway/webui/src/hooks/use-voice-client.test.ts`

- [ ] **Step 1: Write tests for each derivation**

```typescript
// additions to use-voice-client.test.ts
describe("deriveCycleStatus", () => {
  it("returns speaking when audio is playing", () => {
    expect(deriveCycleStatus({ cognition: "responding", audioPlaying: true, runningTasks: 0 })).toBe("speaking");
  });
  it("returns streaming when cognition is responding and audio not playing", () => {
    expect(deriveCycleStatus({ cognition: "responding", audioPlaying: false, runningTasks: 0 })).toBe("streaming");
  });
  it("returns awaiting-tasks when idle cognition and tasks running", () => {
    expect(deriveCycleStatus({ cognition: "idle", audioPlaying: false, runningTasks: 2 })).toBe("awaiting-tasks");
  });
  it("returns idle otherwise", () => {
    expect(deriveCycleStatus({ cognition: "idle", audioPlaying: false, runningTasks: 0 })).toBe("idle");
  });
});

describe("pending user buffer", () => {
  it("sendText pushes a pending message, removed on history match", () => {
    // drive hook through a helper; assert messages signal contains pending entry, then confirms
    // (see impl for exact test harness — RTL/renderHook with signals)
  });

  it("matches identical duplicate texts FIFO", () => {
    // send twice with "yes"; confirm they clear in order
  });
});

describe("attachToolsToAssistantMessages", () => {
  it("groups tasks by cycleId onto the owning assistant message", () => {
    const messages = [{ id: "m1", role: "assistant", cycleId: "c1", text: "", timestamp: 0, isStreaming: false }];
    const tasks = [
      { taskId: "t1", cycleId: "c1", toolName: "x", status: "running", argsPreview: "", startedAtMs: 100 },
      { taskId: "t2", cycleId: "c2", toolName: "y", status: "ok", argsPreview: "", startedAtMs: 200 },
    ];
    const out = attachToolsToAssistantMessages(messages, tasks);
    expect(out[0].tools).toHaveLength(1);
    expect(out[0].tools?.[0].taskId).toBe("t1");
  });
});
```

- [ ] **Step 2: Implement `deriveCycleStatus` + export it**

```typescript
// inside use-voice-client.ts
export type CycleStatus = "idle" | "streaming" | "speaking" | "awaiting-tasks";

export function deriveCycleStatus(inputs: {
  cognition: CognitionState;
  audioPlaying: boolean;
  runningTasks: number;
}): CycleStatus {
  if (inputs.audioPlaying) return "speaking";
  if (inputs.cognition === "responding" || inputs.cognition === "planning") return "streaming";
  if (inputs.runningTasks > 0) return "awaiting-tasks";
  return "idle";
}
```

- [ ] **Step 3: Implement `attachToolsToAssistantMessages`**

```typescript
export function attachToolsToAssistantMessages(
  messages: readonly ChatMessage[],
  tasks: readonly TaskSnapshotItem[],
): ChatMessage[] {
  const byCycle = new Map<string, TaskSnapshotItem[]>();
  for (const t of tasks) {
    const arr = byCycle.get(t.cycleId) ?? [];
    arr.push(t);
    byCycle.set(t.cycleId, arr);
  }
  return messages.map((m) => {
    if (m.role !== "assistant" || !m.cycleId) return m;
    const ts = byCycle.get(m.cycleId);
    if (!ts || ts.length === 0) return m;
    const sorted = ts.slice().sort((a, b) => a.startedAtMs - b.startedAtMs);
    return { ...m, tools: sorted };
  });
}
```

- [ ] **Step 4: Implement pending-user buffer**

Inside `useVoiceClient`, maintain a ref-backed buffer:

```typescript
const pendingRef = useRef<PendingUserMessage[]>([]);

function sendText(text: string): void {
  const pendingId = crypto.randomUUID();
  pendingRef.current.push({ pendingId, text, createdAtMs: Date.now() });
  resources.textInputConnector.sendText(text);
  refreshMessages();
}

// in onUpdate for conversationConnector, before calling refreshMessages:
function reconcilePending(items: readonly ConversationFeedItem[]): void {
  for (const item of items) {
    if (item.kind !== "user") continue;
    const matchIdx = pendingRef.current.findIndex((p) => p.text === item.content && item.ts >= p.createdAtMs);
    if (matchIdx >= 0) pendingRef.current.splice(matchIdx, 1);
  }
}
```

And in `deriveMessages`, append remaining pending entries with `pending: true`.

- [ ] **Step 5: Implement `cycleStatus`, `currentCycleId`, `voiceMode` signals**

```typescript
const cycleStatus = useSignal<CycleStatus>("idle");
const currentCycleId = useSignal<string | null>(null);
const voiceMode = useSignal<"off" | "active">("off");

// each SDK callback that changes cognition/audio/tasks also recomputes cycleStatus:
function refreshCycleStatus(): void {
  cycleStatus.value = deriveCycleStatus({
    cognition: cognitionRef.current,
    audioPlaying: isAudioPlayingRef.current,
    runningTasks: runningTasksCountRef.current,
  });
}

// derive currentCycleId from inflight + latest assistant entry
```

- [ ] **Step 6: Expose the extended interface**

```typescript
return {
  status,
  cycleStatus,
  currentCycleId,
  voiceMode,
  messages,
  tasks,
  transcript,
  startVoiceMode: () => { voiceMode.value = "active"; /* existing body */ },
  stopVoiceMode:  () => { voiceMode.value = "off";    /* existing body */ },
  sendText,
  interrupt: () => resources.sdk.interrupt(),
};
```

- [ ] **Step 7: Run tests**

```
cd gateway/webui && bun run test src/hooks/use-voice-client.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add gateway/webui/src/hooks/use-voice-client.ts gateway/webui/src/hooks/use-voice-client.test.ts
git commit -m "feat(webui): cycleStatus + pending buffer + tool grouping in useVoiceClient"
```

---

### Task 8: `useFollowLatest` auto-scroll hook

**Files:**
- Create: `gateway/webui/src/hooks/use-follow-latest.ts`
- Create: `gateway/webui/src/hooks/use-follow-latest.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// gateway/webui/src/hooks/use-follow-latest.test.ts
import { renderHook, act } from "@testing-library/preact";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useFollowLatest } from "./use-follow-latest.ts";

// jsdom-compatible ResizeObserver mock
class FakeRO {
  static instances: FakeRO[] = [];
  callback: ResizeObserverCallback;
  observed: Element[] = [];
  constructor(cb: ResizeObserverCallback) { this.callback = cb; FakeRO.instances.push(this); }
  observe(el: Element) { this.observed.push(el); }
  disconnect() { this.observed = []; }
  trigger() { this.callback([], this as unknown as ResizeObserver); }
}

beforeEach(() => {
  (globalThis as { ResizeObserver?: typeof FakeRO }).ResizeObserver = FakeRO;
  FakeRO.instances = [];
});

function makeRefs() {
  const container = document.createElement("section");
  Object.defineProperty(container, "scrollHeight", { value: 1000, configurable: true });
  Object.defineProperty(container, "clientHeight", { value: 400, configurable: true });
  container.scrollTop = 600;
  const content = document.createElement("div");
  container.appendChild(content);
  document.body.appendChild(container);
  content.scrollIntoView = vi.fn();
  return { container, content };
}

describe("useFollowLatest", () => {
  it("pinToBottom is true when scrollTop close to scrollHeight - clientHeight", () => {
    const { container, content } = makeRefs();
    const { result } = renderHook(() =>
      useFollowLatest({
        scrollContainerRef: { current: container },
        contentRef: { current: content },
        thresholdPx: 100,
      }),
    );
    expect(result.current.pinToBottom).toBe(true);
  });

  it("pinToBottom flips to false when user scrolls up past threshold", () => {
    const { container, content } = makeRefs();
    const { result } = renderHook(() =>
      useFollowLatest({
        scrollContainerRef: { current: container },
        contentRef: { current: content },
        thresholdPx: 100,
      }),
    );
    container.scrollTop = 200; // distFromBottom = 1000 - 200 - 400 = 400 > 100
    act(() => { container.dispatchEvent(new Event("scroll")); });
    expect(result.current.pinToBottom).toBe(false);
  });

  it("scrolls when pinned and content resizes", () => {
    const { container, content } = makeRefs();
    renderHook(() =>
      useFollowLatest({
        scrollContainerRef: { current: container },
        contentRef: { current: content },
        thresholdPx: 100,
      }),
    );
    // Resize while pinned
    act(() => { FakeRO.instances[0].trigger(); });
    // The hook scrolls via a sentinel inside contentRef — assert scrollIntoView was called
    // (sentinel is the last child; use querySelector)
    // (exact assertion depends on impl; minimally, scrollIntoView fires on some child)
  });

  it("does not scroll when unpinned and content resizes", () => {
    const { container, content } = makeRefs();
    const { result } = renderHook(() =>
      useFollowLatest({
        scrollContainerRef: { current: container },
        contentRef: { current: content },
        thresholdPx: 100,
      }),
    );
    container.scrollTop = 100;
    act(() => { container.dispatchEvent(new Event("scroll")); });
    expect(result.current.pinToBottom).toBe(false);
    act(() => { FakeRO.instances[0].trigger(); });
    // scrollIntoView not called again
  });
});
```

- [ ] **Step 2: Run tests, confirm FAIL**

- [ ] **Step 3: Implement `useFollowLatest`**

```typescript
// gateway/webui/src/hooks/use-follow-latest.ts
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { RefObject } from "preact";

export interface UseFollowLatestArgs {
  scrollContainerRef: RefObject<HTMLElement>;
  contentRef: RefObject<HTMLElement>;
  thresholdPx?: number;
}

export interface UseFollowLatestReturn {
  readonly pinToBottom: boolean;
  jumpToLatest(): void;
}

export function useFollowLatest({
  scrollContainerRef,
  contentRef,
  thresholdPx = 100,
}: UseFollowLatestArgs): UseFollowLatestReturn {
  const [pinToBottom, setPinToBottom] = useState(true);
  const pinRef = useRef(true);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Inject the sentinel
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const sentinel = document.createElement("div");
    sentinel.setAttribute("aria-hidden", "true");
    sentinel.style.height = "0";
    content.appendChild(sentinel);
    sentinelRef.current = sentinel;
    sentinel.scrollIntoView({ block: "end", behavior: "auto" });
    return () => { sentinel.remove(); sentinelRef.current = null; };
  }, [contentRef]);

  // scroll listener → update pin state
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      const pinned = dist < thresholdPx;
      pinRef.current = pinned;
      setPinToBottom(pinned);
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollContainerRef, thresholdPx]);

  // ResizeObserver on content → scroll if pinned
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const ro = new ResizeObserver(() => {
      if (!pinRef.current) return;
      sentinelRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [contentRef]);

  const jumpToLatest = useCallback(() => {
    pinRef.current = true;
    setPinToBottom(true);
    sentinelRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, []);

  return { pinToBottom, jumpToLatest };
}
```

- [ ] **Step 4: Run tests, confirm PASS**

- [ ] **Step 5: Commit**

```bash
git add gateway/webui/src/hooks/use-follow-latest.ts gateway/webui/src/hooks/use-follow-latest.test.ts
git commit -m "feat(webui): useFollowLatest auto-scroll hook"
```

---

### Task 9: Chat — `DayDivider`, `InterruptChip`

**Files:**
- Create: `gateway/webui/src/components/chat/day-divider.tsx` + test
- Create: `gateway/webui/src/components/chat/interrupt-chip.tsx` + test

- [ ] **Step 1: `DayDivider`**

```typescript
// day-divider.tsx
export interface DayDividerProps { label: string; }
export function DayDivider({ label }: DayDividerProps) {
  return <div class="day-divider">{label}</div>;
}
```

Test: renders label text; has `day-divider` class. Commit.

- [ ] **Step 2: `InterruptChip`**

```typescript
// interrupt-chip.tsx
import type { JSX } from "preact";

export interface InterruptChipProps {
  variant: "inline" | "meta";
  cutoffKind: "interrupt" | "barge-in";
}

export function InterruptChip({ variant, cutoffKind }: InterruptChipProps): JSX.Element {
  const label = cutoffKind === "barge-in" ? "barge-in" : "interrupted";
  return <span class={`interrupt-chip interrupt-chip--${variant}`}>• {label}</span>;
}
```

Test: each (variant × cutoffKind) combination renders the right label + class. Commit.

```bash
git add gateway/webui/src/components/chat/day-divider* gateway/webui/src/components/chat/interrupt-chip*
git commit -m "feat(webui): DayDivider + InterruptChip"
```

---

### Task 10: Chat — `BubbleText`, `BubbleSpeakingWave`

**Files:**
- Create: `gateway/webui/src/components/chat/bubble-text.tsx` + test
- Create: `gateway/webui/src/components/chat/bubble-speaking-wave.tsx` + test

- [ ] **Step 1: `BubbleText`**

```typescript
// bubble-text.tsx
import type { ConversationAssistantCutoff } from "@sentient/protocol";
import { InterruptChip } from "./interrupt-chip.tsx";

export interface BubbleTextProps {
  text: string;
  isStreaming: boolean;
  cutoff?: ConversationAssistantCutoff;
}

export function BubbleText({ text, isStreaming, cutoff }: BubbleTextProps) {
  return (
    <p class="bubble-text">
      {text}
      {isStreaming && <span class="bubble-text__cursor" aria-hidden="true" />}
      {cutoff && <InterruptChip variant="inline" cutoffKind={cutoff.kind} />}
    </p>
  );
}
```

Test: cursor shows only when streaming; inline chip only when cutoff present; cutoff kind passes through. Commit.

- [ ] **Step 2: `BubbleSpeakingWave`**

```typescript
// bubble-speaking-wave.tsx
export interface BubbleSpeakingWaveProps { active: boolean; }
export function BubbleSpeakingWave({ active }: BubbleSpeakingWaveProps) {
  if (!active) return null;
  return <span class="bubble-speaking-wave" aria-hidden="true" />;
}
```

CSS (add to per-component or a global stylesheet per your convention — referencing only tokens):

```css
.bubble-speaking-wave {
  position: absolute; inset: 0; z-index: 0; pointer-events: none;
  background: linear-gradient(
    100deg, transparent 0%,
    color-mix(in oklab, var(--color-accent) 0%, transparent) 15%,
    color-mix(in oklab, var(--color-accent) 14%, transparent) 35%,
    color-mix(in oklab, var(--color-accent) 22%, transparent) 50%,
    color-mix(in oklab, var(--color-accent) 14%, transparent) 65%,
    color-mix(in oklab, var(--color-accent) 0%, transparent) 85%,
    transparent 100%
  );
  background-size: 220% 100%; background-repeat: no-repeat;
  animation: speaking-wave var(--motion-wave);
}
@keyframes speaking-wave {
  0% { background-position: -60% 0; }
  50% { background-position: 160% 0; }
  100% { background-position: -60% 0; }
}
```

Test: renders element iff `active`. Commit.

```bash
git add gateway/webui/src/components/chat/bubble-text* gateway/webui/src/components/chat/bubble-speaking-wave*
git commit -m "feat(webui): BubbleText + BubbleSpeakingWave"
```

---

### Task 11: Chat — `ToolPillStrip`, `ToolInlineDetail`

**Files:**
- Create: `gateway/webui/src/components/chat/tool-pill-strip.tsx` + test
- Create: `gateway/webui/src/components/chat/tool-inline-detail.tsx` + test

Follow TDD loop.

- [ ] **Step 1: `ToolInlineDetail`**

```typescript
// tool-inline-detail.tsx
import type { TaskSnapshotItem } from "@sentient/web-sdk";

export interface ToolInlineDetailProps {
  task: TaskSnapshotItem;
  direction: "down" | "up";
}

export function ToolInlineDetail({ task, direction }: ToolInlineDetailProps) {
  return (
    <div class={`tool-inline-detail tool-inline-detail--${direction}`}>
      <code class="tool-inline-detail__preview">{task.argsPreview}</code>
    </div>
  );
}
```

Test: renders `argsPreview`, applies direction class. Commit.

- [ ] **Step 2: `ToolPillStrip`**

```typescript
// tool-pill-strip.tsx
import type { TaskSnapshotItem } from "@sentient/web-sdk";
import { Icon } from "../common/icon.tsx";
import { ToolInlineDetail } from "./tool-inline-detail.tsx";

export interface ToolPillStripProps {
  tools: readonly TaskSnapshotItem[];
  expandDirection: "down" | "up";
  openTaskId: string | null;
  onToggleTask(taskId: string): void;
}

function statusClass(s: TaskSnapshotItem["status"]): string {
  return `tool-pill--${s}`;
}

// map toolName → icon (extend as tools are added)
function iconForTool(toolName: string): "lamp" | "music" | "globe" | "check" | "phone" | "spark" | "thermo" {
  if (toolName.includes("light") || toolName.includes("scene")) return "lamp";
  if (toolName.includes("music") || toolName.includes("play")) return "music";
  if (toolName.includes("search") || toolName.includes("web")) return "globe";
  if (toolName.includes("message") || toolName.includes("send")) return "phone";
  if (toolName.includes("list") || toolName.includes("add")) return "check";
  if (toolName.includes("thermostat")) return "thermo";
  return "spark";
}

export function ToolPillStrip({ tools, expandDirection, openTaskId, onToggleTask }: ToolPillStripProps) {
  const open = openTaskId !== null ? tools.find((t) => t.taskId === openTaskId) : null;
  return (
    <div class={`tool-strip tool-strip--${expandDirection}`}>
      {expandDirection === "up" && open && <ToolInlineDetail task={open} direction="up" />}
      <div class="tool-strip__pills">
        {tools.map((t) => (
          <button
            key={t.taskId}
            type="button"
            class={`tool-pill ${statusClass(t.status)} ${openTaskId === t.taskId ? "tool-pill--open" : ""}`}
            onClick={() => onToggleTask(t.taskId)}
          >
            <span class="tool-pill__icon"><Icon name={iconForTool(t.toolName)} size={14} /></span>
            <code class="tool-pill__name">{t.toolName}</code>
            <span class={`tool-pill__dot tool-pill__dot--${t.status}`} />
            <span class="tool-pill__chev"><Icon name="chevron" size={10} /></span>
          </button>
        ))}
      </div>
      {expandDirection === "down" && open && <ToolInlineDetail task={open} direction="down" />}
    </div>
  );
}
```

Test: renders one pill per task; status class applied; click fires `onToggleTask`; detail panel renders on the correct side per direction. Commit.

```bash
git add gateway/webui/src/components/chat/tool-pill-strip* gateway/webui/src/components/chat/tool-inline-detail*
git commit -m "feat(webui): ToolPillStrip + ToolInlineDetail"
```

---

### Task 12: Chat — `MessageBubble`, `MessageList`, `ChatView`

**Files:**
- Create: `gateway/webui/src/components/chat/message-bubble.tsx` + test
- Create: `gateway/webui/src/components/chat/message-list.tsx` + test
- Create: `gateway/webui/src/components/chat/chat-view.tsx` + test

- [ ] **Step 1: `MessageBubble`**

```typescript
// message-bubble.tsx
import { useState } from "preact/hooks";
import type { ChatMessage } from "../../types.ts";
import { Avatar } from "../common/avatar.tsx";
import { BubbleSpeakingWave } from "./bubble-speaking-wave.tsx";
import { BubbleText } from "./bubble-text.tsx";
import { InterruptChip } from "./interrupt-chip.tsx";
import { ToolPillStrip } from "./tool-pill-strip.tsx";

export interface MessageBubbleProps {
  message: ChatMessage;
  isSpeaking: boolean;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function MessageBubble({ message, isSpeaking }: MessageBubbleProps) {
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  // User identity is a post-auth concern; until then both user and assistant
  // render with static names, matching the existing webui and the design mock.
  const name = message.role === "user" ? "Maya" : "Sentient";
  const modifier = `message-bubble--${message.role}` + (message.pending ? " message-bubble--pending" : "");

  return (
    <article class={`message-bubble ${modifier}`} aria-label={`${message.role} message`}>
      <Avatar kind={message.role} initial={message.role === "user" ? name[0] : undefined} tint="sage" />
      <div class="message-bubble__body">
        <div class="message-bubble__meta">
          <span class="message-bubble__name">{name}</span>
          <span class="message-bubble__sep">·</span>
          <time dateTime={new Date(message.timestamp).toISOString()}>{formatTime(message.timestamp)}</time>
          {message.cutoff && <InterruptChip variant="meta" cutoffKind={message.cutoff.kind} />}
        </div>
        <div class="message-bubble__text-wrap">
          <BubbleSpeakingWave active={isSpeaking} />
          <BubbleText text={message.text} isStreaming={message.isStreaming} cutoff={message.cutoff} />
        </div>
        {message.tools && message.tools.length > 0 && (
          <ToolPillStrip
            tools={message.tools}
            expandDirection="down"
            openTaskId={openTaskId}
            onToggleTask={(id) => setOpenTaskId(openTaskId === id ? null : id)}
          />
        )}
      </div>
    </article>
  );
}
```

Test each state: user text-confirmed; user pending (grey); assistant streaming (cursor); assistant speaking (wave active); assistant with tools; assistant interrupted (both chips). Commit.

- [ ] **Step 2: `MessageList`**

```typescript
// message-list.tsx
import type { ChatMessage } from "../../types.ts";
import { DayDivider } from "./day-divider.tsx";
import { MessageBubble } from "./message-bubble.tsx";

export interface MessageListProps {
  messages: readonly ChatMessage[];
  currentCycleId: string | null;
  isSpeakingCycle: boolean;
}

function shouldInsertDivider(prev: ChatMessage | undefined, cur: ChatMessage): string | null {
  // Insert divider when there's no prev, or gap > 30min
  if (!prev) {
    return `${new Date(cur.timestamp).toLocaleDateString(undefined, { weekday: "long" })} · ${formatShort(cur.timestamp)}`;
  }
  if (cur.timestamp - prev.timestamp > 30 * 60 * 1000) {
    return formatShort(cur.timestamp);
  }
  return null;
}
function formatShort(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function MessageList({ messages, currentCycleId, isSpeakingCycle }: MessageListProps) {
  if (messages.length === 0) {
    return <section class="message-list message-list--empty" aria-label="Messages">
      <p class="message-list__placeholder">Start a conversation...</p>
    </section>;
  }
  return (
    <section class="message-list" aria-label="Messages" role="log" aria-live="polite">
      {messages.map((m, i) => {
        const divider = shouldInsertDivider(messages[i - 1], m);
        const isSpeaking = isSpeakingCycle && m.cycleId === currentCycleId && m.role === "assistant";
        return (
          <>
            {divider && <DayDivider label={divider} />}
            <MessageBubble key={m.id} message={m} isSpeaking={isSpeaking} />
          </>
        );
      })}
    </section>
  );
}
```

Test empty state; with messages; divider insertion at gap; isSpeaking only on the matching cycle's latest assistant. Commit.

- [ ] **Step 3: `ChatView`**

```typescript
// chat-view.tsx
import { useRef } from "preact/hooks";
import type { ChatMessage } from "../../types.ts";
import { useFollowLatest } from "../../hooks/use-follow-latest.ts";
import { MessageList } from "./message-list.tsx";

export interface ChatViewProps {
  messages: readonly ChatMessage[];
  transcript: string;
  currentCycleId: string | null;
  isSpeakingCycle: boolean;
}

export function ChatView({ messages, transcript, currentCycleId, isSpeakingCycle }: ChatViewProps) {
  const scrollRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  useFollowLatest({ scrollContainerRef: scrollRef, contentRef });

  return (
    <section class="chat-view" ref={scrollRef}>
      <div class="chat-view__content" ref={contentRef}>
        <MessageList messages={messages} currentCycleId={currentCycleId} isSpeakingCycle={isSpeakingCycle} />
        {transcript && (
          <div class="chat-view__transcript" aria-label="Live transcript">{transcript}</div>
        )}
      </div>
    </section>
  );
}
```

Test: calls `useFollowLatest`; renders transcript iff non-empty. Commit.

```bash
git add gateway/webui/src/components/chat/
git commit -m "feat(webui): MessageBubble + MessageList + ChatView"
```

---

### Task 13: Shell — `Topbar`, `AppShell`

**Files:**
- Create: `gateway/webui/src/components/shell/topbar.tsx` + test
- Create: `gateway/webui/src/components/shell/app-shell.tsx` + test

- [ ] **Step 1: `Topbar`**

Per spec §4.5. Props: `householdName`, `routeLabel`, `deviceCount`, `activeRoute`, `onChatClick`, `onSettingsClick`, `onNotificationsClick`. Renders brand mark + crumbs + `StatusChip` + three `IconButton`s. Test each callback fires and active state applies.

- [ ] **Step 2: `AppShell`**

```typescript
// app-shell.tsx
import type { ComponentChildren } from "preact";

export interface AppShellProps {
  topbar: ComponentChildren;
  main: ComponentChildren;
  dock?: ComponentChildren;
}

export function AppShell({ topbar, main, dock }: AppShellProps) {
  return (
    <div class="app-shell">
      <header class="app-shell__topbar">{topbar}</header>
      <main class="app-shell__main">{main}</main>
      {dock && <footer class="app-shell__dock">{dock}</footer>}
    </div>
  );
}
```

Test: renders each slot. Commit.

```bash
git add gateway/webui/src/components/shell/
git commit -m "feat(webui): Topbar + AppShell"
```

---

### Task 14: Dock — `MicButton`, `SendButton`, `InterruptButton`, `SuggestionChips`

**Files:** 4 components under `gateway/webui/src/components/dock/`.

- [ ] **Step 1: `MicButton`**

```typescript
// mic-button.tsx
import { IconButton } from "../common/icon-button.tsx";

export interface MicButtonProps {
  active: boolean;
  onToggle(): void;
}

export function MicButton({ active, onToggle }: MicButtonProps) {
  return (
    <IconButton
      iconName={active ? "mic" : "mic-off"}
      title={active ? "Mute microphone" : "Enable microphone"}
      variant={active ? "mic-on" : "mic-off"}
      active={active}
      onClick={onToggle}
    />
  );
}
```

Test: both states render correct icon + variant. Commit.

- [ ] **Step 2: `SendButton`**

```typescript
// send-button.tsx
import { Icon } from "../common/icon.tsx";

export interface SendButtonProps {
  disabled: boolean;
  onSend(): void;
}

export function SendButton({ disabled, onSend }: SendButtonProps) {
  return (
    <button type="button" class="send-btn" aria-label="Send" disabled={disabled} onClick={onSend}>
      <Icon name="send" size={16} />
    </button>
  );
}
```

Test: disabled attribute; click fires. Commit.

- [ ] **Step 3: `InterruptButton`**

```typescript
// interrupt-button.tsx
export interface InterruptButtonProps {
  onInterrupt(): void;
}

export function InterruptButton({ onInterrupt }: InterruptButtonProps) {
  return (
    <button type="button" class="interrupt-btn" aria-label="Interrupt" onClick={onInterrupt}>
      <span class="interrupt-btn__glyph" aria-hidden="true" />
    </button>
  );
}
```

Test: click fires `onInterrupt`; `aria-label="Interrupt"`. Commit.

- [ ] **Step 4: `SuggestionChips`**

```typescript
// suggestion-chips.tsx
export interface SuggestionChipsProps {
  suggestions: readonly string[];
  onClick(text: string): void;
}

export function SuggestionChips({ suggestions, onClick }: SuggestionChipsProps) {
  return (
    <div class="suggestion-chips">
      {suggestions.map((s) => (
        <button key={s} type="button" class="suggestion-chips__item" onClick={() => onClick(s)}>{s}</button>
      ))}
    </div>
  );
}
```

Test: renders each suggestion; click fires with right text. Commit.

```bash
git add gateway/webui/src/components/dock/mic-button* gateway/webui/src/components/dock/send-button* gateway/webui/src/components/dock/interrupt-button* gateway/webui/src/components/dock/suggestion-chips*
git commit -m "feat(webui): dock buttons + suggestion chips"
```

---

### Task 15: Dock — `ComposerTaskStrip`, `Composer`

**Files:**
- Create: `gateway/webui/src/components/dock/composer-task-strip.tsx` + test
- Create: `gateway/webui/src/components/dock/composer.tsx` + test

- [ ] **Step 1: `ComposerTaskStrip`**

```typescript
// composer-task-strip.tsx
import { useState } from "preact/hooks";
import type { TaskSnapshotItem } from "@sentient/web-sdk";
import { ToolPillStrip } from "../chat/tool-pill-strip.tsx";

export interface ComposerTaskStripProps {
  tasks: readonly TaskSnapshotItem[];
}

export function ComposerTaskStrip({ tasks }: ComposerTaskStripProps) {
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const running = tasks.filter((t) => t.status === "running");
  if (running.length === 0) return null;
  return (
    <div class="composer-task-strip">
      <ToolPillStrip
        tools={running}
        expandDirection="up"
        openTaskId={openTaskId}
        onToggleTask={(id) => setOpenTaskId(openTaskId === id ? null : id)}
      />
    </div>
  );
}
```

Test: hidden when no running tasks; shows strip with direction=up when any running. Commit.

- [ ] **Step 2: `Composer`**

```typescript
// composer.tsx
import { useRef, useState } from "preact/hooks";
import type { TaskSnapshotItem } from "@sentient/web-sdk";
import type { CycleStatus } from "../../hooks/use-voice-client.ts";
import { ComposerTaskStrip } from "./composer-task-strip.tsx";
import { InterruptButton } from "./interrupt-button.tsx";
import { MicButton } from "./mic-button.tsx";
import { SendButton } from "./send-button.tsx";
import { SuggestionChips } from "./suggestion-chips.tsx";

export interface ComposerProps {
  tasks: readonly TaskSnapshotItem[];
  cycleStatus: CycleStatus;
  voiceMode: "off" | "active";
  canInterrupt: boolean;
  suggestions: readonly string[];
  onSendText(text: string): void;
  onMicToggle(): void;
  onInterrupt(): void;
  onSuggestionClick(text: string): void;
}

export function Composer(props: ComposerProps) {
  const [text, setText] = useState("");
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    props.onSendText(trimmed);
    setText("");
    areaRef.current?.focus();
  };

  const composerClasses = [
    "composer",
    props.voiceMode === "active" && "composer--listening",
    props.cycleStatus !== "idle" && "composer--streaming",
  ].filter(Boolean).join(" ");

  return (
    <div class="dock">
      <div class={composerClasses}>
        <ComposerTaskStrip tasks={props.tasks} />
        <textarea
          ref={areaRef}
          class="composer__textarea"
          rows={3}
          value={text}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={props.voiceMode === "active" ? "Listening — just speak, or type here" : "Type or speak — Sentient will listen"}
        />
        <div class="composer__bottom-row">
          <MicButton active={props.voiceMode === "active"} onToggle={props.onMicToggle} />
          <span class="composer__spacer" />
          <SendButton disabled={text.trim().length === 0} onSend={submit} />
          {props.canInterrupt && <InterruptButton onInterrupt={props.onInterrupt} />}
        </div>
      </div>
      <SuggestionChips suggestions={props.suggestions} onClick={props.onSuggestionClick} />
    </div>
  );
}
```

Test: `canInterrupt=true` renders interrupt button; send button disabled when empty; Enter submits; Shift+Enter inserts newline; placeholder changes with `voiceMode`. Commit.

```bash
git add gateway/webui/src/components/dock/composer* gateway/webui/src/components/dock/composer-task-strip*
git commit -m "feat(webui): Composer + ComposerTaskStrip"
```

---

### Task 16: Settings — fixtures + WIP badge

**Files:**
- Create: `gateway/webui/src/data/household-fixtures.ts`
- Create: `gateway/webui/src/components/settings/wip-badge.tsx` + test

- [ ] **Step 1: Write fixtures**

Translate content from `sentient-webui-design/settings_view.jsx`. Types declared in the same file:

```typescript
// gateway/webui/src/data/household-fixtures.ts
import type { IconName } from "../components/common/icon.tsx";

export type Role = "owner" | "admin" | "kid" | "staff" | "guest";
export type AvatarTint = "sage" | "terra" | "amber" | "clay";

export interface MemberFixture {
  id: string;
  name: string;
  subtitle: string;
  role: Role;
  avatarInitial: string;
  avatarTint: AvatarTint;
  hasVoicePrint: boolean;
}

export const MEMBERS_FIXTURE: readonly MemberFixture[] = [
  { id: "maya", name: "Maya Chen", subtitle: "maya@chen.family · voice print enrolled · active on 3 devices",
    role: "owner", avatarInitial: "M", avatarTint: "terra", hasVoicePrint: true },
  { id: "jordan", name: "Jordan Chen", subtitle: "jordan@chen.family · voice print enrolled · last seen 2h ago",
    role: "admin", avatarInitial: "J", avatarTint: "sage", hasVoicePrint: true },
  { id: "ellis", name: "Ellis Chen", subtitle: "11 years old · kid profile · voice print enrolled",
    role: "kid", avatarInitial: "E", avatarTint: "amber", hasVoicePrint: true },
  { id: "rosa", name: "Rosa (housekeeper)", subtitle: "Tue & Fri, 9am–1pm · scoped access · no voice print",
    role: "staff", avatarInitial: "R", avatarTint: "clay", hasVoicePrint: false },
  { id: "elena-guest", name: "Weekend guest · Elena", subtitle: "Temporary pass · Apr 19 – Apr 21 · no voice print required",
    role: "guest", avatarInitial: "", avatarTint: "terra", hasVoicePrint: false },
];

export interface CapabilityFixture {
  name: string;
  byRole: Record<"owner" | "admin" | "kid" | "guest", "on" | "off" | "partial">;
}

export const CAPABILITIES_FIXTURE: readonly CapabilityFixture[] = [
  { name: "Control lights & climate",   byRole: { owner: "on", admin: "on", kid: "on",       guest: "on" } },
  { name: "Unlock doors",                byRole: { owner: "on", admin: "on", kid: "off",      guest: "partial" } },
  { name: "Play media & adjust volume",  byRole: { owner: "on", admin: "on", kid: "on",       guest: "on" } },
  { name: "Place orders (groceries, delivery)", byRole: { owner: "on", admin: "on", kid: "off", guest: "off" } },
  { name: "Run automations / scenes",    byRole: { owner: "on", admin: "on", kid: "partial",  guest: "off" } },
  { name: "Invite other members",        byRole: { owner: "on", admin: "off", kid: "off",     guest: "off" } },
  { name: "View activity log",           byRole: { owner: "on", admin: "on", kid: "off",      guest: "off" } },
];

export interface SessionFixture {
  id: string;
  iconName: IconName;
  deviceName: string;
  meta: string;
  status: "active" | "idle" | "signed-in";
}

export const SESSIONS_FIXTURE: readonly SessionFixture[] = [
  { id: "s1", iconName: "phone",  deviceName: "Maya's iPhone 17",      meta: "Oakland, CA · last active now",       status: "active" },
  { id: "s2", iconName: "tablet", deviceName: "Kitchen Display",        meta: "Home hub · always-on · firmware 4.18.2", status: "idle" },
  { id: "s3", iconName: "laptop", deviceName: "Jordan's MacBook Air",   meta: "Home WiFi · last active 2h ago",      status: "signed-in" },
];
```

- [ ] **Step 2: `WipBadge`**

```typescript
// wip-badge.tsx
export interface WipBadgeProps { label?: string; }
export function WipBadge({ label = "Not wired" }: WipBadgeProps) {
  return <span class="wip-badge"><span class="wip-badge__dot" aria-hidden="true" />{label}</span>;
}
```

Test: renders default + custom label. Commit.

```bash
git add gateway/webui/src/data/household-fixtures.ts gateway/webui/src/components/settings/wip-badge*
git commit -m "feat(webui): household fixtures + WipBadge"
```

---

### Task 17: Settings — `MemberRow` + `MembersPanel`

**Files:**
- Create: `gateway/webui/src/components/settings/member-row.tsx` + test
- Create: `gateway/webui/src/components/settings/members-panel.tsx` + test

- [ ] **Step 1: `MemberRow`**

Props: `MemberFixture`. Renders `Avatar`, name+subtitle block, `RolePill`, kebab `IconButton` (no-op). Test: content renders from fixture; kebab click does not throw (assigned to `() => {}`). Commit.

- [ ] **Step 2: `MembersPanel`**

Renders panel header (`Members`, `WipBadge`, description), maps fixture → `MemberRow`s, shows invite input row with disabled-feel submit. Test: renders all 5 fixture members; WipBadge present; invite input has no-op submit. Commit.

```bash
git add gateway/webui/src/components/settings/member-row* gateway/webui/src/components/settings/members-panel*
git commit -m "feat(webui): MembersPanel"
```

---

### Task 18: Settings — `PermissionGrid` + `PermissionsPanel`

**Files:**
- Create: `gateway/webui/src/components/settings/permission-grid.tsx` + test
- Create: `gateway/webui/src/components/settings/permissions-panel.tsx` + test

- [ ] **Step 1: `PermissionGrid`**

Renders header row (Capability / Owner / Admin / Kid / Guest) + one row per capability. Each cell shows a checkbox-style glyph mapped from `on/off/partial`. No interactions. Test: 7 rows × 5 columns present; correct status class. Commit.

- [ ] **Step 2: `PermissionsPanel`**

Panel header with `WipBadge`, description, `PermissionGrid`, two no-op buttons (`Add custom role`, `Review activity log`). Commit.

```bash
git add gateway/webui/src/components/settings/permission-grid* gateway/webui/src/components/settings/permissions-panel*
git commit -m "feat(webui): PermissionsPanel"
```

---

### Task 19: Settings — `SessionRow` + `SessionsPanel`

**Files:**
- Create: `gateway/webui/src/components/settings/session-row.tsx` + test
- Create: `gateway/webui/src/components/settings/sessions-panel.tsx` + test

Follow the same pattern: row renders icon + device name + meta + status; panel renders rows from fixture + `WipBadge` + no-op "Sign out all other devices" button. Commit.

```bash
git add gateway/webui/src/components/settings/session-row* gateway/webui/src/components/settings/sessions-panel*
git commit -m "feat(webui): SessionsPanel"
```

---

### Task 20: Settings — `VoicesPanel`, `InvitesPanel`, tabs, view

**Files:**
- Create: `gateway/webui/src/components/settings/voices-panel.tsx` + test
- Create: `gateway/webui/src/components/settings/invites-panel.tsx` + test
- Create: `gateway/webui/src/components/settings/settings-tabs.tsx` + test
- Create: `gateway/webui/src/components/settings/settings-view.tsx` + test

- [ ] **Step 1: `VoicesPanel` + `InvitesPanel`**

Each renders a centered empty-state card with "Coming soon" copy + a no-op CTA button. No `WipBadge` (already unambiguously placeholder). Commit.

- [ ] **Step 2: `SettingsTabs`**

```typescript
// settings-tabs.tsx
export type SettingsTab = "members" | "permissions" | "voices" | "sessions" | "invites";

const TABS: readonly [SettingsTab, string][] = [
  ["members", "Members"],
  ["permissions", "Permissions"],
  ["voices", "Voice profiles"],
  ["sessions", "Devices & sessions"],
  ["invites", "Invites"],
];

export interface SettingsTabsProps {
  active: SettingsTab;
  onChange(tab: SettingsTab): void;
}

export function SettingsTabs({ active, onChange }: SettingsTabsProps) {
  return (
    <div class="settings-tabs" role="tablist">
      {TABS.map(([key, label]) => (
        <button key={key} type="button" role="tab" aria-selected={active === key}
          class={`settings-tabs__tab ${active === key ? "settings-tabs__tab--active" : ""}`}
          onClick={() => onChange(key)}>{label}</button>
      ))}
    </div>
  );
}
```

Test: active class applies; click fires onChange with correct key. Commit.

- [ ] **Step 3: `SettingsView`**

```typescript
// settings-view.tsx
import { useState } from "preact/hooks";
import { InvitesPanel } from "./invites-panel.tsx";
import { MembersPanel } from "./members-panel.tsx";
import { PermissionsPanel } from "./permissions-panel.tsx";
import { SessionsPanel } from "./sessions-panel.tsx";
import { type SettingsTab, SettingsTabs } from "./settings-tabs.tsx";
import { VoicesPanel } from "./voices-panel.tsx";

export function SettingsView() {
  const [tab, setTab] = useState<SettingsTab>("members");
  return (
    <div class="settings">
      <h1 class="settings__title">Household</h1>
      <p class="settings__lead">Who lives here, what they can ask Sentient to do, and how it knows them.</p>
      <SettingsTabs active={tab} onChange={setTab} />
      {tab === "members" && <MembersPanel />}
      {tab === "permissions" && <PermissionsPanel />}
      {tab === "voices" && <VoicesPanel />}
      {tab === "sessions" && <SessionsPanel />}
      {tab === "invites" && <InvitesPanel />}
    </div>
  );
}
```

Test: default tab is members; tab change renders the corresponding panel. Commit.

```bash
git add gateway/webui/src/components/settings/
git commit -m "feat(webui): Settings shell with all panels"
```

---

### Task 21: Wire `App.tsx` — route state + AppShell

**Files:**
- Modify: `gateway/webui/src/app.tsx`

- [ ] **Step 1: Rewrite `App`**

```typescript
// gateway/webui/src/app.tsx
import { useState } from "preact/hooks";
import { ChatView } from "./components/chat/chat-view.tsx";
import { Composer } from "./components/dock/composer.tsx";
import { SettingsView } from "./components/settings/settings-view.tsx";
import { AppShell } from "./components/shell/app-shell.tsx";
import { Topbar } from "./components/shell/topbar.tsx";
import { useVoiceClient } from "./hooks/use-voice-client.ts";

const PLACEHOLDER_TOKEN = "anonymous";
const SUGGESTIONS = [
  "Good night routine",
  "Who was at the door at 3pm?",
  "Lower the kitchen lights 30%",
];

export function App() {
  const [route, setRoute] = useState<"chat" | "settings">(() =>
    (localStorage.getItem("sentient:route") as "chat" | "settings") ?? "chat",
  );
  const onRouteChange = (r: "chat" | "settings") => {
    setRoute(r);
    localStorage.setItem("sentient:route", r);
  };

  const client = useVoiceClient({ token: PLACEHOLDER_TOKEN });
  const cycleStatus = client.cycleStatus.value;
  const runningTasks = client.tasks.value.filter((t) => t.status === "running").length;
  const canInterrupt = cycleStatus !== "idle" || runningTasks > 0;

  return (
    <AppShell
      topbar={
        <Topbar
          householdName="The Chen House"
          routeLabel={route === "chat" ? "Conversation" : "Household"}
          deviceCount={14}
          activeRoute={route}
          onChatClick={() => onRouteChange("chat")}
          onSettingsClick={() => onRouteChange("settings")}
          onNotificationsClick={() => { /* WIP no-op */ }}
        />
      }
      main={
        route === "chat" ? (
          <ChatView
            messages={client.messages.value}
            transcript={client.transcript.value}
            currentCycleId={client.currentCycleId.value}
            isSpeakingCycle={cycleStatus === "speaking"}
          />
        ) : (
          <SettingsView />
        )
      }
      dock={
        route === "chat" ? (
          <Composer
            tasks={client.tasks.value}
            cycleStatus={cycleStatus}
            voiceMode={client.voiceMode.value}
            canInterrupt={canInterrupt}
            suggestions={SUGGESTIONS}
            onSendText={client.sendText}
            onMicToggle={() => (client.voiceMode.value === "active" ? client.stopVoiceMode() : client.startVoiceMode())}
            onInterrupt={client.interrupt}
            onSuggestionClick={client.sendText}
          />
        ) : undefined
      }
    />
  );
}
```

- [ ] **Step 2: Add Esc-to-interrupt keybind (preserves current behaviour)**

In `App`, use an `useEffect` to listen for `Escape` and call `client.interrupt()` when `canInterrupt`.

- [ ] **Step 3: Update `app.test.tsx`**

Test that: route state persists; chat/settings render per route; `canInterrupt` flips with `cycleStatus`; Esc triggers interrupt when canInterrupt.

- [ ] **Step 4: Typecheck + run app tests**

```
cd gateway/webui && bun run typecheck && bun run test src/app.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add gateway/webui/src/app.tsx gateway/webui/src/app.test.tsx
git commit -m "feat(webui): route + AppShell wiring"
```

---

### Task 22: Remove deprecated components + old tokens.css/components.css

**Files:**
- Delete: `gateway/webui/src/components/chat-screen.tsx` + test
- Delete: `gateway/webui/src/components/input-bar.tsx` + test
- Delete: `gateway/webui/src/components/interrupt-button.tsx`
- Delete: `gateway/webui/src/components/live-transcript.tsx` + test
- Delete: `gateway/webui/src/components/message-bubble.tsx` + test *(old root-level file; new one is under `chat/`)*
- Delete: `gateway/webui/src/components/message-list.tsx` + test
- Delete: `gateway/webui/src/components/task-sidebar.tsx` + test
- Delete: `gateway/webui/src/components/tool-confirm-dialog.tsx` + test
- Delete: `gateway/webui/src/components/voice-mode-button.tsx` + test
- Delete: `gateway/webui/src/styles/tokens.css` (old, replaced by `tokens/index.css`)
- Delete or rewrite: `gateway/webui/src/styles/components.css`
- Keep (unused for now, auth is a later spec): `gateway/webui/src/components/auth-gate.tsx`

- [ ] **Step 1: Grep for remaining imports**

```
cd gateway/webui && grep -rn "chat-screen\|input-bar\|live-transcript\|task-sidebar\|tool-confirm-dialog\|voice-mode-button" src/ | grep -v ".test."
```
Expected: zero in non-test source. Any match is a missed refactor.

- [ ] **Step 2: Delete files**

```
cd gateway/webui
rm -f src/components/chat-screen.tsx src/components/chat-screen.test.tsx
rm -f src/components/input-bar.tsx src/components/input-bar.test.tsx
rm -f src/components/interrupt-button.tsx
rm -f src/components/live-transcript.tsx src/components/live-transcript.test.tsx
rm -f src/components/message-bubble.tsx src/components/message-bubble.test.tsx
rm -f src/components/message-list.tsx src/components/message-list.test.tsx
rm -f src/components/task-sidebar.tsx src/components/task-sidebar.test.tsx
rm -f src/components/tool-confirm-dialog.tsx src/components/tool-confirm-dialog.test.tsx
rm -f src/components/voice-mode-button.tsx src/components/voice-mode-button.test.tsx
rm -f src/styles/tokens.css
rm -f src/styles/components.css
```

- [ ] **Step 3: Run full webui CI**

```
cd gateway/webui && bun run ci
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(webui): remove deprecated components + old styles"
```

---

### Task 23: Coverage check + polish

- [ ] **Step 1: Run coverage**

```
cd gateway/webui && bun run test -- --coverage
```
Expected: ≥ 80% statements, ≥ 75% branches per project rule. Add tests where below threshold; focus on hook derivations and component conditional renders.

- [ ] **Step 2: Verify no raw tokens outside `styles/tokens/`**

```
cd gateway/webui && grep -rnE "#[0-9A-Fa-f]{3,6}\b|[0-9]+px" src/styles/ --include="*.css" | grep -v "src/styles/tokens/"
```
Expected: zero hits. Anything found — replace with a `var(--*)` reference.

- [ ] **Step 3: Biome lint**

```
cd gateway/webui && bun run lint
```
Expected: clean.

- [ ] **Step 4: Commit (if any fixes)**

```bash
git add -A
git commit -m "chore(webui): coverage fill + lint"
```

---

### Task 24: Manual browser smoke test (Phase 2 Definition of Done)

Per spec §4.14. Runs on the implementer's machine BEFORE handing off.

- [ ] **Step 1: Stop conflicting containers**

```
docker ps --format "{{.Names}}" | grep -E "^sentient-" | xargs -r docker stop
```

- [ ] **Step 2: Build + bring up Docker**

```
cd /Users/kevinye/Development/sentient/deploy/docker && docker compose up -d --build
```

- [ ] **Step 3: Open browser, verify idle state**

Navigate to `http://localhost:8888` (or the configured port). Verify:
- Topbar: brand mark + "The Chen House · Conversation" crumbs + "14 devices online" pulsing-dot chip + three icon buttons (chat active).
- Empty chat shows placeholder text.
- Composer: textarea with "Type or speak — Sentient will listen", mic button (muted, not terra), send disabled, no interrupt button, suggestion chips below.
- Overall look matches Image #22 dusk variant.

- [ ] **Step 4: Send text + pending state**

Type "hello" and press Enter. **Verify:**
- User bubble appears immediately with reduced opacity (pending).
- Within ~50ms, the bubble snaps to full opacity (history sync confirmed).
- Assistant bubble begins streaming with terra cursor; auto-scroll tracks the growing content.
- If the assistant uses a tool, a tool pill appears inline at the bubble's bottom edge (status running = amber spinner).

- [ ] **Step 5: Mid-stream interrupt**

While assistant is still streaming, press the Interrupt button in the composer's bottom-right. **Verify:**
- Streaming halts immediately.
- `[• interrupted]` inline chip appears at the cut point.
- Meta row shows `interrupted` label after the time.
- Any running interruptable tool pill transitions to `cancelled` (muted × glyph).

- [ ] **Step 6: Queue during streaming**

Start a long assistant response. Mid-stream, type another message and press Enter. **Verify:**
- New user bubble appears greyed (pending). Old assistant response keeps streaming.
- When assistant naturally completes (or is stopped), next cycle picks up the queued message.
- Queued user bubble un-greys once it lands in history.

- [ ] **Step 7: Voice mode barge-in**

Click the mic button. Composer border shifts to stronger terra glow (listening). **Verify:**
- Mic icon switches to "on" state.
- Speak a question; STT runs; user bubble appears (no grey — confirmed by server).
- Assistant responds with TTS. Bubble shows **wave animation** on the text-only region (not on any attached tool pills).
- While assistant is speaking, speak again. **TTS stops immediately.** Current bubble gets `interrupted` markers. A new cycle fires from the user's new speech.
- Any tools that were running during the old cycle remain in their current state (not cancelled) — only their pill's running spinner reflects live status.

- [ ] **Step 8: Tool pill expansion**

Click a tool pill inline under a bubble. **Verify:**
- Inline detail panel expands **downward** inside the bubble.
- Click another pill → previous closes, new opens.
- Click same pill again → closes.

Click a running task pill in the composer task strip (if any running). **Verify:**
- Detail panel expands **upward** above the strip.

- [ ] **Step 9: Settings shell**

Click the settings icon in the topbar. **Verify:**
- Topbar crumbs change to "The Chen House · Household".
- Five tabs render; "Members" active by default.
- Members panel shows 5 fixture entries; `Not wired` WIP badge visible.
- Click `Permissions` — capability × role matrix renders; WIP badge visible.
- Click `Voice profiles` — "Coming soon" empty state.
- Click `Devices & sessions` — 3 fixture rows; WIP badge visible.
- Click `Invites` — "Coming soon" empty state.
- Clicking any kebab, invite button, sign-out button has no effect (no errors, just inert).

- [ ] **Step 10: DevTools console scan**

Open DevTools → Console. Reload the page. **Verify:**
- No `error` or `warn` entries attributable to our code.
- No unhandled promise rejections.

- [ ] **Step 11: Responsive check (desktop only)**

Resize the browser between 1280 and 1920 px wide. **Verify:**
- Chat max-width holds; composer remains centered.
- Topbar elements remain visible; no text clipping.
- Settings panels render without overflow.

Mobile viewports are out of scope for this spec.

- [ ] **Step 12: Tear down**

```
cd /Users/kevinye/Development/sentient/deploy/docker && docker compose down
```

- [ ] **Step 13: Push + PR**

```
git push -u origin feature/cerebrum-ux-refresh
# If PR for Phase 1 already exists, just push new commits to it.
# Otherwise:
gh pr create --title "Cerebrum UX refresh: cancel primitives + webui redesign" --body "$(cat <<'EOF'
## Summary
Phase 1 + Phase 2 of docs/superpowers/specs/2026-04-18-cerebrum-ux-refresh-design.md.

- Cancel primitives cleanup (AbortSlot / BargeInController / InterruptController, cancel_all_tasks + cancel_task effects, barge-in aborts cycle LLM stream).
- Webui redesign (dusk variant, tokens, components, pending buffer, useFollowLatest).

## Test plan
- [x] bun run ci (root)
- [x] Phase 1 smoke test (plan §Task 15)
- [x] Phase 2 browser smoke test (plan §Task 24)
- [ ] Review by maintainer

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Phase 2 Exit Criteria

- All 24 tasks complete.
- `cd gateway/webui && bun run ci` green; coverage ≥ 80/75.
- No raw hex/px outside `styles/tokens/`.
- Manual browser smoke test (Task 24) passes end-to-end.
- PR open (or updated) for review.
