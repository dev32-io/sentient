# Calendar implementation handoff

## Outcome

- Implement the reviewed responsive Calendar workspace, view projections, filters, event components, previews, overflow, and mutation surfaces shown by these isolated references.
- Each PNG has a transparent surrounding canvas; calendar plates, cells, wells, event faces, dialogs, shadows, focus rings, and semantic indicators retained inside the crop are part of the reviewed component anatomy.
- Keep Preact, SwiftUI, and Compose implementations native. The prototype and rendered references are visual and behavioral authority, not production dependencies.

## Prototype

- Entry point: `design/prototype/calendar/index.html` — approved Calendar review surface.
- Source styling and behavior: `design/prototype/calendar/calendar.css` and `design/prototype/calendar/calendar.js`.
- Composite transparent references over the canonical Dusk canvas when reviewing contrast and directional depth.

## Workspace references

- `design/prototype/calendar/handoff/static/calendar-workspace--month--desktop.png` — complete desktop Month workspace with toolbar and view switcher.
- `design/prototype/calendar/handoff/static/calendar-workspace--month--compact.png` — compact Month workspace with importance-dot event presentation.
- `design/prototype/calendar/handoff/static/calendar-workspace--day--desktop.png` — complete desktop Day agenda workspace.
- `design/prototype/calendar/handoff/static/calendar-workspace--day--compact.png` — compact Day agenda workspace.
- `design/prototype/calendar/handoff/static/calendar-workspace--week--desktop.png` — complete desktop seven-column Week workspace.
- `design/prototype/calendar/handoff/static/calendar-workspace--week--compact.png` — compact Week agenda composition.
- `design/prototype/calendar/handoff/static/calendar-workspace--year--desktop.png` — complete desktop Year workspace.
- `design/prototype/calendar/handoff/static/calendar-workspace--year--compact.png` — compact Year workspace.
- `design/prototype/calendar/handoff/static/calendar-workspace--no-match--desktop.png` — desktop workspace when current filters match no events.
- `design/prototype/calendar/handoff/static/calendar-workspace--no-match--compact.png` — compact no-match workspace with recovery notice.

## Calendar-stage references

- `design/prototype/calendar/handoff/static/calendar-stage--month--desktop.png` — isolated desktop six-row Month grid.
- `design/prototype/calendar/handoff/static/calendar-stage--month--compact.png` — isolated compact Month grid with semantic event dots.
- `design/prototype/calendar/handoff/static/calendar-stage--day--desktop.png` — isolated desktop Day agenda.
- `design/prototype/calendar/handoff/static/calendar-stage--day--compact.png` — isolated compact Day agenda.
- `design/prototype/calendar/handoff/static/calendar-stage--week--desktop.png` — isolated desktop Week projection.
- `design/prototype/calendar/handoff/static/calendar-stage--week--compact.png` — isolated compact Week projection.
- `design/prototype/calendar/handoff/static/calendar-stage--year--desktop.png` — isolated desktop Year projection.
- `design/prototype/calendar/handoff/static/calendar-stage--year--compact.png` — isolated compact Year projection.

## Toolbar and view references

- `design/prototype/calendar/handoff/static/calendar-toolbar--month--desktop.png` — desktop Month title, navigation, and add-event toolbar.
- `design/prototype/calendar/handoff/static/calendar-toolbar--month--compact.png` — compact toolbar with icon-only filter and add actions.
- `design/prototype/calendar/handoff/static/calendar-navigation--rest.png` — isolated previous, Today, and next navigation group.
- `design/prototype/calendar/handoff/static/calendar-view-switch--day-selected.png` — view switcher with Day selected.
- `design/prototype/calendar/handoff/static/calendar-view-switch--week-selected.png` — view switcher with Week selected.
- `design/prototype/calendar/handoff/static/calendar-view-switch--month-selected.png` — view switcher with Month selected.
- `design/prototype/calendar/handoff/static/calendar-view-switch--year-selected.png` — view switcher with Year selected.

## Filter references

- `design/prototype/calendar/handoff/static/calendar-filters--default--desktop.png` — desktop filter panel with both calendar scopes included.
- `design/prototype/calendar/handoff/static/calendar-filters--search-focus--desktop.png` — filter panel with local search visibly keyboard-focused.
- `design/prototype/calendar/handoff/static/calendar-filters--groups-open--desktop.png` — filter panel with the Groups disclosure open.
- `design/prototype/calendar/handoff/static/calendar-filters--groups-school-selected--desktop.png` — open Groups disclosure with School selected.
- `design/prototype/calendar/handoff/static/calendar-filters--tags-open--desktop.png` — filter panel with the Tags disclosure open.
- `design/prototype/calendar/handoff/static/calendar-filters--active--desktop.png` — filter panel showing intersecting active facet filters.
- `design/prototype/calendar/handoff/static/calendar-filters--search-pickup--desktop.png` — filter panel with a title-and-description search query.
- `design/prototype/calendar/handoff/static/calendar-filters--no-scopes--desktop.png` — filter panel with neither Private nor Household selected.
- `design/prototype/calendar/handoff/static/calendar-filters--drawer--compact.png` — compact dismissible filter drawer.
- `design/prototype/calendar/handoff/static/calendar-filters--drawer--reduced-motion.png` — static Reduced Motion filter drawer.

## Month-event references

- `design/prototype/calendar/handoff/static/calendar-month-cell--dense--desktop.png` — dense desktop date cell with visible events and correctly counted overflow.
- `design/prototype/calendar/handoff/static/calendar-month-cell--dense--compact.png` — compact dense date cell with event dots and numeric overflow.
- `design/prototype/calendar/handoff/static/calendar-event--normal--rest.png` — normal-importance event button at rest.
- `design/prototype/calendar/handoff/static/calendar-event--important--rest.png` — important event button at rest.
- `design/prototype/calendar/handoff/static/calendar-event--pinned--rest.png` — pinned event button at rest.
- `design/prototype/calendar/handoff/static/calendar-event--pinned--hover.png` — pinned event under precise-pointer hover.
- `design/prototype/calendar/handoff/static/calendar-event--pinned--focus.png` — keyboard-focused pinned event.
- `design/prototype/calendar/handoff/static/calendar-overflow--more--rest.png` — dense-cell overflow action at rest.
- `design/prototype/calendar/handoff/static/calendar-overflow--more--hover.png` — dense-cell overflow action under precise-pointer hover.
- `design/prototype/calendar/handoff/static/calendar-overflow--more--focus.png` — keyboard-focused dense-cell overflow action.

## Agenda and year references

- `design/prototype/calendar/handoff/static/calendar-agenda-row--normal--rest.png` — normal-importance agenda row at rest.
- `design/prototype/calendar/handoff/static/calendar-agenda-row--important--rest.png` — important agenda row at rest.
- `design/prototype/calendar/handoff/static/calendar-agenda-row--pinned--rest.png` — pinned agenda row at rest.
- `design/prototype/calendar/handoff/static/calendar-agenda-row--pinned--hover.png` — pinned agenda row under precise-pointer hover.
- `design/prototype/calendar/handoff/static/calendar-agenda-row--pinned--focus.png` — keyboard-focused pinned agenda row.
- `design/prototype/calendar/handoff/static/calendar-year-month--january--rest.png` — Year-view month target at rest.
- `design/prototype/calendar/handoff/static/calendar-year-month--january--hover.png` — Year-view month target under precise-pointer hover.
- `design/prototype/calendar/handoff/static/calendar-year-month--january--focus.png` — keyboard-focused Year-view month target.

## Preview and mutation references

- `design/prototype/calendar/handoff/static/event-preview--recurring--desktop.png` — desktop preview for a recurring household event.
- `design/prototype/calendar/handoff/static/event-preview--recurring--compact.png` — compact bottom-sheet preview for a recurring event.
- `design/prototype/calendar/handoff/static/event-preview--private--desktop.png` — desktop preview for a private event with supported details only.
- `design/prototype/calendar/handoff/static/calendar-overflow-dialog--desktop.png` — desktop bounded list of every event hidden by dense-cell overflow.
- `design/prototype/calendar/handoff/static/calendar-overflow-dialog--compact.png` — compact overflow-event list.
- `design/prototype/calendar/handoff/static/event-editor--add--desktop.png` — desktop add-event editor with stable header and actions.
- `design/prototype/calendar/handoff/static/event-editor--add--compact.png` — compact add-event sheet.
- `design/prototype/calendar/handoff/static/event-editor--edit-recurring--desktop.png` — desktop recurring-event editor with mutation scope.
- `design/prototype/calendar/handoff/static/event-editor--edit-recurring--compact.png` — compact recurring-event editor.
- `design/prototype/calendar/handoff/static/delete-event-dialog--recurring--desktop.png` — desktop recurring-event deletion confirmation and scope.
- `design/prototype/calendar/handoff/static/delete-event-dialog--recurring--compact.png` — compact recurring-event deletion confirmation.

## Feedback references

- `design/prototype/calendar/handoff/static/calendar-notice--no-matches.png` — recoverable no-match notice confirming saved data is unchanged.
- `design/prototype/calendar/handoff/static/calendar-toast--event-added.png` — event-added confirmation.
- `design/prototype/calendar/handoff/static/calendar-toast--event-saved.png` — event-saved confirmation.
- `design/prototype/calendar/handoff/static/calendar-toast--event-deleted.png` — event-deleted confirmation.

## Motion references

- `design/prototype/calendar/handoff/recordings/calendar-filter-disclosure--closed-to-open/` — ordered frames for a facet disclosure opening within the filter panel.
- `design/prototype/calendar/handoff/recordings/calendar-filter-drawer--open/` — ordered frames for the compact filter drawer entering from its edge.
- `design/prototype/calendar/handoff/recordings/calendar-view-switch--month-to-day/` — ordered frames for the continuous selected slate moving from Month to Day.

## Behavior and accessibility

- Support Day, Week, Month, and Year with previous, Today, and next navigation. Selecting a Month date opens Day; selecting a Year month opens Month.
- Month always presents the complete six-row grid without an internal vertical drag. Adapt visible event density to available cell height and keep every remaining event reachable through an accurately counted overflow action.
- Compact Month cells retain semantic event buttons even when visible labels collapse to importance dots. Compact Day and Week recompose as readable agendas rather than clipped desktop grids.
- Private and Household are independent native checkbox targets. Selecting both includes all events; selecting neither produces the recoverable no-match state without changing saved data.
- Search matches title and description only. Scope, importance, group, tag, and search filters intersect; selected fixed-width chips must not change intrinsic geometry.
- Keep active filter state with the filter controls. Compact filters use a dismissible drawer with predictable Escape behavior, focus containment, and focus restoration.
- Preview exposes only supported event fields and capability actions. Desktop preview originates near its trigger; compact preview uses the reviewed bottom-sheet composition.
- Create and Edit support title, description, all-day or timed start and end, calendar scope, visibility, importance, group, tags, recurrence, and recurring mutation scope.
- Keep the editor header and actions stable while only the form body scrolls. Cancel and Save must remain reachable at every scroll position and text scale.
- Recurring edits and deletes require explicit occurrence, following, or entire-series scope before commitment. Destructive deletion remains a separate confirmation surface.
- Preserve native grid, button, checkbox, form, dialog, and sheet semantics; visible keyboard focus; screen-reader position and state announcements; predictable dismissal; and platform target sizes.
- Under Reduced Motion, replace drawer travel, disclosure travel, and selected-slate motion with immediate state changes that retain clear selected and open states.

## Exceptions

- Fixture dates and local mutations demonstrate appearance only. Production date identity, time-zone projection, pagination, authorization, persistence, and optimistic revision handling remain owned by current controller and API contracts.
- Time-zone conversion, daylight-saving transitions, all-day end semantics, recurrence expansion, occurrence identity, and revision conflicts require domain-boundary tests rather than prototype-derived behavior.
- Visual calendar scope controls filter authorized data; they never grant access. Authorization must continue to derive from the immutable principal and capability boundary.
- Keyboard grid conventions, screen-reader position announcements, very dense event days, large-data virtualization, and native date/time input presentation require platform verification.
- Chat, composer, navigation, tool activity, assistant actions, reminders, places, conflict checking, and unsupported event fields remain outside this handoff.
