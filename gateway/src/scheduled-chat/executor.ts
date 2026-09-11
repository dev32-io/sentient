import type { AccessManager } from "../access/access-manager.js";
import { PrivateScheduleResource } from "../access/private-schedule-resource.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import type {
  AuthorizedScheduledExecution,
  ScheduledExecutionAuthorizer,
  ScheduledMessageSubmitter,
  SchedulingResult,
  TerminalReceipt,
} from "../scheduling/contracts.js";
import { mintSessionId } from "../session-handlers/session-id.js";
import type { SessionHandles, SessionRegistry } from "../session-handlers/session-registry.js";
import type { ScheduledSessionExecution } from "../store/session-metadata.js";
import { MintKeyConflictError, openSessionStore } from "../store/session-store.js";
import type { UserStore } from "../user-auth/user-store.js";

const SCHEDULE_HOUSEHOLD_ID = "scheduled-execution";

export function createScheduledExecutionAuthorizer(deps: {
  users: Pick<UserStore, "get">;
  accessManager: AccessManager;
  householdId?: string;
  authorizeCalendarReminder?: (execution: AuthorizedScheduledExecution, signal: AbortSignal) => Promise<boolean>;
}): ScheduledExecutionAuthorizer {
  return {
    async authorize(claim, signal) {
      if (signal.aborted) return unavailable();
      try {
        const user = await deps.users.get(claim.ownerUserId);
        if (!user.ok) return unavailable();
        if (!user.value) return forbidden();
        const principal = createUserPrincipal(
          claim.ownerUserId,
          user.value.role,
          deps.householdId ?? SCHEDULE_HOUSEHOLD_ID,
        );
        const execution: AuthorizedScheduledExecution = {
          claim,
          principal,
          resource: new PrivateScheduleResource(deps.accessManager.grant(principal, "schedule-private")),
        };
        if (claim.source.kind === "calendar-reminder") {
          if (!deps.authorizeCalendarReminder || !(await deps.authorizeCalendarReminder(execution, signal)))
            return forbidden();
        }
        return { ok: true, value: execution };
      } catch {
        return forbidden();
      }
    },
  };
}

function unavailable<T>(): SchedulingResult<T> {
  return { ok: false, error: { code: "unavailable", retryable: true } };
}
function forbidden<T>(): SchedulingResult<T> {
  return { ok: false, error: { code: "forbidden", retryable: false } };
}

export interface ScheduledMessageSubmitterDeps {
  readonly accessManager: AccessManager;
  readonly dbFileName?: string;
  readonly registry: SessionRegistry;
  readonly associateSession: (
    claim: AuthorizedScheduledExecution["claim"],
    sessionId: string,
  ) => Promise<SchedulingResult<{ occurrenceId: string; sessionId: string; replayed: boolean }>>;
  readonly buildHandles: (
    principal: AuthorizedScheduledExecution["principal"],
    sessionId: string,
    correlationId: string,
  ) => SessionHandles;
  readonly now?: () => Date;
  readonly makeSessionId?: () => string;
}

function receiptFromSaved(
  execution: AuthorizedScheduledExecution,
  sessionId: string,
  saved: ScheduledSessionExecution,
): TerminalReceipt | null {
  if (!saved.outcome || !saved.completedAt) return null;
  if (saved.outcome === "completed" && saved.entryId) {
    return {
      outcome: "completed",
      sessionId,
      completedAt: saved.completedAt,
      content: {
        ownerUserId: execution.claim.ownerUserId,
        sessionId,
        occurrenceId: execution.claim.occurrenceId,
        entryId: saved.entryId,
      },
    };
  }
  return {
    outcome: saved.outcome === "completed" ? "failed" : saved.outcome,
    sessionId,
    completedAt: saved.completedAt,
  };
}

/** One occurrence -> one mint key -> one ordinary conversational append. */
export function createScheduledMessageSubmitter(deps: ScheduledMessageSubmitterDeps): ScheduledMessageSubmitter {
  return {
    async submit(execution, signal) {
      const { claim, principal } = execution;
      const mintKey = `scheduled:${claim.occurrenceId}`;
      let sessionId: string;
      let store: ReturnType<typeof openSessionStore> | undefined;
      try {
        store = openSessionStore(deps.accessManager.grant(principal, "session-store"), deps.dbFileName);
        const existing = store.findSessionByMintKey(mintKey);
        if (existing) sessionId = existing.sessionId;
        else {
          sessionId = deps.makeSessionId?.() ?? mintSessionId();
          try {
            store.createSession(sessionId, mintKey);
          } catch (error) {
            if (!(error instanceof MintKeyConflictError)) throw error;
            const raced = store.findSessionByMintKey(mintKey);
            if (!raced) throw error;
            sessionId = raced.sessionId;
          }
        }
        if (
          !store.setScheduledProvenance?.(
            sessionId,
            claim.occurrenceId,
            claim.intendedAt,
            (deps.now?.() ?? new Date()).toISOString(),
          )
        )
          return { ok: false, error: { code: "conflict", retryable: false } };
      } catch {
        return unavailable();
      } finally {
        store?.close();
      }

      const associated = await deps.associateSession(claim, sessionId);
      if (!associated.ok) return associated;

      // Reconcile the separate durable session boundary before starting work.
      // A committed input without a terminal record means the old process died
      // in an ambiguous in-flight window: consume it as interrupted, never replay.
      let recovery: ReturnType<typeof openSessionStore> | undefined;
      try {
        recovery = openSessionStore(deps.accessManager.grant(principal, "session-store"), deps.dbFileName);
        const metadata = recovery.getSession(sessionId);
        const saved = metadata?.scheduled;
        if (saved) {
          const terminal = receiptFromSaved(execution, sessionId, saved);
          if (terminal) return { ok: true, value: terminal };
          const input = recovery.findByPendingId(sessionId, claim.occurrenceId);
          if (input) {
            const assistant = recovery
              .readSession(sessionId)
              .filter((entry) => entry.turnId === input.turnId && entry.kind === "assistant")
              .at(-1);
            const outcome = assistant?.cutoff ? "interrupted" : assistant ? "completed" : "interrupted";
            const completedAt = (deps.now?.() ?? new Date()).toISOString();
            recovery.setScheduledTurn?.(sessionId, claim.occurrenceId, input.turnId);
            const terminalSaved = recovery.recordScheduledTerminal?.(
              sessionId,
              input.turnId,
              outcome,
              completedAt,
              assistant ? String(assistant.seq) : null,
            );
            const receipt = terminalSaved && receiptFromSaved(execution, sessionId, terminalSaved);
            return receipt ? { ok: true, value: receipt } : unavailable();
          }
        }
      } catch {
        return unavailable();
      } finally {
        recovery?.close();
      }

      try {
        const handles = deps.registry.ensure(sessionId, () =>
          deps.buildHandles(principal, sessionId, `scheduled:${claim.occurrenceId}`),
        );
        const interrupt = () => handles.runtime.interrupt();
        signal.addEventListener("abort", interrupt, { once: true });
        try {
          if (!handles.runtime.submitAndObserve) return unavailable();
          const terminal = await handles.runtime.submitAndObserve({
            kind: "conversational",
            text: claim.message,
            pendingId: claim.occurrenceId,
          });
          if (terminal.outcome === "completed" && terminal.entryId) {
            return {
              ok: true,
              value: {
                outcome: "completed",
                sessionId,
                completedAt: terminal.completedAt,
                content: {
                  ownerUserId: claim.ownerUserId,
                  sessionId,
                  occurrenceId: claim.occurrenceId,
                  entryId: terminal.entryId,
                },
              },
            };
          }
          return {
            ok: true,
            value: {
              outcome: terminal.outcome === "completed" ? "failed" : terminal.outcome,
              sessionId,
              completedAt: terminal.completedAt,
            },
          };
        } finally {
          signal.removeEventListener("abort", interrupt);
          deps.registry.reevaluate(sessionId);
        }
      } catch {
        return unavailable();
      }
    },
  };
}
