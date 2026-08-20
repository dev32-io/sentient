# Model-friendly calendar behavior

## Context

Defines the clean-cutover calendar contract for the model, REST consumers, and shared web/mobile clients. The contract replaces internal CalendarTime-shaped tool arguments with human-oriented temporal strings, bounds all query work and output, and gives recurring mutations Google-style scope.

## Required Behaviors

- Preserve the names calendar_list, calendar_search, calendar_get, calendar_create, calendar_update, and calendar_delete, together with their existing permission tiers and role gates.
- Accept YYYY, YYYY-MM, YYYY-MM-DD, and offset-bearing RFC 3339 values with minute, second, or fractional-second precision. Normalize from to the earliest represented instant and to to the latest represented instant; date-only interpretation uses the household timezone.
- Default omitted calendar scope to private. Read tools accept private, household, or all; write tools accept only private or household.
- Require calendar_search to carry an explicit bounded from/to range; remove its implicit 0001–9999 search window.
- Bound normalized query range, aggregate occurrences, input string/tag cardinality, and serialized calendar output using operator configuration.
- Return concise sorted occurrence projections sufficient to understand and mutate results, including eventId, occurrenceId, originalStart, recurring, scope, revision, title, and temporal fields.
- Reject a model query that would require pagination or exceed the proactive serialized-size threshold with result_too_large and narrowing guidance; never return a partial first page as though complete. The generic broker result cap remains a final backstop.
- Return stable error codes and direct corrective messages for invalid time, invalid or inverted range, range too wide, invalid scope, unauthorized scope, result too large, recurrence conflict, stale revision, and unavailable occurrence without leaking hidden data.
- Create accepts human-oriented start/end values and structured bounded recurrence. The gateway validates and stores the canonical recurrence representation.
- A this_occurrence update may explicitly set or clear title, description, start, end, visibility, importance, group, and tags. It cannot change calendar scope, recurrence, identities, revisions, or notification policy.
- A this_occurrence delete writes one cancelled exception, removes no adjacent occurrence, and never creates a duplicate EXDATE.
- A this_and_following update atomically truncates the prefix before the selected generated slot, creates a successor event ID beginning at that slot, applies the requested changes, and partitions compatible future exceptions and exclusions.
- For COUNT recurrence, a split partitions generated slots including cancelled or excluded slots. For UNTIL recurrence, the prefix ends at the previous generated slot and the successor retains the original terminal bound.
- A this_and_following delete atomically truncates before the selected slot and creates no successor. Splitting at the first slot behaves as an entire-series mutation instead of persisting an empty prefix.
- An entire_series mutation affects only the selected persisted segment; it does not reach backward across an earlier this_and_following split.
- If a requested recurrence change would orphan or ambiguously remap future exceptions or exclusions, reject the complete mutation with recurrence_conflict and preserve all prior state.
- Apply occurrence overrides before visibility and metadata filtering. An explicitly overridden occurrence visibility may differ from its base event while other occurrences remain governed by their own effective visibility.
- Expose update and delete solely through POST /api/v1/calendar/events/{eventId}/mutations. The command carries operation, calendar scope, mutation scope, optional original start, optional expected revision, and changes for update.
- REST returns bounded deterministic pages with continuation metadata. Tools use the same bounded query behavior but convert pagination/overflow into result_too_large.
- Web and KMP shared clients use the same mutation command and typed result. Existing calendar screens may retain convenience calls that map to entire_series without component changes.
- Use a fresh calendar database for this coordinated branch cutover. Existing calendar data, previous wire contracts, migration behavior, and legacy PATCH/DELETE routes are not preserved.

## Acceptance Criteria

- **AC-001:** Each of the six tools accepts its documented model-oriented shape without exposing internal CalendarTime objects; malformed input returns a stable actionable error.
- **AC-002:** Omitted scope addresses private data, explicit all aggregates only authorized read scopes, and writes cannot target all.
- **AC-003:** Search and list reject absent, invalid, inverted, or over-limit ranges before storage work, and bounded valid queries merge and sort timed and all-day occurrences.
- **AC-004:** Calendar tools proactively reject over-count or over-size results without partial or malformed JSON; REST returns a deterministic page and continuation for the equivalent query.
- **AC-005:** Recurring creation from structured input stores a canonical bounded rule and expands the expected slots in the event timezone.
- **AC-006:** Single-occurrence update supports every allowed event-local field, preserves original occurrence identity, and makes effective search, filters, and role visibility observable only on that occurrence.
- **AC-007:** Single-occurrence delete stores exactly one canonical cancellation and leaves adjacent occurrences unchanged.
- **AC-008:** COUNT- and UNTIL-bounded this_and_following updates split atomically without duplicate or missing generated slots and partition compatible child state by original occurrence key.
- **AC-009:** This-and-following delete preserves earlier occurrences, removes the selected and future portion, and creates no successor.
- **AC-010:** An incompatible recurrence change or induced transaction failure leaves prefix, successor, exceptions, exclusions, and revisions unchanged.
- **AC-011:** A supplied stale revision returns conflict without overwriting a newer mutation and a reread provides the current revision.
- **AC-012:** Household role and visibility rules remain enforced at broker, capability, and store boundaries for tools and REST, including effective occurrence visibility.
- **AC-013:** Tool, REST, web service, and mobile SDK mutation paths share the same command semantics; no calendar screen implementation is required.
- **AC-014:** Calendar content, query text, and mutation payloads never enter gateway or mobile diagnostics; only sanitized structural metadata may be logged.
- **AC-015:** The baseline schema and all clients cut over together on fresh disposable storage; no migration or legacy REST compatibility is delivered.

## Domain Language

- Calendar scope identifies the capability-bound resource: private or household; all is a read-only aggregate selector and never a writable resource.
- Mutation scope identifies which recurring records change: this_occurrence, this_and_following, or entire_series. It is distinct from calendar scope.
- Event ID identifies one persisted event or recurring series segment. A this_and_following split creates a new successor event ID; earlier and successor segments are thereafter independent series.
- Occurrence ID identifies one expanded row. Original start is the stable recurrence-slot identity used to target an occurrence even after its displayed start moves.
- Effective occurrence is the base event plus its sparse occurrence override. Visibility, search, group, tag, and importance filtering operate on this effective value.
- Revision is the event version used for optional optimistic conflict detection.
- Cancelled exception is the canonical representation of a deleted individual occurrence. EXDATE remains a recurrence/import exclusion and cannot coexist with a cancelled exception for the same slot.

## Actors

- Adult using the model, web client, or mobile client
- Child using authorized private and household calendar reads
- Guest subject to existing broker role gates
- The model invoking the six calendar tools
- Web and mobile shared clients using authenticated REST

## Scenarios

- An adult lists a private month using year-month strings and receives sorted timed and all-day occurrences.
- A child reads all authorized scopes and cannot infer an adults-only effective occurrence.
- A model retries a rejected overwide or overlarge query with a narrower range or filters.
- An adult creates a private weekly recurrence without specifying scope or timestamp seconds.
- An adult changes one household occurrence’s content, time, visibility, importance, group, and tags.
- An adult cancels one occurrence while the rest of its series remains visible.
- An adult splits a COUNT or UNTIL series at an original occurrence and receives the successor event ID.
- An adult truncates the selected and future portion of a series.
- Two clients mutate from the same revision; the stale client rereads after conflict.
- Web and mobile shared clients issue the same recurrence command while current screens remain unchanged.

## Edge Cases

- A date or timestamp has omitted day, seconds, or milliseconds.
- A timed recurrence crosses daylight-saving time while retaining its event-timezone wall-clock anchor.
- The split target is moved by an existing exception; original start, not displayed start, selects the generated slot.
- The split target is the first generated slot.
- Cancelled and excluded slots still participate in COUNT partitioning.
- A future exception becomes invalid under a requested successor recurrence rule.
- An occurrence override narrows or broadens visibility relative to its base event, requiring post-override authorization filtering.
- Aggregate private and household results exceed a count or serialized-size bound.
- The same event ID is requested in an unauthorized scope and must remain indistinguishable from not found.

## Out of Scope

- Web, Android, and iOS calendar screen redesign or visual implementation
- design-ref asset implementation
- Scheduler behavior, reminders, notification delivery, and Google Calendar synchronization
- Full RFC 5545 recurrence
- Cross-household identity or storage behavior
- Existing calendar-data migration or preservation
- Backward compatibility for previous calendar REST request or response contracts
