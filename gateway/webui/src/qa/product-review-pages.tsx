import "../styles/tokens/design-foundation-v2.css";
import "../styles/tokens/compatibility.css";
import "../styles/components.css";
import "../components/common/foundation.css";
import "../components/common/composites.css";
import "../components/common/toast.css";
import "../components/settings/settings-shell.css";
import "../components/settings/sidebar/sidebar.css";
import "../components/settings/apply-bar/apply-bar.css";
import "../components/settings/panes/panes.css";
import "../components/common/dialog.css";
import "../components/chat/chat-messages.css";
import "../components/sessions/drawer.css";
import "../components/permission/permission-dialog.css";
import "./product-review.css";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import type { SessionRow } from "@sentient/protocol";
import { AuthProvider, useAuth } from "../hooks/use-auth.tsx";
import { createAuthApi } from "../services/auth-api.ts";
import { SessionsProvider } from "../context/sessions.tsx";
import type { UseSessions } from "../hooks/use-sessions.ts";
import { LoginScreen } from "../components/auth/login-screen.tsx";
import { SettingsView } from "../components/settings/settings-view.tsx";
import { navGroupsFor } from "../components/settings/sidebar/nav-config.ts";
import { Drawer } from "../components/sessions/drawer.tsx";
import { AppShell } from "../components/shell/app-shell.tsx";
import { Topbar } from "../components/shell/topbar.tsx";
import { ToastProvider } from "../hooks/use-toast.tsx";
import { ToastHost } from "../components/common/toast.tsx";
import { reviewUser } from "./product-review-fixtures.ts";

const params = new URLSearchParams(location.search);
const page = params.get("page") ?? "settings";
const state = params.get("state") ?? "populated";
const admin = params.get("role") !== "adult";
const panes = navGroupsFor(admin).flatMap((group) => group.items);
const pane = panes.find((item) => item.key === params.get("pane"))?.key ?? "memory";
const api = createAuthApi();
const rows: SessionRow[] = ["Garden plans", "Weekend cooking", "Library afternoon"].map((title, index) => ({
  sessionId: `review-${index}`, rootId: `review-${index}`, title, startedAt: Date.now() - index * 86400000,
  lastActiveAt: Date.now() - index * 86400000, messageCount: 4 + index, isActive: index === 0,
}));
const items = signal(state === "populated" || state === "stale" ? rows : []);
const searchHits = signal<SessionRow[] | null>(null);
const currentId = signal<string | null>("review-0");
const sessions: UseSessions = {
  items, searchHits, currentId, loading: signal(state === "loading"), error: signal(state === "error" || state === "stale" ? "Fixture unavailable" : null),
  async load() {},
  async search(query) { searchHits.value = query.trim() ? items.value.filter((row) => row.title.toLowerCase().includes(query.toLowerCase())) : null; },
  async switchTo(id) { if (!items.value.some((row) => row.sessionId === id)) return false; currentId.value = id; return true; },
  async newChat() { currentId.value = null; return true; },
  async delete(id) { items.value = items.value.filter((row) => row.sessionId !== id); searchHits.value = null; if (currentId.value === id) currentId.value = null; },
  async rename(id, title) { items.value = items.value.map((row) => row.sessionId === id ? { ...row, title } : row); searchHits.value = null; },
  dispose() {},
};
function go(page: string, pane?: string) { location.href = `product-review.html?page=${page}${pane ? `&pane=${pane}` : ""}`; }
function Pages() {
  const auth = useAuth();
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (page !== "login" && auth.status !== "authenticated") return;
    // Ready means mounted + fixture requests given two frames, not backend/audio proof.
    const timer = window.setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => {
      document.documentElement.dataset.qaReady = "true";
      document.documentElement.dataset.productReviewReady = `${page}:${pane}:${state}`;
    })), state === "loading" ? 100 : 350);
    return () => clearTimeout(timer);
  }, [auth.status]);
  return <>
    <header class="product-review-banner">Dev/QA · Fictional data only · No backend, auth persistence, audio or downloads. Identity uses static fallback. Profile edits and history are local; other saves deliberately fail. Loading lasts 8s (history stays loading). <a href="product-review.html?page=login">Login</a> · <a href="product-review.html?page=history">History</a> · <a href="product-review.html?page=settings">Settings</a> · <a href="calendar-evidence.html">Calendar evidence</a></header>
    {page === "login" ? <LoginScreen api={api} auth={{ login: async (_input, options) => {
      if (params.get("pin") !== "success") return { ok: false, error: { status: 401, code: "invalid-credentials" } };
      await options?.beforeCommit?.();
      return { ok: true, value: { token: "fictional-review-token" } };
    } }} /> : auth.status === "authenticated" && <SessionsProvider value={sessions}><AppShell
      topbar={<Topbar householdName="Meadow household" routeLabel={page === "settings" ? "Household" : "Past chats"} activeRoute={page === "settings" ? "settings" : "chat"}
        user={{ ...reviewUser, isAdmin: admin, role: admin ? "admin" : "adult" }} onChatClick={() => go("history")} onSettingsClick={() => go("settings")} onCalendarClick={() => { location.href = "calendar-evidence.html"; }}
        onMenuClick={() => setOpen(true)} onLogout={() => go("login")} onOpenAccount={() => go("settings", "account")} />}
      main={page === "settings" ? <SettingsView initialTab={pane} /> : <Drawer open={open} onClose={() => setOpen(false)} />}
    /></SessionsProvider>}
  </>;
}
const root = document.getElementById("app");
if (!root) throw new Error("Missing review root");
render(<AuthProvider api={api}><ToastProvider><Pages /><ToastHost /></ToastProvider></AuthProvider>, root);
