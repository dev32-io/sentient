import type { JSX } from "preact";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import type { AuthApi, PublicUser } from "../../services/auth-api.js";
import type { AuthLoginOptions } from "../../hooks/use-auth.js";
import { AUTH_TIMEOUT_MS } from "../../constants.js";
import { AvatarTile } from "./avatar-tile.js";
import { PinPad } from "./pin-pad.js";
import { Avatar, type AvatarTint } from "../common/avatar.tsx";
import { SentientIdentity } from "../common/sentient-identity.tsx";
import { Dialog } from "../common/dialog.tsx";
import { ActionButton, Surface } from "../common/foundation.tsx";
import { AsyncState, Notice, SearchFilterBar, PIN_CHECKING_MIN_MS, PIN_SUCCESS_TRANSITION_MS } from "../common/composites.tsx";
import "./login-screen.css";

const log = createLogger(["sentient", "webui", "auth", "login-screen"]);

export interface LoginScreenProps {
  api: AuthApi;
  notice?: string | undefined;
  auth: {
    login(input: { userId: string; pin: string }, options?: AuthLoginOptions): Promise<
      | { ok: true; value: { token: string } }
      | { ok: false; error: { status: number; code: string } }
    >;
  };
}

type Stage = { view: "loading" | "avatars" | "empty" | "error" } | { view: "pin"; user: PublicUser };

// Cancellation releases presentation timers immediately, without extending the handoff.
function waitForMinimum(startedAt: number, minimumMs: number, signal: AbortSignal): Promise<void> {
  const remaining = minimumMs - (Date.now() - startedAt);
  if (remaining <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = window.setTimeout(finish, remaining);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export function LoginScreen({ api, auth, notice }: LoginScreenProps): JSX.Element {
  const [stage, setStage] = useState<Stage>({ view: "loading" });
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [query, setQuery] = useState("");
  const [help, setHelp] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinSuccess, setPinSuccess] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const [reload, setReload] = useState(0);
  const attemptRef = useRef<AbortController | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const restoreUserRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    setStage({ view: "loading" });
    const fail = () => {
      if (!active) return;
      active = false;
      window.clearTimeout(timer);
      log.warn("list-users-failed");
      setStage({ view: "error" });
    };
    const timer = window.setTimeout(fail, AUTH_TIMEOUT_MS);
    void api.listUsers().then((result) => {
      if (!active) return;
      if (!result.ok) { fail(); return; }
      active = false;
      window.clearTimeout(timer);
      setUsers(result.value);
      setStage({ view: result.value.length ? "avatars" : "empty" });
    }, fail);
    return () => { active = false; window.clearTimeout(timer); };
  }, [api, reload]);

  useEffect(() => () => { attemptRef.current?.abort(); }, []);

  useLayoutEffect(() => {
    const root = stageRef.current;
    if (stage.view === "pin") {
      root?.querySelector<HTMLElement>('[aria-label="PIN digit 1"]')?.focus();
    } else if (stage.view === "avatars" && restoreUserRef.current) {
      const target = Array.from(root?.querySelectorAll<HTMLElement>("[data-user-id]") ?? [])
        .find((element) => element.dataset.userId === restoreUserRef.current);
      target?.focus();
    }
  }, [stage]);

  const handleSelectUser = useCallback((userId: string) => {
    const user = users.find((u) => u.userId === userId);
    if (!user) return;
    attemptRef.current?.abort();
    restoreUserRef.current = userId;
    setPinError(null);
    setPinSuccess(null);
    setResetSignal((n) => n + 1);
    setStage({ view: "pin", user });
  }, [users]);

  const handlePinSubmit = async (pin: string) => {
    if (stage.view !== "pin") return;
    attemptRef.current?.abort();
    const attempt = new AbortController();
    attemptRef.current = attempt;
    const { signal } = attempt;
    const checkingStartedAt = Date.now();
    const result = await auth.login({ userId: stage.user.userId, pin }, {
      signal,
      beforeCommit: async () => {
        await waitForMinimum(checkingStartedAt, PIN_CHECKING_MIN_MS, signal);
        if (signal.aborted) return;
        setPinSuccess("Pin accepted.");
        await waitForMinimum(Date.now(), PIN_SUCCESS_TRANSITION_MS, signal);
      },
    });
    if (signal.aborted) return;
    if (!result.ok) {
      await waitForMinimum(checkingStartedAt, PIN_CHECKING_MIN_MS, signal);
      if (signal.aborted) return;
      setPinSuccess(null);
      setPinError(result.error.code === "invalid-credentials" ? "Wrong PIN" : "Something went wrong. Please try again.");
      setResetSignal((n) => n + 1);
    }
  };

  const handleBack = useCallback(() => {
    attemptRef.current?.abort();
    setPinError(null);
    setPinSuccess(null);
    setStage({ view: "avatars" });
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && stage.view === "pin" && !help) {
        event.preventDefault();
        handleBack();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stage.view, help, handleBack]);

  const clearSearch = () => {
    setQuery("");
    stageRef.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
  };
  const filtered = users.filter((user) => user.displayName.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  return (
    <Surface className="homecoming">
      <header class="homecoming__brand">Sentient</header>
      <div class="homecoming__body">
        <section class="homecoming__welcome" aria-label="Welcome to Sentient">
          <div class="homecoming__identity"><SentientIdentity size={128} /></div>
          <h1>A little less to do.<em>A little more home.</em></h1>
          <p>Your family’s everyday,<br />with a little help from Sentient.</p>
          <span class="homecoming__signature">Here for the everyday.</span>
        </section>
        <div class="homecoming__stage" ref={stageRef}>
          {notice && <Notice>{notice}</Notice>}
          <div key={stage.view} class="homecoming__content">
            {stage.view === "loading" && <AsyncState state="loading" title="Loading profiles" message="Finding your household…" />}
            {stage.view === "error" && <AsyncState state="error" title="Could not load profiles" message="Check your connection and try again." action={<ActionButton variant="primary" onClick={() => setReload((n) => n + 1)}>Try again</ActionButton>} />}
            {stage.view === "empty" && <AsyncState state="empty" title="No profiles found" message="Ask a household admin to create a profile for you." action={<ActionButton onClick={() => setReload((n) => n + 1)}>Refresh profiles</ActionButton>} />}
            {stage.view === "pin" && <>
              <ActionButton variant="quiet" className="homecoming__back" onClick={handleBack}>← Back to profiles</ActionButton>
              <div class="homecoming__pin-identity">
                <Avatar kind="user" size="xl" name={stage.user.displayName} initial={stage.user.displayName.charAt(0)} tint={stage.user.avatarTint as AvatarTint} />
                <div><h2>Enter PIN for {stage.user.displayName}</h2><p>Make yourself at home.</p></div>
              </div>
              <PinPad onSubmit={handlePinSubmit} resetSignal={resetSignal} error={pinError ?? undefined} success={pinSuccess ?? undefined} />
            </>}
            {stage.view === "avatars" && <>
              <div class="homecoming__heading"><h2>Welcome home.</h2><span role="status">{query ? `${filtered.length} of ${users.length}` : `${users.length} people`}</span></div>
              <p class="homecoming__subtitle">Choose your name. Make yourself at home.</p>
              {users.length > 6 && <SearchFilterBar value={query} onChange={setQuery} label="Find your name" placeholder="Find your name">
                {query && <ActionButton variant="quiet" onClick={clearSearch}>Clear search</ActionButton>}
              </SearchFilterBar>}
              <div class="homecoming__people" role="group" aria-label="Choose your profile">
                {filtered.map((user) => <AvatarTile key={user.userId} userId={user.userId} displayName={user.displayName} avatarTint={user.avatarTint as AvatarTint} onSelect={handleSelectUser} />)}
                {!filtered.length && <div class="homecoming__empty"><p>No matching names. Try a different spelling.</p><ActionButton variant="quiet" onClick={clearSearch}>Clear name search</ActionButton></div>}
              </div>
              <p class="homecoming__hint">Your pin comes next.</p>
            </>}
          </div>
          <ActionButton variant="quiet" className="homecoming__help" onClick={() => setHelp(true)}>Need help signing in?</ActionButton>
        </div>
      </div>
      <footer class="homecoming__footer">A familiar place for everyone.</footer>
      {help && <Dialog title="A little help." onClose={() => setHelp(false)} footer={<ActionButton variant="primary" onClick={() => setHelp(false)}>Got it</ActionButton>}>
        <p>Forgotten your pin? Ask the person who manages your Sentient accounts to reset it.</p>
        <p>This browser connects through the address you opened. If profiles won’t load, check your connection and confirm the address with your household administrator.</p>
      </Dialog>}
    </Surface>
  );
}
