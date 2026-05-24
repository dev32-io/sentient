import type { JSX } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import type { AuthApi, PublicUser } from "../../services/auth-api.js";
import { AvatarTile } from "./avatar-tile.js";
import { PinPad } from "./pin-pad.js";

const log = createLogger(["sentient", "webui", "auth", "login-screen"]);

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface LoginScreenProps {
  api: AuthApi;
  auth: {
    login(input: { userId: string; pin: string }): Promise<
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

export function LoginScreen({ api, auth }: LoginScreenProps): JSX.Element {
  const [stage, setStage] = useState<Stage>({ view: "loading" });
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [pinError, setPinError] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);

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
    log.debug("user-selected", { userId });
    setPinError(null);
    setResetSignal((n) => n + 1);
    setStage({ view: "pin", userId: user.userId, displayName: user.displayName });
  }, [users]);

  const handlePinSubmit = useCallback(async (pin: string) => {
    if (stage.view !== "pin") return;
    log.debug("pin-submit", { userId: stage.userId });
    const result = await auth.login({ userId: stage.userId, pin });
    if (!result.ok) {
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
    // Success: auth state transitions to authenticated, parent unmounts us
    log.debug("login-success", { userId: stage.userId });
  }, [stage, auth]);

  const handleBack = useCallback(() => {
    setPinError(null);
    setStage({ view: "avatars" });
  }, []);

  // ---- Render ----

  if (stage.view === "loading") {
    return (
      <div class="login-screen">
        <div class="login-screen__card login-screen__card--loading">
          <div class="login-screen__title">Loading...</div>
        </div>
      </div>
    );
  }

  if (stage.view === "error") {
    return (
      <div class="login-screen">
        <div class="login-screen__card">
          <div class="login-screen__title">Could not load users</div>
          <p class="login-screen__error">Check your connection and try again.</p>
          <button class="login-screen__back" onClick={fetchUsers}>Try Again</button>
        </div>
      </div>
    );
  }

  if (stage.view === "empty") {
    return (
      <div class="login-screen">
        <div class="login-screen__card">
          <div class="login-screen__title">No users found</div>
          <p class="login-screen__error">Ask an admin to create a profile for you.</p>
        </div>
      </div>
    );
  }

  if (stage.view === "pin") {
    return (
      <div class="login-screen">
        <div class="login-screen__card">
          <button class="login-screen__back" onClick={handleBack} aria-label="Back to user list">
            ← Back
          </button>
          <div class="login-screen__title">Enter PIN for {stage.displayName}</div>
          <PinPad onSubmit={handlePinSubmit} resetSignal={resetSignal} />
          {pinError && <p class="login-screen__error">{pinError}</p>}
        </div>
      </div>
    );
  }

  // Avatars grid (default)
  return (
    <div class="login-screen">
      <div class="login-screen__card">
        <div class="login-screen__title">Who's using Sentient?</div>
        <div class="login-screen__grid">
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
      </div>
    </div>
  );
}