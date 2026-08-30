import type { JSX } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import type { AuthApi, PublicUser } from "../../services/auth-api.js";
import { AvatarTile } from "./avatar-tile.js";
import { PinPad } from "./pin-pad.js";
import { ActionButton, Plate, Surface } from "../common/foundation.tsx";
import { GateState } from "../common/gate-state.tsx";
import {
  Notice,
  PIN_CHECKING_MIN_MS,
  PIN_SUCCESS_TRANSITION_MS,
} from "../common/composites.tsx";

const log = createLogger(["sentient", "webui", "auth", "login-screen"]);

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface LoginScreenProps {
  api: AuthApi;
  notice?: string | undefined;
  auth: {
    login(
      input: { userId: string; pin: string },
      options?: { beforeCommit?: () => void | Promise<void> },
    ): Promise<
      | { ok: true; value: { token: string } }
      | { ok: false; error: { status: number; code: string } }
    >;
  };
}

// ---------------------------------------------------------------------------
// Stage type
// ---------------------------------------------------------------------------

type Stage =
  | { view: "loading" }
  | { view: "avatars" }
  | { view: "pin"; userId: string; displayName: string }
  | { view: "empty" }
  | { view: "error" };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

// Keep the client-side presentation window even when the gateway answers faster.
function waitForMinimum(startedAt: number, minimumMs: number): Promise<void> {
  const remaining = minimumMs - (Date.now() - startedAt);
  if (remaining <= 0) return Promise.resolve();
  return new Promise((resolve) => window.setTimeout(resolve, remaining));
}

export function LoginScreen({ api, auth, notice }: LoginScreenProps): JSX.Element {
  const [stage, setStage] = useState<Stage>({ view: "loading" });
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinSuccess, setPinSuccess] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const pinAttemptRef = useRef(0);

  const fetchUsers = useCallback(async () => {
    setStage({ view: "loading" });
    const result = await api.listUsers();
    if (!result.ok) {
      log.warn("list-users-failed", { code: result.error.code });
      setStage({ view: "error" });
      return;
    }
    if (result.value.length === 0) {
      setStage({ view: "empty" });
      setUsers([]);
      return;
    }
    setUsers(result.value);
    setStage({ view: "avatars" });
  }, [api]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleSelectUser = useCallback((userId: string) => {
    const user = users.find((u) => u.userId === userId);
    if (!user) return;
    pinAttemptRef.current += 1;
    log.debug("user-selected", { userId });
    setPinError(null);
    setPinSuccess(null);
    setResetSignal((n) => n + 1);
    setStage({ view: "pin", userId: user.userId, displayName: user.displayName });
  }, [users]);

  const handlePinSubmit = useCallback(async (pin: string) => {
    if (stage.view !== "pin") return;
    const attempt = ++pinAttemptRef.current;
    const checkingStartedAt = Date.now();
    log.debug("pin-submit", { userId: stage.userId });
    const result = await auth.login(
      { userId: stage.userId, pin },
      {
        beforeCommit: async () => {
          await waitForMinimum(checkingStartedAt, PIN_CHECKING_MIN_MS);
          if (pinAttemptRef.current !== attempt) return;
          setPinSuccess("Pin accepted.");
          await waitForMinimum(Date.now(), PIN_SUCCESS_TRANSITION_MS);
        },
      },
    );
    if (!result.ok) {
      await waitForMinimum(checkingStartedAt, PIN_CHECKING_MIN_MS);
      if (pinAttemptRef.current !== attempt) return;
      setPinSuccess(null);
      if (result.error.code === "invalid-credentials") {
        log.debug("wrong-pin", { userId: stage.userId });
        setPinError("Wrong PIN");
        setResetSignal((n) => n + 1);
        return;
      }
      log.warn("login-error", { code: result.error.code });
      setPinError("Something went wrong");
      setResetSignal((n) => n + 1);
      return;
    }
    // AuthProvider commits only after beforeCommit presents the success state.
    log.debug("login-success", { userId: stage.userId });
  }, [stage, auth]);

  const handleBack = useCallback(() => {
    pinAttemptRef.current += 1;
    setPinError(null);
    setPinSuccess(null);
    setStage({ view: "avatars" });
  }, []);

  // ---- Render ----

  if (stage.view === "loading") {
    return <GateState state="loading" title="Loading profiles" message="Finding your household…" />;
  }

  if (stage.view === "error") {
    return <GateState state="error" title="Could not load profiles" message="Check your connection and try again." actionLabel="Try again" onAction={() => void fetchUsers()} />;
  }

  if (stage.view === "empty") {
    return <GateState title="No profiles found" message="Ask a household admin to create a profile for you." />;
  }

  if (stage.view === "pin") {
    return (
      <Surface className="login-screen auth-gate">
        <Plate className="login-screen__card auth-gate__card">
          <ActionButton variant="quiet" className="login-screen__back" onClick={handleBack}>← Back to profiles</ActionButton>
          <h1 class="login-screen__title">Enter PIN for {stage.displayName}</h1>
          {notice && <Notice>{notice}</Notice>}
          <PinPad onSubmit={handlePinSubmit} resetSignal={resetSignal} error={pinError ?? undefined} success={pinSuccess ?? undefined} />
        </Plate>
      </Surface>
    );
  }

  // Avatars grid (default)
  return (
    <Surface className="login-screen auth-gate">
      <Plate className="login-screen__card login-screen__card--profiles auth-gate__card">
        <h1 class="login-screen__title">Who's using Sentient?</h1>
        {notice && <Notice>{notice}</Notice>}
        <div class="login-screen__grid snt-media-card-grid">
          {users.map((user) => (
            <AvatarTile
              key={user.userId}
              userId={user.userId}
              displayName={user.displayName}
              avatarTint={user.avatarTint as "sage" | "terra" | "amber" | "clay"}
              onSelect={handleSelectUser}
            />
          ))}
        </div>
      </Plate>
    </Surface>
  );
}