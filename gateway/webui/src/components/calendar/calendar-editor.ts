/** Compatibility barrel; the route uses EventEditor while refinements target named composites. */
export {
  EventEditor,
  CalendarEventEditor,
  CalendarEditor,
  buildCreatePayload,
  buildDeletePayload,
  buildUpdatePayload,
} from "./event-editor.tsx";
export type {
  CalendarEditorApiResult,
  CalendarEditorCallbackResult,
  CalendarEditorDraft,
  CalendarEditorError,
  CalendarEditorFrequency,
  CalendarEditorInitialDraft,
  CalendarEditorMode,
  CalendarEditorOutcome,
  CalendarEditorRequest,
  EventEditorProps,
} from "./calendar-editor-types.ts";
export {
  CalendarEditorBasicsSection,
  CalendarEditorDateTimeSection,
  CalendarEditorFeedback,
  CalendarEditorMetadataSection,
  CalendarEditorRecurrenceSection,
  CalendarEditorScopeSection,
} from "./calendar-editor-sections.tsx";
export { CalendarEditorFooter } from "./calendar-editor-footer.tsx";
export { CalendarDiscardChangesDialog } from "./calendar-editor-overlays.tsx";
export { MutationScopeChooser, RecurrenceMutationScopeChooser } from "./mutation-scope-chooser.tsx";
export { DeleteConfirmation } from "./delete-confirmation.tsx";
export { calendarCapabilityAllows } from "./calendar-access.ts";
export type { CalendarAccessCapabilities } from "./calendar-access.ts";
export {
  buildCreateInput,
  buildDeleteCommand,
  buildUpdateCommand,
  buildRecurrence,
  buildTimes,
} from "./calendar-editor-model.ts";
