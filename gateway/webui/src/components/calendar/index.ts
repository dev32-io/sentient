/** Public Calendar product boundary. Internal controller, draft, and overlay modules are not exported here. */
export { CalendarView } from "./calendar-view.tsx";
export type { CalendarViewProps } from "./calendar-product-api.ts";
export { CalendarWorkspace } from "./calendar-workspace.tsx";
export type {
  CalendarWorkspaceActions,
  CalendarWorkspaceModel,
  CalendarWorkspaceProps,
  CalendarWorkspacePublicProps,
} from "./calendar-workspace.tsx";
export {
  CalendarActiveFilterSummary,
  CalendarCompactControls,
  CalendarFilterDialog,
  CalendarFilterPanel,
  CalendarFilterSidebar,
  CalendarSearchControl,
} from "./calendar-filter-controls.tsx";
export type {
  CalendarActiveFilterSummaryProps,
  CalendarCompactControlsProps,
  CalendarFilterControlsProps,
  CalendarFilterDialogProps,
  CalendarFilterPanelProps,
  CalendarFilterSidebarProps,
  CalendarSearchControlProps,
} from "./calendar-filter-controls.tsx";
export { CalendarCanvas } from "./calendar-canvas.tsx";
export type { CalendarCanvasProps, CalendarCanvasSlot, CalendarCanvasSlotProps } from "./calendar-canvas.tsx";
export { EventPreview } from "./event-preview.tsx";
export type { EventPreviewProps } from "./event-preview.tsx";
export { EventEditor } from "./event-editor.tsx";
export type {
  CalendarEditorDraft,
  CalendarEditorError,
  CalendarEditorOutcome,
  CalendarEditorRequest,
  EventEditorProps,
} from "./event-editor.tsx";
