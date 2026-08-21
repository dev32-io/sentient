# iOS calendar semantic state inventory

Compared against:

- `sentient-design/HANDOFF.md`
- `sentient-design/brand-spec.md`
- `sentient-design/design/mobile/calendar.html`
- `sentient-design/components/mobile/sentient-mobile.js`

The adapter intentionally carries semantics only; geometry, colors, and prototype-only fields are excluded.

| Reference seam | Shared/Swift adapter representation |
| --- | --- |
| Day, Week, Month, complete Year | `CalendarUiState.day/week/month/year`; shared `CalendarExperienceProjection` remains authoritative |
| Month selection retained into Day/Week | `selectedDate`, forwarded `SelectDate` and `SelectView` intents |
| Agenda and overflow | shared day/week `agenda`, date-cell indicators and overflow |
| Filters, search, facets | `filters`, `facets`; exact `SetFilters` forwarding |
| Cache-first loading and refresh | independent `loading`, `freshness`, `hasCompleteCache`, retained projection |
| Cached offline / unavailable offline | `offline`, `freshness`, `.unavailableOffline`, mutation availability |
| Empty and read error | `.empty`, `.error`, typed sanitized shared error |
| Preview and editor | shared mutation `preview`, `editor`, draft and target |
| Recurrence scope and confirmation | shared applicable/selected scopes and delete confirmation |
| Conflict and permission failure | shared conflict review and typed mutation error |
| Success/failure acknowledgement | shared mutation outcome and `AcknowledgeOutcome` intent |
| Mutation availability | shared create/edit/delete gates and typed reason |
| Accessibility event/date labels | shared projection labels are exposed unchanged |
| Temporal/action identity | raw `eventId`, `occurrenceId`, offset-bearing `originalStart`, revision, scope and all-day values remain shared values |
