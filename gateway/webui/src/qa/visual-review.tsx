import { render } from "preact";
import { useEffect } from "preact/hooks";
import "../styles/tokens/index.css";
import "../styles/tokens/design-foundation-v2.css";
import "../components/common/foundation.css";
import "../components/common/composites.css";
import "../components/chat/chat-messages.css";
import "./visual-review.css";
import { AsyncState, NoResultsState, Notice } from "../components/common/composites.tsx";
import { ActionButton, Field, MenuTrigger, Plate, ToggleControl } from "../components/common/foundation.tsx";
import { MessageBubble } from "../components/chat/message-bubble.tsx";
import { DockStyleSheet } from "../components/dock/dock-styles.tsx";
import { VoiceCaptureControl } from "../components/dock/voice-capture-control.tsx";
import { webVisualRows } from "./visual-review-inventory.ts";

const PAGE_SIZE = 2;
const params = new URLSearchParams(location.search);
const page = Math.max(0, Number(params.get("page") ?? 0));
const config = params.get("config") ?? "web-desktop-1280x900";
const rows = webVisualRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

function stateKind(state: string): "loading" | "empty" | "error" | "ready" {
  const value = state.toLowerCase();
  if (/(loading|saving|applying|submitting|installing|checking|running|thinking|transitioning)/.test(value)) return "loading";
  if (/(empty|no sessions|no match|no-results)/.test(value)) return "empty";
  if (/(error|failed|denied|conflict|unavailable|offline|stale)/.test(value)) return "error";
  return "ready";
}

function StateSpecimen({ id, state }: { id: string; state: string }) {
  if (id === "web.history.no-results") return <NoResultsState onClear={() => {}} />;
  const kind = stateKind(state);
  if (id.includes("chat.") && /(message|thinking|responding|complete|stream|interrupt)/.test(id)) {
    const assistant = !id.includes("user-message");
    return <MessageBubble message={{ id, role: assistant ? "assistant" : "user", text: `Synthetic ${state} message`, timestamp: 1_780_000_000_000, isStreaming: id.includes("responding") || id.includes("stream"), ...(id.includes("interrupt") ? { cutoff: { kind: "interrupt" as const, cancelledTaskIds: [] } } : {}) }} identityState={id.includes("thinking") ? "thinking" : id.includes("responding") || id.includes("stream") ? "responding" : "idle"} currentUser={{ displayName: "Synthetic User", avatarTint: "sage" }} />;
  }
  if (id.includes("composer.mic")) {
    return <VoiceCaptureControl disabled={id.includes("disabled") || id.includes("error")} captureActive={false} onStart={async () => "qa-capture"} onCommit={async () => {}} onCancel={async () => {}} />;
  }
  if (/(menu|row-menu)/.test(id)) {
    return <div class="qa-menu"><MenuTrigger label="Synthetic options" expanded={state.includes("open")} controls={`${id}-menu`} onClick={() => {}} /><div id={`${id}-menu`} role="menu"><button type="button" role="menuitem">Review action</button></div></div>;
  }
  if (kind !== "ready") {
    return <AsyncState state={kind} title={`Synthetic ${kind} state`} message={state} action={kind === "error" ? <ActionButton>Retry</ActionButton> : undefined} />;
  }
  const disabled = /(disabled|no-op|noop|unavailable|dismissed|closed)/i.test(`${id} ${state}`);
  return <div class="qa-ready"><Notice tone={/(success|saved|applied)/i.test(state) ? "success" : "info"} title="Rendered production state">{state}</Notice><Field label="Synthetic field" value="Fixture value" disabled={disabled} /><ToggleControl label="Fixture setting" checked={!disabled} disabled={disabled} onChange={() => {}} /><ActionButton disabled={disabled}>Review action</ActionButton></div>;
}

function Catalog() {
  useEffect(() => {
    requestAnimationFrame(() => {
      const measurements = [...document.querySelectorAll<HTMLElement>("[data-inventory-id]")].map((row) => {
        const targets = [...row.querySelectorAll<HTMLElement>("button,input,select,textarea,[role=button]")].map((node) => node.getBoundingClientRect());
        const focusable = [...row.querySelectorAll<HTMLElement>("button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex='0']")];
        return {
          inventoryId: row.dataset.inventoryId,
          overflowPx: Math.max(0, row.scrollWidth - row.clientWidth),
          minimumTargetPx: targets.length ? Math.min(...targets.map((rect) => Math.min(rect.width, rect.height))) : null,
          focusableCount: focusable.length,
        };
      });
      (window as Window & { __QA_METRICS__?: unknown }).__QA_METRICS__ = { config, page, measurements };
      document.documentElement.dataset.qaReady = "true";
    });
  }, []);
  return (
    <>
      <DockStyleSheet />
      <main class="qa-catalog" aria-label="Design refresh production component review catalog"><header><h1>Design refresh · Web</h1><p>{config} · page {page + 1}</p></header>{rows.map((row) => <Plate className="qa-specimen" key={row.id}><div class="qa-label"><code>{row.id}</code><span>{row.state}</span></div><section data-inventory-id={row.id} class="qa-render"><StateSpecimen id={row.id} state={row.state} /></section></Plate>)}</main>
    </>
  );
}

const root = document.getElementById("app");
if (!root) throw new Error("missing QA app root");
render(<Catalog />, root);
