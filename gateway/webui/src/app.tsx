import { createContext } from "preact";
import type { ComponentChildren } from "preact";
import { useComputed, useSignal } from "@preact/signals";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { createAttachmentsRest, createDraftStore, createLogger, deriveRestBaseUrl, type DraftRecord, type DraftStore } from "@sentient/web-sdk";
import { AuthProvider, useAuth } from "./hooks/use-auth.tsx";
import { ToastProvider, useToast } from "./hooks/use-toast.tsx";
import type { AuthApi } from "./services/auth-api.js";
import { createAuthApi } from "./services/auth-api.js";
import { createProfileApi } from "./services/profile-api.js";
import { ChatView } from "./components/chat/chat-view.tsx";
import type { AvatarTint } from "./components/common/avatar.tsx";
import type { SentientIdentityState } from "./components/common/sentient-identity.tsx";
import { ChatComposer } from "./components/dock/composer.tsx";
import { LoginScreen } from "./components/auth/login-screen.tsx";
import { markAuthExpired, takeAuthExpired } from "./components/auth/auth-expiry.ts";
import { SetupScreen } from "./components/auth/setup-screen.tsx";
import { PermissionDialog } from "./components/permission/permission-dialog.tsx";
import { Drawer } from "./components/sessions/drawer.tsx";
import { SettingsView } from "./components/settings/settings-view.tsx";
import { CalendarView } from "./components/calendar/calendar-view.tsx";
import { AppShell } from "./components/shell/app-shell.tsx";
import { ToastHost } from "./components/common/toast.tsx";
import { GateState } from "./components/common/gate-state.tsx";
import { ConnectionBanner } from "./components/shell/connection-banner.tsx";
import { clearPendingSession, loadPendingSession, loadStoredRoute, storeRoute } from "./components/shell/route-state.ts";
import { useSettingsDeparture } from "./components/shell/settings-departure.tsx";
import { Topbar, type TopbarRoute } from "./components/shell/topbar.tsx";
import { SessionsProvider } from "./context/sessions.tsx";
import { createUseSessions, type UseSessions } from "./hooks/use-sessions.ts";
import { useVoiceClient } from "./hooks/use-voice-client.ts";
import { useLocalDrafts } from "./hooks/use-local-drafts.ts";
import { useInstallState } from "./hooks/use-install-state.ts";
import { WizardShell } from "./components/wizard/wizard-shell.tsx";
import { MessageInbox } from "./components/inbox/message-inbox.tsx";
import type { ChatMessage } from "./types.ts";

const log = createLogger(["sentient", "webui", "app"]);

const SUGGESTIONS: readonly string[] = [
  "Good night routine",
  "Who was at the door at 3pm?",
  "Lower the kitchen lights 30%",
];

const ROUTE_LABELS: Record<TopbarRoute, string> = {
  chat: "Conversation",
  settings: "Household",
  calendar: "Calendar",
};

// ---------------------------------------------------------------------------
// Api context — provides AuthApi to child components (testable injection)
// ---------------------------------------------------------------------------

const ApiContext = createContext<AuthApi>(null as unknown as AuthApi);

function useApi(): AuthApi {
  return useContext(ApiContext);
}

// ---------------------------------------------------------------------------
// Auth-gated inner shell — only rendered inside AuthProvider
// ---------------------------------------------------------------------------

function AppInner() {
  const auth = useAuth();
  const api = useApi();
  const [route, setRoute] = useState<TopbarRoute>(loadStoredRoute);
  // Tracks the prior auth status so we can detect a fresh interactive login
  // (anonymous|authenticating → authenticated) vs a silent hydrate from stored
  // token on page load (boot → authenticated). Fresh logins always land on chat;
  // reloads keep the persisted route.
  const prevAuthStatusRef = useRef(auth.status);
  const [settingsTab, setSettingsTab] = useState<"memory" | "account">("memory");
  // Bumped on every Settings/My-Account click so SettingsView remounts even
  // when the requested initialTab equals the previous value (e.g. user already
  // had settingsTab="account" but had since navigated away inside settings).
  const [settingsNonce, setSettingsNonce] = useState(0);

  const onRouteChange = (r: TopbarRoute) => {
    setRoute(r);
    storeRoute(r);
  };

  const onOpenAccount = () => {
    setSettingsTab("account");
    setSettingsNonce((n) => n + 1);
    onRouteChange("settings");
  };

  useEffect(() => {
    const prev = prevAuthStatusRef.current;
    prevAuthStatusRef.current = auth.status;
    if (auth.status === "authenticated" && (prev === "anonymous" || prev === "authenticating")) {
      onRouteChange("chat");
    }
    // onRouteChange is stable (closure over setRoute), safe to omit from deps
  }, [auth.status]);

  const freshLogin = auth.status === "authenticated" &&
    (prevAuthStatusRef.current === "anonymous" || prevAuthStatusRef.current === "authenticating");

  // ── Boot: show loading while we hydrate the token from sessionStorage ──
  // NOTE: do NOT include "authenticating" here. Login/setup screens drive
  // their own per-action loading state; unmounting them during the auth
  // call destroys their stage + error state, which makes wrong-PIN handling
  // kick the user back to the avatar grid.
  if (auth.status === "boot") {
    return <GateState state="loading" title="Restoring your session" message="Preparing Sentient…" />;
  }

  // ── Anonymous OR authenticating: route to login/setup screens; the
  //    screens own their own in-flight UI (disabled inputs, dots, etc.) ──
  if (auth.status === "anonymous" || auth.status === "authenticating") {
    // AuthContextValue.login/setup return AuthResult<{token}> but
    // SetupScreen/LoginScreen expect the wider AuthApi return type that
    // includes {user}. Safe to cast: both components only check .ok.
    const authForScreens = auth as unknown as Parameters<typeof SetupScreen>[0]["auth"] & Parameters<typeof LoginScreen>[0]["auth"];
    return <AnonymousGate api={api} auth={authForScreens} />;
  }

  // ── Failed: show error with retry ──
  if (auth.status === "failed") {
    return (
      <GateState
        state="error"
        title="Authentication failed"
        message={auth.reason}
        actionLabel="Try again"
        onAction={() => window.location.reload()}
      />
    );
  }

  return <AuthenticatedApp
    key={auth.user.userId}
    auth={auth}
    route={freshLogin ? "chat" : route}
    freshLogin={freshLogin}
    settingsTab={settingsTab}
    settingsNonce={settingsNonce}
    onRouteChange={onRouteChange}
    onOpenAccount={onOpenAccount}
    onOpenSettings={() => {
      setSettingsTab("memory");
      setSettingsNonce((n) => n + 1);
      onRouteChange("settings");
    }}
  />;
}

interface AuthenticatedAppProps {
  auth: Extract<ReturnType<typeof useAuth>, { status: "authenticated" }>;
  route: TopbarRoute;
  freshLogin: boolean;
  settingsTab: "memory" | "account";
  settingsNonce: number;
  onRouteChange(route: TopbarRoute): void;
  onOpenAccount(): void;
  onOpenSettings(): void;
}

// Keep authenticated effects in their own mounted lifetime. In particular,
// login feedback never creates a voice/session client or waits on its readiness.
function AuthenticatedApp({ auth, route, freshLogin, settingsTab, settingsNonce, onRouteChange, onOpenAccount, onOpenSettings }: AuthenticatedAppProps) {
  const { token, user } = auth;
  const [arriving] = useState(freshLogin);
  const departure = useSettingsDeparture();
  const leaveSettings = async (action: () => void) => {
    if (await departure.request()) action();
  };
  const toast = useToast();
  const client = useVoiceClient({
    token,
    onHistoryArchived: () => {
      toast.show("Earlier conversation archived — starting fresh.", "success");
    },
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const draftPersistence = useMemo<{ store: DraftStore; available: boolean }>(() => {
    try {
      return {
        store: createDraftStore({ accountId: user.userId, gatewayUrl: client.gatewayUrl }),
        available: true,
      };
    } catch (cause) {
      const unavailable = async (): Promise<never> => { throw cause; };
      return {
        store: {
          list: unavailable,
          save: unavailable,
          remove: unavailable,
          beginSend: unavailable,
          saveUploadedRef: unavailable,
          bindPendingSession: unavailable,
          reconcileSend: unavailable,
          detachSession: unavailable,
          saveDeleteIntent: unavailable,
          removeDeleteIntent: unavailable,
          close: async () => {},
        },
        available: false,
      };
    }
  }, [user.userId, client.gatewayUrl]);
  const draftStore = draftPersistence.store;
  const draftRows = useSignal<readonly DraftRecord[]>([]);
  const draftRefreshRef = useRef<(() => void | Promise<void>) | null>(null);
  const draftFlushRef = useRef<(() => Promise<void>) | null>(null);
  // Build the sessions hook ONCE per SessionsConnector identity. The
  // connector is stable per useVoiceClient resources memo (rebuilt only
  // when wsUrl/token change), so this also rebuilds across token changes.
  const sessionsRef = useRef<{ connector: unknown; hook: UseSessions } | null>(null);
  if (sessionsRef.current?.connector !== client.sessionsConnector) {
    sessionsRef.current?.hook.dispose();
    sessionsRef.current = {
      connector: client.sessionsConnector,
      hook: createUseSessions(client.sessionsConnector, {
        ...(draftPersistence.available ? { draftStore } : {}),
        drafts: draftRows,
        onOpenNewDraft: client.routeDraft,
        onBeforeNewDraft: () => draftFlushRef.current?.(),
        onDraftsChanged: () => draftRefreshRef.current?.(),
      }),
    };
  }
  useLayoutEffect(() => () => {
    sessionsRef.current?.hook.dispose();
    sessionsRef.current = null;
  }, []);
  const sessions = sessionsRef.current.hook;
  const attachmentsRest = useMemo(() => createAttachmentsRest({
    baseUrl: deriveRestBaseUrl(client.gatewayUrl ?? `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/v1/ws`),
    token: () => token,
  }), [client.gatewayUrl, token]);
  const localDrafts = useLocalDrafts({
    store: draftStore,
    attachments: attachmentsRest,
    drafts: draftRows,
    currentId: sessions.currentId.value,
    getCurrentId: () => {
      const current = sessions.currentId.peek();
      if (current) return current;
      try {
        return sessionStorage.getItem("sentient.currentSessionId");
      } catch {
        return null;
      }
    },
    connectionReady: client.sdkStatus.value === "ready",
    isConnectionBoundTo: client.isConnectionBoundTo,
    recoverPendingRoute: client.recoverPendingRoute,
    sendText: client.sendText,
  });
  draftRefreshRef.current = async () => { await localDrafts.refresh(); };
  draftFlushRef.current = localDrafts.flush;
  const pendingSessionRef = useRef<string | null>(loadPendingSession());
  const [sessionRouteState, setSessionRouteState] = useState<"idle" | "loading" | "unavailable">(
    pendingSessionRef.current === null ? "idle" : "loading",
  );
  const sessionRouteAttemptRef = useRef(0);
  // Gate against double-click: skip if a TTS toggle PUT is already in flight.
  const togglingRef = useRef(false);
  const cycleStatus = client.cycleStatus.value;
  // Reactive (not `.value`-unwrapped) — passed down as a signal so the
  // settings pane's voice-preview gate can subscribe without SettingsView
  // itself re-rendering on every cycle-status change.
  const assistantSpeaking = useComputed(() => client.cycleStatus.value === "speaking");
  const tasks = client.tasks.value;
  const runningTasks = tasks.filter((t) => t.status === "running").length;
  const canInterrupt = cycleStatus !== "idle" || runningTasks > 0;
  const messages = client.messages.value;
  const acknowledgedPendingSessions = useMemo(
    () => new Map(messages.flatMap((message) =>
      message.role === "user" && message.pendingId && message.sessionId
        ? [[message.pendingId, message.sessionId] as const]
        : []
    )),
    [messages],
  );
  useEffect(() => {
    void localDrafts.reconcile(acknowledgedPendingSessions);
  }, [acknowledgedPendingSessions, localDrafts.reconcile]);
  const draftError = localDrafts.error.value;
  useEffect(() => {
    if (draftError) toast.show(draftError, "error");
  }, [draftError, toast]);
  const pendingMessages = useMemo<readonly ChatMessage[]>(() => localDrafts.pendingSends.value
    .filter((pending) => {
      const acceptedSessionId = acknowledgedPendingSessions.get(pending.pendingId);
      return (!acceptedSessionId || (pending.sessionId !== null && pending.sessionId !== acceptedSessionId)) &&
        (pending.sessionId === sessions.currentId.value ||
          (pending.sessionId === null && pending.draftId === sessions.currentId.value));
    })
    .map((pending) => ({
      id: `pending-${pending.pendingId}`,
      role: "user",
      text: pending.text,
      timestamp: pending.createdAt,
      isStreaming: false,
      pendingId: pending.pendingId,
      attachments: pending.attachments.map((attachment) => {
        const state = localDrafts.uploadStates.value[`${pending.pendingId}:${attachment.id}`];
        return {
          kind: "local" as const,
          ...attachment,
          status: state?.status ?? (pending.uploadedRefs[attachment.id] ? "uploaded" : "pending"),
          ...(state?.status === "uploading" ? { progress: state.progress } : {}),
          ...(state && "message" in state ? { statusMessage: state.message } : {}),
          onCancel: () => localDrafts.cancelUpload(pending.pendingId, attachment.id),
          onRetry: () => { void localDrafts.retryPending(pending); },
          onEdit: () => { void localDrafts.revisePending(pending.pendingId); },
          onRemove: () => { void localDrafts.revisePending(pending.pendingId, attachment.id); },
        };
      }),
    })), [acknowledgedPendingSessions, localDrafts.pendingSends.value, localDrafts.uploadStates.value]);
  const visibleMessages = useMemo(
    () => [...messages, ...pendingMessages].sort((a, b) => a.timestamp - b.timestamp),
    [messages, pendingMessages],
  );
  const currentTurnId = client.currentTurnId.value;
  const latestActiveAssistant = [...messages].reverse().find((message) =>
    message.role === "assistant" && message.turnId === currentTurnId
  );
  // Cognition/action waits are thinking. The first visible assistant text and
  // active playback are responding. Background tasks and listening do not
  // activate a message identity; those remain composer-owned.
  const activeCycleState: SentientIdentityState =
    cycleStatus === "speaking" || (cycleStatus === "streaming" && Boolean(latestActiveAssistant?.text))
      ? "responding"
      : cycleStatus === "streaming"
        ? "thinking"
        : "idle";
  const topbarMarkMode: SentientIdentityState = activeCycleState;
  const sdkStatus = client.sdkStatus.value;
  const connectionLost = client.connectionLost.value;
  const authExpired = client.authExpired.value;
  const connectionReady = sdkStatus === "ready";
  useEffect(() => () => { sessionRouteAttemptRef.current += 1; }, []);
  useEffect(() => {
    const target = pendingSessionRef.current;
    if (!target || sdkStatus !== "ready") return;
    const attempt = ++sessionRouteAttemptRef.current;
    pendingSessionRef.current = null;
    setSessionRouteState("loading");
    void sessions.switchTo(target).then((opened) => {
      if (sessionRouteAttemptRef.current !== attempt) return;
      clearPendingSession();
      setSessionRouteState(opened ? "idle" : "unavailable");
      if (opened) onRouteChange("chat");
    });
  }, [sessions, sdkStatus, onRouteChange]);

  const recoverSessionRoute = () => {
    sessionRouteAttemptRef.current += 1;
    setSessionRouteState("idle");
    onRouteChange("chat");
  };

  // Profile API instance — also used by SettingsView via its own factory call,
  // which is fine: createProfileApi() is stateless (just wraps fetch). Held
  // here so the dock TTS toggle can persist via the same backing route.
  const profileApi = useMemo(() => createProfileApi(), []);

  // Seed audio preferences from the persisted profile on first authenticated
  // render. Without this, the dock TTS button defaults to `enabled=true` and
  // would visibly flip if the user has it muted server-side. The
  // `seedPreferences` call also primes the PreferencesConnector so the next
  // server-pushed `session.preferences.changed` overwrites a known baseline.
  const prefsSeededRef = useRef(false);
  // Reset seed guard on token change so re-auth fetches fresh profile prefs.
  useEffect(() => {
    prefsSeededRef.current = false;
  }, [token]);
  // A REFUSED COMMAND, surfaced. There is no optimistic echo in this UI — a
  // message the gateway refuses simply never appears — so without this the
  // person watches their text vanish with no explanation. The pendingId also
  // lets durable draft state restore only this refused message.
  const commandRejection = client.commandRejection.value;
  useEffect(() => {
    if (commandRejection === null) return;
    toast.show(commandRejection.message, "error");
    if (commandRejection.command === "text.input" && commandRejection.pendingId !== undefined) {
      void localDrafts.reconcileRejected(commandRejection.pendingId);
    }
    client.commandRejection.value = null;
  }, [commandRejection, toast, client.commandRejection, localDrafts.reconcileRejected]);
  useEffect(() => {
    if (prefsSeededRef.current) return;
    let cancelled = false;
    void (async () => {
      const r = await profileApi.getMe(token);
      if (cancelled) return;
      if (r.ok) {
        client.seedPreferences({
          ttsEnabled: r.value.audio.ttsEnabled,
          channel: r.value.audio.channel,
        });
        prefsSeededRef.current = true;
      } else {
        log.warn("seed-preferences.getMe-failed", { code: r.error.code });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [profileApi, token, client]);

  // Auth expired during a reconnect (gateway rejected the cached token).
  // Clear local auth state and route to the login screen — the user keeps
  // their PIN, just needs to reauthenticate.
  useEffect(() => {
    if (!authExpired) return;
    log.warn("auth-expired → forcing logout");
    try { markAuthExpired(sessionStorage); } catch { /* storage disabled */ }
    void auth.logout();
  }, [authExpired, auth]);

  useEffect(() => {
    if (!canInterrupt) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        client.interrupt();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canInterrupt, client]);

  return (
    <SessionsProvider value={sessions}>
      <AppShell
        arriving={arriving}
        topbar={
          <Topbar
            householdName="My Home"
            routeLabel={ROUTE_LABELS[route]}
            activeRoute={route}
            markMode={topbarMarkMode}
            onChatClick={() => void leaveSettings(() => onRouteChange("chat"))}
            onSettingsClick={() => void leaveSettings(onOpenSettings)}
            onCalendarClick={() => void leaveSettings(() => onRouteChange("calendar"))}
            onMenuClick={() => setDrawerOpen(true)}
            onNotificationsClick={() => setInboxOpen((open) => !open)}
            notificationsOpen={inboxOpen}
            user={user}
            onLogout={() => void leaveSettings(() => { void auth.logout(); })}
            onOpenAccount={() => void leaveSettings(onOpenAccount)}
          />
        }
        main={
          route === "chat" ? (
            <ChatView
              messages={sessionRouteState === "idle" ? visibleMessages : []}
              localSendIds={client.localSendIds.value}
              transcript={sessionRouteState === "idle" ? client.transcript.value : ""}
              currentTurnId={currentTurnId}
              activeCycleState={activeCycleState}
              currentUser={{ displayName: user.displayName, avatarTint: user.avatarTint as AvatarTint }}
              status={sessionRouteState === "unavailable" ? "unavailable" : sessionRouteState === "loading" ? "loading" : connectionLost ? "error" : connectionReady ? "ready" : "loading"}
              attachmentsRest={attachmentsRest}
              sessionBoundaryKey={`${sessions.currentId.value ?? "none"}:${sessionRouteState}:${sessionRouteAttemptRef.current}`}
            />
          ) : route === "calendar" ? (
            <CalendarView token={token} />
          ) : (
            <SettingsView
              initialTab={settingsTab}
              key={settingsNonce}
              onAudioApplied={client.patchPreferences}
              assistantSpeaking={assistantSpeaking}
              onNavigationStateChange={departure.onStateChange}
              onRequestLogout={() => void leaveSettings(() => { void auth.logout(); })}
            />
          )
        }
        dock={
          route === "chat" ? (
            <ChatComposer
              cycleStatus={cycleStatus}
              connectionReady={connectionReady && sessionRouteState === "idle"}
              captureActive={client.voiceMode.value === "active"}
              ttsEnabled={client.prefs.value.ttsEnabled}
              suggestions={SUGGESTIONS}
              tasks={client.tasks.value}
              value={localDrafts.value.value}
              attachments={localDrafts.activeAttachments.value}
              onValueChange={localDrafts.save}
              onAttachmentsSelected={localDrafts.addFiles}
              onAttachmentRemove={localDrafts.removeFile}
              onSendText={(text) => {
                void localDrafts.save(text).then((saved) => {
                  if (saved) void localDrafts.submit();
                });
              }}
              onCaptureStart={async (mode) => {
                try {
                  return await client.startCapture(mode);
                } catch (err) {
                  const message = err instanceof Error ? err.message : "Couldn't start the microphone.";
                  toast.show(message, "error");
                  throw err;
                }
              }}
              onCaptureCommit={client.commitCapture}
              onCaptureCancel={client.cancelCapture}
              onTtsToggle={() => {
                if (togglingRef.current) return;
                togglingRef.current = true;
                const next = !client.prefs.value.ttsEnabled;
                // Optimistic flip — UI mirrors immediately. PUT the new audio
                // sub-object via the existing profile route; on success push a
                // WS preference patch so the gateway/Hermes loop sees it
                // without waiting for the next session boundary. On failure
                // revert + toast.
                client.prefs.value = { ...client.prefs.value, ttsEnabled: next };
                profileApi
                  .patchAudio(token, { ttsEnabled: next })
                  .then((res) => {
                    if (res.ok) {
                      client.patchPreferences({ ttsEnabled: next });
                    } else {
                      client.prefs.value = { ...client.prefs.value, ttsEnabled: !next };
                      log.warn("tts-toggle-failed", { code: res.error.code });
                      toast.show("Couldn't update voice setting. Please try again.", "error");
                    }
                  })
                  .catch((err) => {
                    client.prefs.value = { ...client.prefs.value, ttsEnabled: !next };
                    log.warn("tts-toggle-failed", { error: String(err) });
                    toast.show("Couldn't update voice setting. Please try again.", "error");
                  })
                  .finally(() => {
                    togglingRef.current = false;
                  });
              }}
              onInterrupt={client.interrupt}
              onSuggestionClick={(text) => {
                void localDrafts.save(text).then((saved) => {
                  if (saved) void localDrafts.submit();
                });
              }}
            />
          ) : undefined
        }
      />
      <MessageInbox open={inboxOpen} token={token} onClose={() => setInboxOpen(false)} onOpenedSession={recoverSessionRoute} />
      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onBeforeSessionChange={departure.request}
        onSessionSelected={recoverSessionRoute}
      />
      {departure.dialog}
      {connectionLost && <ConnectionBanner onReconnect={client.reconnect} />}
      {client.permissionRequest.value && (
        <PermissionDialog request={client.permissionRequest.value} onRespond={client.respondToPermission} />
      )}
      <ToastHost />
    </SessionsProvider>
  );
}

// ---------------------------------------------------------------------------
// Anonymous gate: check if any users exist -> setup vs login
// ---------------------------------------------------------------------------

interface AnonymousGateProps {
  api: AuthApi;
  auth: Parameters<typeof SetupScreen>[0]["auth"] & Parameters<typeof LoginScreen>[0]["auth"];
}

function AnonymousGate({ api: apiRef, auth }: AnonymousGateProps) {
  const [hasAnyUser, setHasAnyUser] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [checkNonce, setCheckNonce] = useState(0);
  const [expiredNotice] = useState(() => {
    try { return takeAuthExpired(sessionStorage); } catch { return false; }
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadError(false);
      const result = await apiRef.listUsers();
      if (cancelled) return;
      if (!result.ok) {
        log.warn("list-users-failed", { code: result.error.code });
        setLoadError(true);
        return;
      }
      setHasAnyUser(result.value.length > 0);
    })();
    return () => { cancelled = true; };
  }, [apiRef, checkNonce]);

  if (loadError) {
    return <GateState state="error" title="Could not check profiles" message="Check your connection and try again." actionLabel="Try again" onAction={() => setCheckNonce((value) => value + 1)} />;
  }

  // Still loading
  if (hasAnyUser === null) {
    return <GateState state="loading" title="Finding your household" message="Checking available profiles…" />;
  }

  // No users -> first-time setup
  if (!hasAnyUser) {
    return <SetupScreen auth={auth} />;
  }

  // Users exist -> login
  return <LoginScreen api={apiRef} auth={auth} notice={expiredNotice ? "Your session expired. Enter your PIN to continue." : undefined} />;
}

// ---------------------------------------------------------------------------
// InstallGate: routes to wizard when bootstrap_complete=false
// ---------------------------------------------------------------------------

function InstallGate({ children }: { children: ComponentChildren }) {
  const { state, loading, error, offlineComplete, refresh } = useInstallState();
  if (loading) {
    return <GateState state="loading" title="Starting setup" message="Checking this installation…" />;
  }
  if (error && !offlineComplete) {
    return <GateState state="error" title="Could not check setup" message="Check your connection and try again." actionLabel="Try again" onAction={() => void refresh()} />;
  }
  if (state && !state.bootstrap_complete) {
    return <WizardShell state={state} onChange={refresh} />;
  }
  return <>{children}</>;
}

// ---------------------------------------------------------------------------
// Root: AuthProvider + ApiContext wrap everything
// ---------------------------------------------------------------------------

export interface AppProps {
  /** Override the auth API — used in tests. Defaults to createAuthApi(). */
  api?: AuthApi;
}

export function App({ api }: AppProps) {
  const resolvedApi = api ?? createAuthApi();
  // Pause every CSS animation/transition while the tab is hidden so iOS
  // Safari stops painting backgrounded pulses (battery + heat). CSS rule
  // `html.is-paused *` keys off this class.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const apply = (): void => {
      root.classList.toggle("is-paused", document.hidden);
    };
    apply();
    document.addEventListener("visibilitychange", apply);
    return () => {
      document.removeEventListener("visibilitychange", apply);
      root.classList.remove("is-paused");
    };
  }, []);
  return (
    <ApiContext.Provider value={resolvedApi}>
      <ToastProvider>
        <InstallGate>
          <AuthProvider api={resolvedApi}>
            <AppInner />
          </AuthProvider>
        </InstallGate>
      </ToastProvider>
    </ApiContext.Provider>
  );
}