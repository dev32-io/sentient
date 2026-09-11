import type {
  Schedule,
  ScheduleCreateRequest,
  ScheduleErrorCode,
  SchedulePatchRequest,
  ScheduledSessionCard,
} from "@sentient/protocol";
import type { Result } from "@sentient/protocol";
import type { PrivateScheduleResource } from "../access/private-schedule-resource.js";
import type { UserId } from "../user-auth/user-id.js";

export type SchedulingFailure = Readonly<{
  code: ScheduleErrorCode | "claim_lost" | "closed";
  retryable: boolean;
}>;
export type SchedulingResult<T> = Result<T, SchedulingFailure>;

/** Public API/service seam. Relative timing is resolved before `create` returns. */
export interface ScheduleCommands {
  create(
    resource: PrivateScheduleResource,
    request: ScheduleCreateRequest,
    acceptedAt: Date,
  ): Promise<SchedulingResult<Schedule>>;
  patch(
    resource: PrivateScheduleResource,
    scheduleId: string,
    request: SchedulePatchRequest,
    acceptedAt: Date,
  ): Promise<SchedulingResult<Schedule>>;
  delete(
    resource: PrivateScheduleResource,
    scheduleId: string,
    expectedRevision: number,
  ): Promise<SchedulingResult<void>>;
  list(
    resource: PrivateScheduleResource,
    cursor: string | undefined,
    limit: number,
  ): Promise<SchedulingResult<ReadonlyArray<Schedule>>>;
  cards(
    resource: PrivateScheduleResource,
    cursor: string | undefined,
    limit: number,
  ): Promise<SchedulingResult<ReadonlyArray<ScheduledSessionCard>>>;
}

/** A leased occurrence. `occurrenceId` is stable across claims and process restarts. */
export interface DueClaim {
  readonly claimToken: string;
  readonly scheduleId: string;
  readonly occurrenceId: string;
  readonly ownerUserId: UserId;
  readonly intendedAt: string;
  readonly claimedUntil: string;
  readonly message: string;
  readonly oneTime: boolean;
}

export interface DueClaimSource {
  claimDue(now: Date, limit: number, leaseMs: number): Promise<SchedulingResult<ReadonlyArray<DueClaim>>>;
}

/**
 * Durable terminal record. A saved session identifies the ordinary chat outcome;
 * interrupted/failed execution is terminal and must not be blindly submitted again.
 */
export type TerminalReceipt =
  | Readonly<{ outcome: "completed"; sessionId: string; completedAt: string; content: ScheduledContentReference }>
  | Readonly<{ outcome: "failed" | "interrupted" | "expired"; sessionId?: string; completedAt: string }>;

/** Identifies saved session content without copying assistant text into a queue. */
export interface ScheduledContentReference {
  readonly ownerUserId: UserId;
  readonly sessionId: string;
  readonly occurrenceId: string;
  readonly entryId: string;
}

export interface ContentOutboxEntry {
  readonly outboxId: string;
  readonly content: ScheduledContentReference;
  readonly availableAt: string;
}

export interface FinalizationResult {
  readonly occurrenceId: string;
  readonly scheduleConsumed: boolean;
  readonly nextRunAt: string | null;
  readonly replayed: boolean;
}

/**
 * Persistence extension whose implementation must commit the terminal receipt,
 * one-time consumption/recurring advance, and optional content-reference outbox
 * row atomically. There is deliberately no separate enqueue call that can split
 * those writes; the later persistence owner implements this transaction once.
 */
export interface AtomicScheduleFinalizer {
  finalizeClaim(
    claim: DueClaim,
    receipt: TerminalReceipt,
    outbox: ContentOutboxEntry | undefined,
  ): Promise<SchedulingResult<FinalizationResult>>;
}

/** Independent drain: retrying delivery never reclaims or re-executes a schedule. */
export interface ScheduledContentOutbox {
  claim(now: Date, limit: number, leaseMs: number): Promise<SchedulingResult<ReadonlyArray<ContentOutboxEntry>>>;
  acknowledge(outboxId: string): Promise<SchedulingResult<void>>;
  retry(outboxId: string, availableAt: Date): Promise<SchedulingResult<void>>;
}

export type ResolvedScheduledContent = Readonly<{
  sessionId: string;
  entryId: string;
  plainText: string;
}>;

/** Rechecks capability owner and session authorization before reading saved content. */
export interface AuthorizedScheduledContentResolver {
  resolve(
    resource: PrivateScheduleResource,
    reference: ScheduledContentReference,
    signal: AbortSignal,
  ): Promise<SchedulingResult<ResolvedScheduledContent>>;
}

/** Adapter seam: submits the saved body as a normal message in one fresh session. */
export interface ScheduledMessageSubmitter {
  submit(claim: DueClaim, signal: AbortSignal): Promise<SchedulingResult<TerminalReceipt>>;
}
