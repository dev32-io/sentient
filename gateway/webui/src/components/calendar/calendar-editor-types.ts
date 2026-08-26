import type {
  CalendarApi,
  CalendarApiResult,
  CalendarCreateInput,
  CalendarEvent,
  CalendarGetResult,
  CalendarImportance,
  CalendarMutationCommand,
  CalendarMutationResult,
  CalendarOccurrence,
  CalendarRecurrence,
  CalendarScope,
  CalendarVisibility,
  CalendarWeekday,
} from "../../services/calendar-api.ts";
import type { CalendarAccessCapabilities } from "./calendar-access.ts";

export type CalendarEditorMode = "create" | "edit";
export type CalendarEditorFrequency = CalendarRecurrence["frequency"];

export interface CalendarEditorDraft {
  title: string;
  description: string;
  allDay: boolean;
  start: string;
  end: string;
  scope: CalendarScope;
  visibility: CalendarVisibility;
  importance: CalendarImportance;
  group: string;
  tagsText: string;
  recurrenceEnabled: boolean;
  recurrenceFrequency: CalendarEditorFrequency;
  recurrenceInterval: string;
  recurrenceWeekdays: CalendarWeekday[];
  recurrenceEnd: "count" | "until";
  recurrenceCount: string;
  recurrenceUntil: string;
  /** The device zone used by native datetime-local controls. */
  inputTimeZoneId: string;
  /** Compatibility/source zone retained for helper conversion only. */
  eventTimeZoneId?: string;
  /** Raw source values let unchanged fields round-trip without normalization. */
  sourceStart?: string;
  sourceEnd?: string;
  sourceStartInput?: string;
  sourceEndInput?: string;
  sourceRecurrenceUntil?: string;
  sourceRecurrenceUntilInput?: string;
}

export type CalendarEditorInitialDraft = Partial<CalendarEditorDraft> & {
  /** Convenience input for callers that already have normalized tags. */
  tags?: readonly string[];
};

export interface CalendarEditorCreateRequest {
  readonly operation: "create";
  readonly input: CalendarCreateInput;
}

export interface CalendarEditorUpdateRequest {
  readonly operation: "update";
  readonly eventId: string;
  readonly command: Extract<CalendarMutationCommand, { operation: "update" }>;
}

export interface CalendarEditorDeleteRequest {
  readonly operation: "delete";
  readonly eventId: string;
  readonly command: Extract<CalendarMutationCommand, { operation: "delete" }>;
}

export type CalendarEditorRequest =
  | CalendarEditorCreateRequest
  | CalendarEditorUpdateRequest
  | CalendarEditorDeleteRequest;

export interface CalendarEditorError {
  readonly code: string;
  readonly status: number;
  /** Sanitized UI copy; server reason/message text is never displayed. */
  readonly message: string;
}

export type CalendarEditorOutcome =
  | {
      readonly kind: "success";
      readonly operation: CalendarEditorRequest["operation"];
      readonly request: CalendarEditorRequest;
      readonly result: CalendarEvent | CalendarMutationResult;
      readonly successorEventId?: string;
    }
  | {
      readonly kind: "failure";
      readonly operation: CalendarEditorRequest["operation"];
      readonly request: CalendarEditorRequest;
      readonly error: CalendarEditorError;
      readonly draft: CalendarEditorDraft;
    }
  | {
      readonly kind: "submitted";
      readonly operation: CalendarEditorRequest["operation"];
      readonly request: CalendarEditorRequest;
    };

export type CalendarEditorApiResult = CalendarApiResult<CalendarEvent | CalendarMutationResult>;
// Delegated callbacks intentionally permit a fire-and-report path.
// biome-ignore lint/suspicious/noConfusingVoidType: void preserves the existing callback contract
export type CalendarEditorCallbackResult = CalendarEditorApiResult | void | Promise<CalendarEditorApiResult | void>;

export interface EventEditorProps {
  /** Controlled visibility. Defaults to true for leaf-component use. */
  readonly open?: boolean;
  readonly mode?: CalendarEditorMode;
  readonly event?: CalendarEvent | CalendarOccurrence | null;
  /** Alias accepted by preview integrations. */
  readonly occurrence?: CalendarOccurrence | null;
  readonly api?: CalendarApi;
  readonly token?: string;
  readonly capabilities?: CalendarAccessCapabilities;
  readonly inputTimeZoneId?: string;
  readonly initialDraft?: CalendarEditorInitialDraft;
  onClose?(): void;
  onCancel?(): void;
  onOpenChange?(open: boolean): void;
  onSubmit?(request: CalendarEditorRequest): CalendarEditorCallbackResult;
  onCommand?(request: CalendarEditorRequest): CalendarEditorCallbackResult;
  onCreate?(input: CalendarCreateInput): CalendarEditorCallbackResult;
  onUpdate?(
    eventId: string,
    command: Extract<CalendarMutationCommand, { operation: "update" }>,
  ): CalendarEditorCallbackResult;
  onDelete?(
    eventId: string,
    command: Extract<CalendarMutationCommand, { operation: "delete" }>,
  ): CalendarEditorCallbackResult;
  onOutcome?(outcome: CalendarEditorOutcome): void;
  onSuccess?(result: CalendarEvent | CalendarMutationResult, request: CalendarEditorRequest): void;
  onFailure?(error: CalendarEditorError, draft: CalendarEditorDraft, request: CalendarEditorRequest): void;
  onSubmitted?(request: CalendarEditorRequest): void;
  onReread?(
    eventId: string,
    options: { scope: CalendarScope; originalStart?: string },
    // biome-ignore lint/suspicious/noConfusingVoidType: void preserves the existing reread callback contract
  ): CalendarApiResult<CalendarGetResult> | void | Promise<CalendarApiResult<CalendarGetResult> | void>;
}
